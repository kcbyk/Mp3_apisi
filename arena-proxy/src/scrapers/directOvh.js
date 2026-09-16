/**
 * src/scrapers/directOvh.js
 * ---------------------------------------------------------------------------
 * Tarayıcısız görsel sağlayıcısı #2: OVHcloud AI Endpoints (ücretsiz SDXL).
 *
 * Neden var?
 *   Pollinations seed kotası haftalıktır; dolduğunda ya da hata verdiğinde otomatik
 *   yedeğe ihtiyaç var. OVH: OpenAI-uyumlu POST /v1/images/generations,
 *   anon (anahtarsız) 2 istek/dk, Avrupa sunucusu, kredi kartı yok.
 *   Canlı doğrulama 2026-09-16: SDXL 1024×1024 PNG ~12sn, filigransız, kayıtsız.
 *
 * Yanıt: {data:[{b64_json|url}]}. b64 PNG/JPEG magic-byte ile tanınır.
 * delivery:'url' anlamsızdır (geçici/anon uç) → 'file'a düşürülür.
 */
import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { UpstreamError } from '../errors.js';
import { persistArtifact } from './artifactDelivery.js';
import { aspectToSize, buildPrompt } from './directPollinations.js';

const log = logger.child({ mod: 'ovh' });

/**
 * OVH boyut gerçeği (canlı doğruluk): şema 7 kovayı listeliyor ama servis şu an
 * YALNIZ 1024x1024 kabul ediyor ("Only 1024x1024 size is currently supported").
 * Diğer oranlar ileride açılabilir; o yüzden map fonksiyonu ayrı tutuldu.
 */
export function ovhSize() {
  return { width: 1024, height: 1024 };
}

/** b64/URL'den gelen baytlarda içerik tipi tespiti */
export function mimeTespit(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

/**
 * @param {{prompt,aspectRatio?,style?}} params
 * @param {{taskId?,delivery?,signal?,onProgress?,cfgOverride?}} opts
 */
export async function ovhGenerate(params, { taskId = 'anon', delivery, signal, onProgress, cfgOverride } = {}) {
  const t0 = Date.now();
  const cfg = cfgOverride || config.ovh;
  const promptEtkin = buildPrompt(params.prompt, params.style);
  const { width, height } = ovhSize(params.aspectRatio);
  onProgress?.({ step: 'ovh_generate', ms: 0 });

  const headers = { 'user-agent': config.stealth.userAgent, 'content-type': 'application/json', accept: 'application/json' };
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;

  const zamanAsimi = AbortSignal.timeout(cfg.timeoutMs);
  const sinyal = signal ? AbortSignal.any([signal, zamanAsimi]) : zamanAsimi;

  const govde = JSON.stringify({ model: cfg.model, prompt: promptEtkin, n: 1, size: `${width}x${height}` });
  const endpoint = `${cfg.baseUrl.replace(/\/+$/, '')}/v1/images/generations`;

  const DENEME = 2; // yedek hattıyız; asıl sabır ilk sağlayıcıda
  const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
  let response = null;
  for (let deneme = 1; deneme <= DENEME; deneme += 1) {
    try {
      response = await fetch(endpoint, { method: 'POST', signal: sinyal, headers, body: govde });
    } catch (err) {
      if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
        throw new UpstreamError(`OVH ${cfg.timeoutMs}ms içinde yanıt vermedi.`, { provider_http: 0 });
      }
      if (deneme < DENEME) { await bekle(6000); continue; }
      throw new UpstreamError(`OVH'a ulaşılamadı: ${err.message}`, { provider_http: 0 });
    }
    if (response.ok) break;
    const body = await response.text().catch(() => '');
    const gecici = response.status >= 500 || response.status === 429;
    if (gecici && deneme < DENEME) {
      log.warn({ deneme, status: response.status }, 'OVH geçici hata — bir kez daha denenecek');
      response = null;
      await bekle(6000 + Math.random() * 2000);
      continue;
    }
    throw new UpstreamError(`OVH üretimi başarısız (HTTP ${response.status}).`, {
      provider_http: response.status,
      body: body.slice(0, 200),
    });
  }

  let json;
  try { json = await response.json(); } catch {
    throw new UpstreamError('OVH JSON yerine geçersiz yanıt döndürdü.', { provider_http: response.status });
  }
  const item = (json.data || [])[0] || {};
  let buffer = null;
  if (item.b64_json) {
    buffer = Buffer.from(item.b64_json, 'base64');
  } else if (item.url) {
    const dres = await fetch(item.url, { signal: sinyal }).catch(() => null);
    if (dres?.ok) buffer = Buffer.from(await dres.arrayBuffer());
  }
  if (!buffer || buffer.length < 1024) {
    throw new UpstreamError(`OVH görsel üretemedi (veri ${buffer?.length ?? 0} bayt).`, { provider_http: response.status });
  }
  if (buffer.length > config.artifact.maxDownloadBytes) {
    throw new UpstreamError(`OVH görseli çok büyük (${buffer.length} bayt).`, { code: 'ASSET_TOO_LARGE' });
  }

  const mime = mimeTespit(buffer) || 'image/png';
  const ext = EXT[mime] || '.png';
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const ms = Date.now() - t0;
  log.info({ width, height, model: cfg.model, bytes: buffer.length, ms }, 'OVH görseli üretildi');
  onProgress?.({ step: 'ovh_generate', ms });

  let mode = ['url', 'base64', 'file', 'both'].includes(delivery) ? delivery : config.artifact.delivery;
  let deliveryNote;
  if (mode === 'url') {
    mode = 'file';
    deliveryNote = 'url→file: OVH kalıcı görsel URL\'si vermez, görsel kalıcı depolandı';
  }
  const out = { delivery: mode, source: 'ovh', mime_type: mime, bytes: buffer.length, sha256 };
  const persisted = persistArtifact({ buffer, contentType: mime, sha256, ext }, { taskId });
  out.image_file = { url: persisted.url, path: persisted.path, filename: persisted.filename };
  out.image_url = persisted.url;
  if (mode === 'base64' || mode === 'both') out.image_base64 = buffer.toString('base64');

  return {
    artifact: out,
    meta: {
      provider: 'ovh',
      task_id: taskId,
      elapsed_ms: ms,
      endpoint: 'ovh-ai-endpoints',
      model: cfg.model,
      width,
      height,
      seed: null,
      aspect_ratio: params.aspectRatio,
      prompt_chars: promptEtkin.length,
      negative_prompt_ignored: Boolean(params.negativePrompt),
      size_note: params.aspectRatio && params.aspectRatio !== '1:1'
        ? 'OVH şu an yalnız 1024x1024 veriyor; istenen orana kırpılma yapılmadı'
        : undefined,
      delivery_note: deliveryNote,
    },
  };
}
