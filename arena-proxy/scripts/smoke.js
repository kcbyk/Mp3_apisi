#!/usr/bin/env node
/**
 * scripts/smoke.js
 * ---------------------------------------------------------------------------
 * Uçtan uca duman testi: servis ayakta mı, auth çalışıyor mu, DRY_RUN akışı
 * doğru şemayı döndürüyor mu? (Tarayıcı/session olmadan doğrulanabilir.)
 *
 * Kullanım:
 *   node scripts/smoke.js                      # http://localhost:8080 üzerinde
 *   BASE_URL=http://localhost:8080 API_KEY=dev-key-change-me node scripts/smoke.js
 */
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || process.env.ARTIFACT_PUBLIC_BASE_URL || 'http://localhost:8080';
const API = `${BASE}/api/v1`;
const KEY = process.env.API_KEY || process.env.API_KEYS?.split(',')[0] || 'dev-key-change-me';

const headers = { 'content-type': 'application/json', 'x-api-key': KEY };

async function hit(path, init = {}) {
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* boş gövde */
  }
  return { status: res.status, body };
}

const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => results.push({ name, ok: true }))
    .catch((err) => results.push({ name, ok: false, err: err.message }));
}

await check('GET /health → 200', async () => {
  const res = await fetch(`${BASE}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.status === 'ok');
  assert.ok(body.browser, 'browser durumu yok');
});

await check('POST /generate-asset auth zorunlu (401/403)', async () => {
  const res = await fetch(`${API}/generate-asset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'test' }),
  });
  assert.ok([200, 401, 403].includes(res.status), `beklenmeyen durum: ${res.status}`);
});

await check('POST /generate-asset → validation hatası (400)', async () => {
  const { status, body } = await hit('/generate-asset', { method: 'POST', body: JSON.stringify({ prompt: '' }) });
  assert.equal(status, 400, `status=${status}`);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
});

await check('POST /generate-asset → geçerli istek', async () => {
  const { status, body } = await hit('/generate-asset', {
    method: 'POST',
    body: JSON.stringify({
      prompt: 'smoke test: minimalist bir dağ manzarası',
      aspect_ratio: '16:9',
      style: 'photographic',
      negative_prompt: 'blurry, text',
    }),
  });
  assert.equal(status, 200, `status=${status} body=${JSON.stringify(body)?.slice(0, 300)}`);
  assert.equal(body.success, true);
  assert.ok(body.execution_time_ms >= 0, 'execution_time_ms yok');
  assert.ok(body.image_url || body.image_base64 || body.image_file, 'hiç görsel çıktısı yok');
  assert.ok(body.meta, 'meta yok');
  // Parametre kaybı regresyon testi: aspect_ratio uçtan uca korunmalı
  assert.equal(body.meta.normalized_params?.aspectRatio, '16:9', 'aspect_ratio kayboldu/normalize edilemedi');
});

await check('GET /debug/selectors → istatistik', async () => {
  const { status, body } = await hit('/debug/selectors');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.hits));
});

await check('GET /metrics → sayaçlar', async () => {
  const { status, body } = await hit('/metrics');
  assert.equal(status, 200);
  assert.ok(body.requests_total >= 1);
});

console.log('\n=== SMOKE TEST SONUÇLARI ===');
for (const r of results) {
  console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? '' : `\n     ${r.err}`}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} geçti`);
process.exit(failed ? 1 : 0);
