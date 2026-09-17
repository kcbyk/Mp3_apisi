/**
 * src/scrapers/directCloudflare.js
 * ---------------------------------------------------------------------------
 * Tarayıcısız görsel sağlayıcısı #3: Cloudflare Workers AI (edge GPU).
 *
 * Neden var?
 *   Ücretsiz katmanın en cömert sürekli kotası: her hesaba GÜNDE 10.000 Neuron
 *   taze kredi (kalıcı, deneme süresi yok, kredi kartı yok).
 *   Canlı doğrulama 2026-09-16: @cf/black-forest-labs/flux-1-schnell 1024×1024
 *   JPEG ~1.4sn (edge GPU!), 580KB, filigransız. 4 adım+4 tile = 57.6 neuron
 *   → günlük ~173 görsel bedava.
 *
 * API şekli:
 *   POST /client/v4/accounts/{ACCOUNT_ID}/ai/run/{MODEL}
 *   Gövde: {prompt, steps(max 8)}  — width/height ve num_steps REDDEDİLİR (400),
 *   çıktı sabit 1024×1024. Yanıt JSON: {success, result:{image:<base64 jpg>}}.
 *   Hata: {errors:[{message, code}]} — kod 5006 = gövde şema hatası.
 *
 * Kota hatası (neuron biterse) HTTP 429/5xx gibi davranır → zincir bir sonraki
 * halkaya düşer (zincir bu dosyayı kullanırken anlamlı).
 */
import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { UpstreamError } from '../errors.js';
import { persistArtifact } from './artifactDelivery.js';
import { buildPrompt } from './directPollinations.js';
import { mimeTespit } from './directOvh.js';

const log = logger.child({ mod: 'cloudflare' });
const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

/**
 * @param {{prompt,aspectRatio?,style?}} params
 * @param {{taskId?,delivery?,signal?,onProgress?,cfgOverride?}} opts
 */
export async function cloudflareGenerate(params, { taskId = 'anon', delivery, signal, onProgress, cfgOverride } = {}) {
  const t0 = Date.now();
  const cfg = cfgOverride || config.cloudflare;
  if (!cfg.token || !cfg.accountId) {
    throw new UpstreamError('CF_API_TOKEN / CF_ACCOUNT_ID tanımsız — cloudflare sağlayıcısı devrede olamaz.', { provider_http: 0 });
  }
  const promptEtkin = buildPrompt(params.prompt, params.style);
  const steps = Math.max(1, Math.min(8, Number(cfg.steps) || 4));
  onProgress?.({ step: 'cloudflare_generate', ms: 0 });

  const endpoint = `${cfg.baseUrl.replace(/\/+$/, '')}/client/v4/accounts/${encodeURIComponent(cfg.accountId)}/ai/run/${encodeURIComponent(cfg.model).replace(/%2F/g, '/')}`;
  const headers = {
    authorization: `Bearer ${cfg.token}`,
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': config.stealth.userAgent,
  };
  const govde = JSON.stringify({ prompt: promptEtkin, steps });

  const zamanAsimi = AbortSignal.timeout(cfg.timeoutMs);
  const sinyal = signal ? AbortSignal.any([signal, zamanAsimi]) : zamanAsimi;

  // İlk halkalardan birindeyiz: hız esas ama geçici hataya tek toleranslı tekrar.
  const DENEME = 2;
  const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
  let response = null;
  for (let deneme = 1; deneme <= DENEME; deneme += 1) {
    try {
      response = await fetch(endpoint, { method: 'POST', signal: sinyal, headers, body: govde });
    } catch (err) {
      if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
        throw new UpstreamError(`Cloudflare ${cfg.timeoutMs}ms içinde yanıt vermedi.`, { provider_http: 0 });
      }
      if (deneme < DENEME) { await bekle(3000); continue; }
      throw new UpstreamError(`Cloudflare'a ulaşılamadı: ${err.message}`, { provider_http: 0 });
    }
    if (response.ok) break;
    const body = await response.text().catch(() => '');
    const gecici = response.status >= 500 || response.status === 429;
    if (gecici && deneme < DENEME) {
      log.warn({ deneme, status: response.status }, 'Cloudflare geçici hata — bir kez daha denenecek');
      response = null;
      await bekle(3000 + Math.random() * 2000);
      continue;
    }
    throw new UpstreamError(`Cloudflare üretimi başarısız (HTTP ${response.status}).`, {
      provider_http: response.status,
      body: body.slice(0, 200),
    });
  }

  let json;
  try { json = await response.json(); } catch {
    throw new UpstreamError('Cloudflare JSON yerine geçersiz yanıt döndürdü.', { provider_http: response.status });
  }
  if (json.success === false) {
    const mesaj = (json.errors || []).map((e) => e.message).join(' | ').slice(0, 200) || 'bilinmeyen hata';
    throw new UpstreamError(`Cloudflare AI hatası: ${mesaj}`, { provider_http: response.status });
  }
  const b64 = (json.result || {}).image;
  const buffer = b64 ? Buffer.from(b64, 'base64') : null;
  if (!buffer || buffer.length < 1024) {
    throw new UpstreamError(`Cloudflare görsel üretemedi (veri ${buffer?.length ?? 0} bayt).`, { provider_http: response.status });
  }
  if (buffer.length > config.artifact.maxDownloadBytes) {
    throw new UpstreamError(`Cloudflare görseli çok büyük (${buffer.length} bayt).`, { code: 'ASSET_TOO_LARGE' });
  }

  const mime = mimeTespit(buffer) || 'image/jpeg';
  const ext = EXT[mime] || '.jpg';
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const ms = Date.now() - t0;
  const width = 1024;
  const height = 1024;
  log.info({ width, height, model: cfg.model, steps, bytes: buffer.length, ms }, 'Cloudflare görseli üretildi');
  onProgress?.({ step: 'cloudflare_generate', ms });

  let mode = ['url', 'base64', 'file', 'both'].includes(delivery) ? delivery : config.artifact.delivery;
  let deliveryNote;
  if (mode === 'url') {
    mode = 'file';
    deliveryNote = 'url→file: Cloudflare yanıtı base64 dönüyor, görsel kalıcı depolandı';
  }
  const out = { delivery: mode, source: 'cloudflare', mime_type: mime, bytes: buffer.length, sha256 };
  const persisted = persistArtifact({ buffer, contentType: mime, sha256, ext }, { taskId });
  out.image_file = { url: persisted.url, path: persisted.path, filename: persisted.filename };
  out.image_url = persisted.url;
  if (mode === 'base64' || mode === 'both') out.image_base64 = buffer.toString('base64');

  return {
    artifact: out,
    meta: {
      provider: 'cloudflare',
      task_id: taskId,
      elapsed_ms: ms,
      endpoint: 'cloudflare-workers-ai',
      model: cfg.model,
      width,
      height,
      seed: null,
      aspect_ratio: params.aspectRatio,
      prompt_chars: promptEtkin.length,
      negative_prompt_ignored: Boolean(params.negativePrompt),
      size_note: params.aspectRatio && params.aspectRatio !== '1:1'
        ? 'Cloudflare flux-1-schnell yalnız 1024x1024 veriyor; istenen orana kırpılma yapılmadı'
        : undefined,
      delivery_note: deliveryNote,
    },
  };
}
