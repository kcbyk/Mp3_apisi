/**
 * Tarayıcısız sağlayıcı testi (Pollinations):
 *  1) aspectToSize: oran → piksel eşlemesi (16:9, 9:16, 1:1, bozuk değer)
 *  2) buildPrompt: stil prompt'a birleşir
 *  3) Sahte Pollinations sunucusuyla uçtan uca: görsel indirilir + persist edilir
 *  4) Sunucu hatası → UpstreamError (UPSTREAM_ERROR)
 *  (Chromium bu testlerde hiç açılmaz; sağlayıcının en büyük kazancı bu)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

// Küçük JPEG imzası taşıyan sahte görsel (gerçek API'nin ürettiği içerik tipi yeterli)
const JPG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
  crypto.randomBytes(2048),
  Buffer.from([0xff, 0xd9]),
]);

// Sahte sunucu: config import edilmeden ÖNCE env'e gerçek adres yazılmalı;
// prompt 'ERR' sunucu hatasını tetikler
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/prompt/ERR')) {
    res.writeHead(503).end('boom');
    return;
  }
  if (req.url.startsWith('/prompt/')) {
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': JPG.length });
    res.end(JPG);
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

process.env.POLLINATIONS_BASE_URL = `http://127.0.0.1:${PORT}/prompt`;
process.env.ARTIFACT_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-art-'));
process.env.IMAGE_PROVIDER = 'pollinations';

const { aspectToSize, buildPrompt, buildUrl, pollinationsGenerate } = await import('../src/scrapers/directPollinations.js');

test.after(() => server.close());

test('aspectToSize eşlemeleri', () => {
  assert.deepEqual(aspectToSize('16:9'), { width: 1360, height: 768 }, '16:9');
  const kare = aspectToSize('1:1');
  assert.equal(kare.width, 1024);
  assert.equal(kare.height, 1024);
  const dikey = aspectToSize('9:16');
  assert.equal(dikey.height, 1360);
  assert.equal(dikey.width, 768);
  assert.deepEqual(aspectToSize('bozuk'), aspectToSize('1:1'), 'bozuk değerde kareye dön');
  assert.deepEqual(aspectToSize('99:1'), aspectToSize('1:1'), 'aşırı oran kareye döner');
});

test('buildPrompt stili birleştirir', () => {
  assert.equal(buildPrompt('kedi', 'sulu boya'), 'kedi, sulu boya');
  assert.equal(buildPrompt('kedi', ''), 'kedi');
  assert.equal(buildPrompt(' kedi ', null), 'kedi');
});

test('buildUrl parametreleri URL\'e işler', () => {
  const { url, width, height } = buildUrl(
    { prompt: 'a cute cat', style: 'oil painting', aspectRatio: '16:9', seed: 42 },
    { cfg: { baseUrl: 'http://x.local/prompt', model: 'flux', token: null } },
  );
  assert.ok(url.startsWith('http://x.local/prompt/a%20cute%20cat%2C%20oil%20painting?'));
  assert.match(url, /model=flux/);
  assert.match(url, /seed=42/);
  assert.match(url, /nologo=true/);
  assert.equal(width, 1360);
  assert.equal(height, 768);
});

test('uçtan uca: sahte sunucudan görsel iner ve persist edilir', async () => {
  const sonuc = await pollinationsGenerate(
    { prompt: 'a cute cat', aspectRatio: '1:1', style: '', negativePrompt: 'çirkin', seed: 7 },
    { taskId: 'test-poll', delivery: 'file' },
  );
  const { artifact, meta } = sonuc;
  assert.equal(meta.provider, 'pollinations');
  assert.equal(meta.negative_prompt_ignored, true);
  assert.equal(artifact.mime_type, 'image/jpeg');
  assert.equal(artifact.bytes, JPG.length);
  assert.equal(artifact.delivery, 'file');
  assert.ok(artifact.image_file?.url?.includes('/files/artifacts/'), 'public url');
  assert.ok(fs.existsSync(artifact.image_file.path), 'dosya diske yazıldı');
  assert.equal(fs.statSync(artifact.image_file.path).size, JPG.length);
});

test('url modu: indirme yapmadan sağlayıcı linkini döner', async () => {
  const { artifact } = await pollinationsGenerate(
    { prompt: 'test', aspectRatio: '1:1', seed: 1 },
    { taskId: 'test-poll-2', delivery: 'url' },
  );
  assert.equal(artifact.delivery, 'url');
  assert.ok(artifact.image_url.startsWith(`http://127.0.0.1:${PORT}/prompt/`));
  assert.equal(artifact.image_file, undefined);
});

test('sunucu hatası → UPSTREAM_ERROR fırlatır', async () => {
  await assert.rejects(
    pollinationsGenerate({ prompt: 'ERR', aspectRatio: '1:1', seed: 1 }, { taskId: 'test-poll-3' }),
    (err) => err.code === 'UPSTREAM_ERROR',
  );
});
