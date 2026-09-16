/**
 * tests/integration.test.js
 * ---------------------------------------------------------------------------
 * arena.ai'ye dokunmadan, TÜM hattı gerçek Chromium ile doğrular:
 *   fake target sunucusu (tests/fakeTargetServer.js) → arenaScraper akışı
 *   → ArtifactCapture (network/DOM) → artifactDelivery (indirme + sha256)
 *
 * Çalıştırma:  npm test
 * Chromium yoksa test otomatik atlanır (npm run browsers:install).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeTarget } from './fakeTargetServer.js';
import { PNG_FIXTURE } from './pngFixture.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-proxy-test-'));
const SESSION_PATH = path.join(TMP, 'session.json');
const ARTIFACT_DIR = path.join(TMP, 'artifacts');
const SHOT_DIR = path.join(TMP, 'shots');

let fake;
let scratch;

function chromiumInstalled() {
  try {
    // playwright kurulu mu + tarayıcı indirilmiş mi (hafif kontrol)
    const base = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache', 'ms-playwright');
    return { ok: fs.existsSync(base), base };
  } catch {
    return { ok: false };
  }
}

test.before(async () => {
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'silent';
  process.env.LOG_PRETTY = 'false';
  process.env.DRY_RUN = 'false';
  process.env.SESSION_MODE = 'storage';
  process.env.SESSION_STATE_PATH = SESSION_PATH;
  process.env.ARTIFACT_LOCAL_DIR = ARTIFACT_DIR;
  process.env.SCREENSHOT_DIR = SHOT_DIR;
  process.env.PROFILE_BASE_DIR = path.join(TMP, 'profiles'); // testler repoya profil bırakmasın
  process.env.ARTIFACT_DELIVERY = 'file';
  process.env.BROWSER_HEADLESS = 'true';
  process.env.MAX_CONTEXTS = '2';
  process.env.QUEUE_CONCURRENCY = '2';
  process.env.HUMANIZE = 'false'; // testleri hızlandır
  process.env.ARTIFACT_PUBLIC_BASE_URL = 'http://127.0.0.1:1';

  fake = await startFakeTarget({ latencyMs: 600, ws: false });
  process.env.TARGET_BASE_URL = fake.baseUrl;
  process.env.TARGET_GENERATE_PATH = '/';
  process.env.ALLOWED_NAV_HOSTS = '';

  // Sahte oturum dosyası (storage mode zorunlu kılıyor)
  fs.writeFileSync(
    SESSION_PATH,
    JSON.stringify({
      cookies: [
        { name: 'session', value: 'fake-session-token', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' },
      ],
      origins: [{ origin: fake.baseUrl, localStorage: [{ name: 'auth', value: 'ok' }] }],
    }),
  );

  // Config ve servisler env'i okuduktan sonra import edilmeli
  scratch = {
    assetService: await import('../src/services/assetService.js'),
    browserManager: (await import('../src/automation/browserManager.js')).browserManager,
    taskQueue: (await import('../src/automation/queue.js')).taskQueue,
    config: (await import('../src/config/index.js')).config,
  };
});

test.after(async () => {
  await scratch?.browserManager?.closeAll().catch(() => {});
  await fake?.close().catch(() => {});
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('uçtan uca: prompt → tıkla → CDN URL yakala → indir → diske yaz', async (t) => {
  const { ok } = chromiumInstalled();
  if (!ok) return t.skip('Chromium indirilmemiş (npm run browsers:install)');

  const result = await scratch.assetService.generateAsset({
    prompt: 'test manzarası, sinematik ışık',
    negative_prompt: 'blur, text',
    aspect_ratio: '16:9',
    style: 'photographic',
  });

  assert.equal(result.success, true);
  assert.equal(result.meta.normalized_params.aspectRatio, '16:9');
  assert.ok(result.image_url, 'image_url dönmedi');
  const details = result.meta ? result : null;
  assert.ok(details);

  // Teslim: file modunda URL /cdn/... veya diske yazılmış dosya olmalı
  assert.equal(result.delivery, 'file');
  assert.ok(result.image_file?.path, 'image_file yok');
  assert.ok(fs.existsSync(result.image_file.path), 'indirilen dosya diskte yok');
  const bytes = fs.readFileSync(result.image_file.path);
  assert.equal(bytes.length, PNG_FIXTURE.length, 'indirilen içerik fixture ile aynı değil');
  assert.equal(result.sha256.length, 64);
  assert.equal(result.bytes, PNG_FIXTURE.length);

  // Adım süreleri ve yakalama kaynağı raporlanmış olmalı
  assert.ok(result.meta.steps.click_generate >= 0);
  assert.ok(result.meta.steps.capture_artifact >= 0);
  assert.ok(String(result.captured_from).startsWith('network'), `beklenmeyen kaynak: ${result.captured_from}`);
  assert.equal(fake.requests(), 1, 'isteğe karşılık bir üretim çağrısı olmalı');

  // Parametrelerin DOM üzerinden platforma GERÇEKTEN ulaştığını doğrula
  const sent = fake.lastRequest();
  assert.deepEqual(
    { prompt: sent.prompt, aspect: sent.aspect_ratio, style: sent.style, negative: sent.negative_prompt },
    { prompt: 'test manzarası, sinematik ışık', aspect: '16:9', style: 'photographic', negative: 'blur, text' },
    'parametreler forma doğru yazılmadı',
  );
});

test('buffer/context havuzu: ikinci istek context yeniden kullanır', async (t) => {
  if (!chromiumInstalled().ok) return t.skip('Chromium indirilmemiş');

  const before = scratch.browserManager.health();
  const result = await scratch.assetService.generateAsset({ prompt: 'ikinci istek', aspect_ratio: '1:1' });
  const after = scratch.browserManager.health();

  assert.equal(result.success, true);
  assert.equal(result.meta.reused_context, true, 'ikinci istek havuzdaki context’i kullanmalıydı');
  assert.equal(after.metrics.contextsCreated, before.metrics.contextsCreated, 'yeni context açılmamalıydı');
});

test('eşzamanlılık: 3 istek kuyrukta hata vermeden işlenir', async (t) => {
  if (!chromiumInstalled().ok) return t.skip('Chromium indirilmemiş');

  const started = Date.now();
  const results = await Promise.all(
    [1, 2, 3].map((i) => scratch.assetService.generateAsset({ prompt: `paralel istek ${i}`, aspect_ratio: '1:1' })),
  );
  const elapsed = Date.now() - started;

  assert.equal(results.filter((r) => r.success).length, 3);
  assert.ok(results.every((r) => r.image_file?.path || r.image_url), 'her istek bir çıktı üretmeli');
  // Concurrency 2 ise 3 iş en azından iki tur sürer (kuyruk gerçekten devrede)
  assert.ok(elapsed >= 1, 'süre ölçülemedi');
  const stats = scratch.assetService.metrics.snapshot();
  assert.ok(stats.requests_success >= 5, `sayaç beklenmedik: ${stats.requests_success}`);
  assert.equal(stats.errors_by_code.VALIDATION_ERROR ?? 0, 0);
});

test('validation: prompt yoksa 400 sınıfı hata', async () => {
  await assert.rejects(
    () => scratch.assetService.generateAsset({ prompt: '   ' }),
    (err) => err.code === 'VALIDATION_ERROR' && err.httpStatus === 400,
  );
});
