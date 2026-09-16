/**
 * Tokenlı (seed-tier) mod testleri:
 *  1) buildUrl: token modda gen endpoint seçilir, anahtar URL'e yazılmaz (Bearer'a gider),
 *     kanonik model id'sindeki "/" %2F olarak kodlanır
 *  2) e2e: Authorization: Bearer başlığı gerçekten gönderilir; delivery:'url' istense bile
 *     'file'a düşürülür ve meta.delivery_note doldurulur; final_url anahtar içermez
 *  3) 402 (bakiye/paywall) → TEKRAR DENEMEDEN UPSTREAM_ERROR (isteğin 1 kez gittiği sayılır)
 *  4) 429 (rate limit) → backoff ile tekrar denenir ve başarılı olur
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const JPG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
  crypto.randomBytes(2048),
  Buffer.from([0xff, 0xd9]),
]);

const gorulen = { auth: [], paths: {}, sayac: {} };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  gorulen.auth.push(req.headers.authorization || null);
  gorulen.paths[u.pathname] = u.search;
  const prompt = u.pathname.slice('/image/'.length);
  gorulen.sayac[prompt] = (gorulen.sayac[prompt] || 0) + 1;

  if (prompt.startsWith('PAYWALL')) {
    res.writeHead(402, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'Insufficient balance', code: 'INSUFFICIENT_BALANCE' } }));
  }
  if (prompt.startsWith('RATELIMIT') && gorulen.sayac[prompt] === 1) {
    res.writeHead(429, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'rate limit' }));
  }
  if (prompt.startsWith('OK') || prompt.startsWith('RATELIMIT')) {
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': JPG.length });
    return res.end(JPG);
  }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

process.env.IMAGE_PROVIDER = 'pollinations';
process.env.POLLINATIONS_TOKEN = 'sk-test-123';
process.env.POLLINATIONS_GEN_BASE_URL = `http://127.0.0.1:${PORT}/image`;
process.env.POLLINATIONS_MODEL = 'black-forest-labs/flux.1-schnell';
process.env.ARTIFACT_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-tok-'));

const { buildUrl, pollinationsGenerate } = await import('../src/scrapers/directPollinations.js');
const { config } = await import('../src/config/index.js');

test.after(() => server.close());

test('buildUrl token modunda gen endpoint + anahtar URL dışında + %2F model', () => {
  const r = buildUrl({ prompt: 'kedi', aspectRatio: '1:1', seed: 5 });
  assert.equal(r.endpoint, 'gen');
  assert.equal(r.tokenMode, true);
  assert.ok(r.url.startsWith(`http://127.0.0.1:${PORT}/image/`));
  assert.ok(!r.url.includes('sk-test-123'), 'anahtar URL içinde olmamalı');
  assert.ok(!r.url.includes('token='), 'token query param olmamalı');
  assert.match(r.url, /model=black-forest-labs%2Fflux\.1-schnell/, 'model slash kodlanmış olmalı');
});

test('e2e: Bearer gönderilir, url isteği file\'a düşer, anahtar sızması yok', async () => {
  gorulen.auth.length = 0;
  const { artifact, meta } = await pollinationsGenerate(
    { prompt: 'OK-kedi', aspectRatio: '1:1', seed: 9 },
    { taskId: 'tok-1', delivery: 'url' },
  );
  assert.equal(gorulen.auth[0], 'Bearer sk-test-123', 'Authorization başlığı');
  assert.equal(artifact.delivery, 'file', 'url → file düşüşü');
  assert.ok(meta.delivery_note?.includes('url→file'));
  assert.ok(!meta.final_url.includes('sk-test-123'));
  assert.ok(fs.existsSync(artifact.image_file.path));
  assert.equal(meta.endpoint, 'gen');
});

test('402: tekrar denenmez, anlaşılır mesaj', async () => {
  await assert.rejects(
    pollinationsGenerate({ prompt: 'PAYWALL-x', aspectRatio: '1:1', seed: 1 }, { taskId: 'tok-2' }),
    (err) => err.code === 'UPSTREAM_ERROR' && /Bakiye yetersiz/.test(err.message) && err.details?.provider_http === 402,
  );
  assert.equal(gorulen.sayac['PAYWALL-x'], 1, '402 retry edilmemeli');
});

test('429: backoff ile tekrar denenir ve başarılır', async () => {
  const { artifact } = await pollinationsGenerate(
    { prompt: 'RATELIMIT-x', aspectRatio: '1:1', seed: 1 },
    { taskId: 'tok-3', delivery: 'file' },
  );
  assert.equal(gorulen.sayac['RATELIMIT-x'], 2, 'bir 429 + başarı = 2 istek');
  assert.equal(artifact.mime_type, 'image/jpeg');
  assert.deepEqual(gorulen.auth.slice(-2), ['Bearer sk-test-123', 'Bearer sk-test-123']);
});
