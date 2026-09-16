/**
 * tests/fakeTargetServer.js
 * ---------------------------------------------------------------------------
 * Hedef platformu taklit eden yerel test sunucusu (arena.ai'ye dokunmadan
 * scraper'ın tüm akışını doğrulamak için). Şunları simüle eder:
 *   • prompt textarea + generate butonu (data-testid'ler selectors/arena.json ile eşleşir)
 *   • butona basınca 1.2 sn "üretim" + API'ye POST (JSON'da asset URL'i döner)
 *   • sonuç görselini /cdn/... yolundan servis eder (S3/CDN taklidi)
 *   • isteğe bağlı: login wall / consent banner / watchdog senaryoları query ile açılır
 *
 * Kullanım (test içinden): const { start } = await import('./fakeTargetServer.js')
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { PNG_FIXTURE } from './pngFixture.js';

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.svg': 'image/svg+xml',
};

const PAGE = (opts) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Fake Studio</title>
<style>body{font-family:sans-serif;background:#0b1020;color:#e2e8f0;padding:24px}
textarea,select,button{font-size:14px;padding:8px}
#results{display:flex;gap:12px;margin-top:16px}#results img{width:320px;border-radius:8px}
.hidden{display:none}</style></head>
<body>
<header><h1>Fake Studio</h1>${opts.loginWall ? '<button id="login">Sign in</button>' : ''}</header>
${opts.consent ? '<div role="dialog"><button id="cookie-accept">Accept all</button></div>' : ''}
<main>
  <form id="form" onsubmit="return false">
    <textarea data-testid="prompt-input" placeholder="Describe the image you want"></textarea>
    <div><button id="adv">Advanced</button></div>
    <div id="advanced" class="hidden">
      <textarea data-testid="negative-prompt-input" placeholder="Negative prompt"></textarea>
    </div>
    <select data-testid="aspect-ratio-select" name="aspect_ratio">
      <option value="1:1">1:1</option><option value="16:9">16:9</option>
      <option value="9:16">9:16</option><option value="4:3">4:3</option>
    </select>
    <select data-testid="style-select" name="style">
      <option value="">None</option><option value="cinematic">Cinematic</option>
      <option value="photographic">Photographic</option>
    </select>
    <button data-testid="generate-button" type="button" ${opts.disabledButton ? 'disabled' : ''}>Generate</button>
  </form>
  <div data-testid="generation-result" id="results"></div>
</main>
<script>
  const $ = (s) => document.querySelector(s);
  $('#adv').addEventListener('click', () => $('#advanced').classList.remove('hidden'));
  const cookieBtn = document.getElementById('cookie-accept');
  if (cookieBtn) cookieBtn.addEventListener('click', () => cookieBtn.closest('[role=dialog]').remove());
  if (${opts.disabledButton}) { // prompt girilince buton aktifleşsin (gerçek SPA davranışı)
    const t = $('[data-testid=prompt-input]');
    t.addEventListener('input', () => { $('[data-testid=generate-button]').disabled = t.value.length < 3; });
  }
  $('[data-testid=generate-button]').addEventListener('click', async () => {
    $('#results').innerHTML = '<div data-testid="generating" role="progressbar">Generating…</div>';
    const payload = {
      prompt: $('[data-testid=prompt-input]').value,
      negative_prompt: $('[data-testid=negative-prompt-input]')?.value ?? '',
      aspect_ratio: $('[data-testid=aspect-ratio-select]').value,
      style: $('[data-testid=style-select]').value,
    };
    await new Promise(r => setTimeout(r, ${opts.latencyMs ?? 1200}));
    const res = await fetch('/api/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    const data = await res.json();
    $('#results').innerHTML =
      '<img alt="generated" width="1024" height="1024" src="' + data.asset.url + '">' +
      (data.asset.download ? '<a download href="' + data.asset.url + '">Download</a>' : '');
  });
  ${opts.ws ? `
  const ws = new WebSocket('ws://127.0.0.1:' + location.port + '/ws');
  ws.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.type === 'asset') $('#results').innerHTML = '<img alt="generated" width="1024" height="1024" src="' + data.url + '">';
  };
  $('[data-testid=generate-button]').addEventListener('click', () => ws.send(JSON.stringify({action:'generate'})));
  ` : ''}
</script>
</body></html>`;

export async function startFakeTarget(opts = {}) {
  const assets = new Map();
  const received = [];
  let counter = 0;

  // Platformun "ürettiği" görsel: opts.assetFile verilirse o dosya servis edilir
  // (demo/gerçekçi senaryolar), aksi halde 8x8 PNG fixture kullanılır.
  const assetBytes = opts.assetFile ? fs.readFileSync(opts.assetFile) : PNG_FIXTURE;
  const assetExt = opts.assetFile ? path.extname(opts.assetFile).toLowerCase() : '.png';
  const assetMime = MIME[assetExt] ?? 'image/png';

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/healthz') {
      res.writeHead(200).end('ok');
      return;
    }

    if (url.pathname.startsWith('/cdn/')) {
      const asset = assets.get(url.pathname);
      if (!asset) return res.writeHead(404).end('not found');
      res.writeHead(200, {
        'content-type': assetMime,
        'content-length': asset.length,
        'cache-control': 'public, max-age=31536000',
      }).end(asset);
      return;
    }

    if (url.pathname === '/api/generate' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        counter += 1;
        const id = `asset-${Date.now()}-${counter}`;
        const assetPath = `/cdn/${id}${assetExt}?w=1792&h=1008&sig=fake`;
        assets.set(`/cdn/${id}${assetExt}`, assetBytes);
        const parsed = JSON.parse(body || '{}');
        received.push(parsed); // platforma gerçekten ne gitti? (parametre kaybı regresyonu için)
        const payload = {
          ok: true,
          request: parsed,
          asset: { id, url: assetPath, width: 1792, height: 1008, download: opts.downloadLink !== false },
        };
        if (opts.ws) broadcast(JSON.stringify({ type: 'asset', url: assetPath }));
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
      });
      return;
    }

    // API'yi JSON dışında bir yola da koy: gömülü URL'leri JSON taraması yakalar
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE(opts));
  });

  /* ---- minimal WebSocket sunucusu (harici bağımlılık olmadan) ---- */
  const clients = new Set();
  server.on('upgrade', (req, socket) => {
    if (!req.url.startsWith('/ws')) return socket.destroy();
    const key = req.headers['sec-websocket-key'];
    const accept = require_crypto(key);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
  });

  function broadcast(payload) {
    const frame = encodeWsFrame(payload);
    for (const s of clients) {
      try {
        s.write(frame);
      } catch {
        clients.delete(s);
      }
    }
  }

  await new Promise((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    requests: () => counter,
    /** Platformun (DOM formundan) aldığı son üretim isteği gövdesi */
    lastRequest: () => received.at(-1) ?? null,
    allRequests: () => [...received],
    close: () =>
      new Promise((resolve) => {
        for (const s of clients) s.destroy();
        server.close(resolve);
      }),
  };
}

/* ----------------------------- yardımcılar ------------------------------- */
import crypto from 'node:crypto';
function require_crypto(key) {
  return crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
}

function encodeWsFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}
