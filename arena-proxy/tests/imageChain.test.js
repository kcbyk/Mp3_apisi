/**
 * "auto" zinciri + OVH sağlayıcısı testleri (üç sahte sunuculu):
 *  1) zincir kurulumu: token varken pollinations→ovh→anon; token yokken ovh→anon
 *  2) auto: ana sağlayıcı 402 → OVH PNG (b64) kazanır, fallback_attempts kayıtlı
 *  3) auto: TÜM halkalar düşerse son hata fırlatılır ve details.chain 3 giriş taşır
 *  4) ovhGenerate: PNG magic-byte tespiti, delivery:'url' → file düşüşü, meta
 *  (Hiçbir yerde Chromium yok; gerçek ağa da çıkılmaz)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  crypto.randomBytes(4096),
]);
const JPG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
  crypto.randomBytes(4096),
  Buffer.from([0xff, 0xd9]),
]);

// 1) gen endpoint (ana): HER ZAMAN 402 (kota/bakiye bitti senaryosu)
const genServer = http.createServer((req, res) => {
  res.writeHead(402, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Insufficient balance', code: 'INSUFFICIENT_BALANCE' } }));
});
// 2) OVH: POST /v1/images/generations → b64 PNG; prompt 'FAIL' → 500
const ovhState = { sonIstek: null, sayac: 0 };
const ovhServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    ovhState.sayac += 1;
    ovhState.sonIstek = body;
    const parsed = JSON.parse(body);
    if (String(parsed.prompt).startsWith('FAIL')) {
      res.writeHead(500).end('ovh boom');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }));
  });
});
// 3) anon pollinations legacy: prompt 'FAIL' → 503, yoksa JPG
const anonServer = http.createServer((req, res) => {
  if (req.url.startsWith('/prompt/FAIL')) { res.writeHead(503).end('boom'); return; }
  if (req.url.startsWith('/prompt/')) {
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': JPG.length });
    return res.end(JPG);
  }
  res.writeHead(404).end();
});
for (const s of [genServer, ovhServer, anonServer]) await new Promise((r) => s.listen(0, '127.0.0.1', r));
const gcik = (s) => `http://127.0.0.1:${s.address().port}`;

process.env.IMAGE_PROVIDER = 'auto';
process.env.POLLINATIONS_TOKEN = 'sk-test-zincir';
process.env.POLLINATIONS_GEN_BASE_URL = `${gcik(genServer)}/image`;
process.env.POLLINATIONS_BASE_URL = `${gcik(anonServer)}/prompt`;
process.env.OVH_BASE_URL = gcik(ovhServer);
process.env.ARTIFACT_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-art-'));

const { zincirKur, runImageChain } = await import('../src/services/imageChain.js');
const { ovhGenerate, mimeTespit } = await import('../src/scrapers/directOvh.js');

test.after(() => { genServer.close(); ovhServer.close(); anonServer.close(); });

test('zincir sırası: anahtarlı → pollinations, ovh, anon', () => {
  const z = zincirKur().map((a) => a.name);
  assert.deepEqual(z, ['pollinations', 'ovh', 'pollinations-anon']);
});

test('mimeTespit: PNG/JPEG imzaları', () => {
  assert.equal(mimeTespit(PNG), 'image/png');
  assert.equal(mimeTespit(JPG), 'image/jpeg');
  assert.equal(mimeTespit(Buffer.from([0, 1, 2])), null);
});

test('auto: pollinations 402 → OVH kazanır + fallback izleri', async () => {
  const { artifact, meta } = await runImageChain(
    { prompt: 'uzayda kahve içen kedi', aspectRatio: '1:1', seed: 1 },
    { taskId: 'chain-1', delivery: 'url' },
  );
  assert.equal(meta.provider, 'ovh');
  assert.ok(Array.isArray(meta.fallback_attempts), 'zincir izi yok!');
  assert.equal(meta.fallback_attempts.length, 2); // 1 hata + 1 başarı
  assert.equal(meta.fallback_attempts[0].provider, 'pollinations');
  assert.equal(meta.fallback_attempts[0].ok, false);
  assert.equal(meta.fallback_attempts[0].http, 402);
  assert.equal(meta.fallback_attempts[1].provider, 'ovh');
  assert.equal(meta.fallback_attempts[1].ok, true);
  assert.equal(artifact.mime_type, 'image/png');
  assert.equal(artifact.delivery, 'file', 'url → file düşüşü');
  assert.ok(fs.existsSync(artifact.image_file.path));
  // OpenAI tarzı gövde gerçekten istenen formatta gitti mi?
  const govde = JSON.parse(ovhState.sonIstek);
  assert.equal(govde.model, 'stable-diffusion-xl-base-v10');
  assert.equal(govde.size, '1024x1024');
  assert.ok(govde.prompt.includes('uzayda kahve içen kedi'));
});

test('auto: tüm halkalar düşerse son hata + chain özeti', async () => {
  await assert.rejects(
    runImageChain({ prompt: 'FAIL-x', aspectRatio: '1:1', seed: 1 }, { taskId: 'chain-2' }),
    (err) => err.code === 'UPSTREAM_ERROR' && Array.isArray(err.details?.chain),
  );
});

test('ovhGenerate doğrudan: PNG çöz + persist + meta', async () => {
  const { artifact, meta } = await ovhGenerate(
    { prompt: 'minimal poster, kahve fincanı', aspectRatio: '16:9', style: 'flat design' },
    { taskId: 'ovh-1', delivery: 'both' },
  );
  assert.equal(meta.provider, 'ovh');
  assert.equal(meta.endpoint, 'ovh-ai-endpoints');
  assert.equal(artifact.mime_type, 'image/png');
  assert.ok(artifact.image_base64 && artifact.image_file);
  assert.equal(meta.negative_prompt_ignored, false);
  // OVH canlı gerçeği: yalnız 1024x1024 + 16:9 için size_note düşülmeli
  const govde = JSON.parse(ovhState.sonIstek);
  assert.equal(govde.size, '1024x1024', `beklenmedik boyut: ${govde.size}`);
  assert.equal(meta.width, 1024);
  assert.ok(meta.size_note?.includes('1024x1024'));
});
