/**
 * Süre tutarlılığı testi (2026-09-16 Azure canlı hatasına regresyon):
 *  1) Tutarsız kombinasyon (300sn iş / 3 deneme / 240sn üretim) → uyarı ÜRETİLİR
 *  2) Tutarlı kombinasyon (25dk iş / 2 deneme / 20dk üretim)   → uyarı YOK
 *  3) Yeni varsayılanlar env'siz de tutarlı (sanal Azure: env unutulsa bile çalışsın)
 *  4) Kalan süre tam denemeyi karşılamıyorsa retry BAŞLAMAZ (doomed-retry skip)
 *     → tarayıcı context'i boşa yakılmaz, son hata dürüstçe döner.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { timeoutCoherenceWarnings, config } = await import('../src/config/index.js');
const { TaskQueue } = await import('../src/automation/queue.js');
const { ArtifactNotFoundError } = await import('../src/errors.js');

test('tutarsız sürelerde uyarı üretir (Azure canlı vakası)', () => {
  const w = timeoutCoherenceWarnings(300_000, {
    attempts: 3,
    generationTimeoutMs: 240_000,
    attemptOverheadMs: 30_000,
  });
  assert.equal(w.length, 1);
  assert.match(w[0], /JOB_TIMEOUT_MS/);
  assert.match(w[0], /RETRY_ATTEMPTS/);
});

test('tutarlı sürelerde sessiz kalır', () => {
  const w = timeoutCoherenceWarnings(1_500_000, {
    attempts: 2,
    generationTimeoutMs: 1_200_000,
    attemptOverheadMs: 30_000,
  });
  assert.deepEqual(w, []);
});

test('env olmadan code-defaults tutarlı (önerilen değerler)', () => {
  // Varsayılanlar: 25dk iş / 20dk üretim / 2 retry (3 deneme)
  // → 1230sn + 2 × 120sn hızlı-hata payı = 1470sn ≤ 1500sn ✓
  const w = timeoutCoherenceWarnings(config.queue.jobTimeoutMs, {
    attempts: config.retry.attempts + 1,
    generationTimeoutMs: config.target.generationTimeoutMs,
  });
  assert.deepEqual(w, []);
});

test('kalan süre yetmeyince retry başlatılmaz (doomed-retry skip)', async () => {
  const q = new TaskQueue();
  let cagri = 0;
  const t0 = Date.now();
  // Her denemede anında ARTIFACT_NOT_FOUND fırlat; timeout 5sn, 3 deneme hakkı.
  // perAttempt bütçesi (varsayılan ~1230sn) >>> 5sn → 2. deneme asla başlamamalı.
  await assert.rejects(
    q.run(
      async () => {
        cagri += 1;
        throw new ArtifactNotFoundError('bos');
      },
      { taskId: 'test-doomed-skip', timeoutMs: 5_000, attempts: 3 },
    ),
    (err) => err.code === 'ARTIFACT_NOT_FOUND',
  );
  assert.equal(cagri, 1, '2. ve 3. denemeler hiç çalışmamalı');
  const gecen = Date.now() - t0;
  // Backoff (~1-2sn) + hızlı skip → toplamda işin kendi 5sn'lik
  // ölüm süresinden ÖNCE, temiz biçimde dönmeli.
  assert.ok(gecen < 4_500, `çok uzun sürdü: ${gecen}ms (tam boy deneme başlamış olabilir)`);
});
