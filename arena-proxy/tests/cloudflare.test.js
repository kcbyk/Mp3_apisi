/**
 * tests/cloudflare.test.js — Cloudflare Workers AI sağlayıcısı birim testleri.
 * Sahte CF REST sunucusuyla (gerçek ağ yok) yanıt ayrıştırma + hata davranışı + zincir konumu.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';

process.env.POLLINATIONS_TOKEN ||= 'test-token-x';
process.env.CF_API_TOKEN ||= 'cf-test-token';
process.env.CF_ACCOUNT_ID ||= 'acc12345';

const { cloudflareGenerate } = await import('../src/scrapers/directCloudflare.js');
const { zincirKur } = await import('../src/services/imageChain.js');
const { config } = await import('../src/config/index.js');

function fakeJpeg() {
  // 2KB+ gerçekçi JPEG büyülü baytı
  const b = Buffer.alloc(4096, 7);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff;
  return b;
}

async function sahteSunucu(handler) {
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, port: srv.address().port };
}

test('başarı: JSON {result:{image}} → buffer, meta.provider=cloudflare', async () => {
  const img = fakeJpeg();
  let istekGovde = null;
  const { srv, port } = await sahteSunucu((req, res) => {
    let g = '';
    req.on('data', (c) => { g += c; });
    req.on('end', () => {
      istekGovde = JSON.parse(g);
      assert.equal(req.headers.authorization, 'Bearer cf-test-token');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, result: { image: img.toString('base64') } }));
    });
  });
  try {
    const cfg = { baseUrl: `http://127.0.0.1:${port}`, accountId: 'acc12345', token: 'cf-test-token', model: '@cf/test/flux', steps: 4, timeoutMs: 5000 };
    const pkg = await cloudflareGenerate({ prompt: 'kedi', aspectRatio: '1:1' }, { taskId: 't-cf-1', delivery: 'file', cfgOverride: cfg });
    assert.equal(pkg.meta.provider, 'cloudflare');
    assert.equal(pkg.meta.width, 1024);
    assert.equal(pkg.artifact.source, 'cloudflare');
    assert.equal(pkg.artifact.mime_type, 'image/jpeg');
    assert.equal(pkg.artifact.bytes, img.length);
    assert.equal(istekGovde.steps, 4);
    assert.ok(!('width' in istekGovde) && !('height' in istekGovde), 'width/height gönderilmemeli (CF 400 veriyor)');
    assert.equal(istekGovde.prompt, 'kedi');
    // sha256 doğruluğu
    const sha = crypto.createHash('sha256').update(img).digest('hex');
    assert.equal(pkg.artifact.sha256, sha);
  } finally { srv.close(); }
});

test('oran != 1:1 → meta.size_note görünür', async () => {
  const img = fakeJpeg();
  const { srv, port } = await sahteSunucu((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: true, result: { image: img.toString('base64') } }));
  });
  try {
    const cfg = { baseUrl: `http://127.0.0.1:${port}`, accountId: 'a', token: 't', model: 'm', steps: 4, timeoutMs: 5000 };
    const pkg = await cloudflareGenerate({ prompt: 'kedi', aspectRatio: '16:9' }, { taskId: 't-cf-2', delivery: 'file', cfgOverride: cfg });
    assert.ok(pkg.meta.size_note && pkg.meta.size_note.includes('1024x1024'));
  } finally { srv.close(); }
});

test('envs eksikse net UpstreamError (zincirdeyse düşsün diye)', async () => {
  const cfg = { baseUrl: 'http://127.0.0.1:9', accountId: null, token: null, model: 'm', steps: 4, timeoutMs: 1000 };
  await assert.rejects(
    () => cloudflareGenerate({ prompt: 'x' }, { delivery: 'file', cfgOverride: cfg }),
    /CF_API_TOKEN/,
  );
});

test('success:false → UpstreamError + hata mesajı taşınır', async () => {
  const { srv, port } = await sahteSunucu((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: false, errors: [{ message: 'quota exceeded', code: 3040 }] }));
  });
  try {
    const cfg = { baseUrl: `http://127.0.0.1:${port}`, accountId: 'a', token: 't', model: 'm', steps: 4, timeoutMs: 5000 };
    await assert.rejects(
      () => cloudflareGenerate({ prompt: 'x' }, { delivery: 'file', cfgOverride: cfg }),
      /quota exceeded/,
    );
  } finally { srv.close(); }
});

test('zincir kurulumu: CF envs varken sıra pollinations→cloudflare→ovh→anon', () => {
  const siradakiler = zincirKur().map((n) => n.name);
  assert.deepEqual(siradakiler, ['pollinations', 'cloudflare', 'ovh', 'pollinations-anon']);
});

test('config.cloudflare alanları env’den doluyor', () => {
  assert.equal(config.cloudflare.token, 'cf-test-token');
  assert.equal(config.cloudflare.accountId, 'acc12345');
  assert.ok(config.cloudflare.steps >= 1 && config.cloudflare.steps <= 8);
});
