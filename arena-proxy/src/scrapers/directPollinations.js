/**
 * src/scrapers/directPollinations.js
 * ---------------------------------------------------------------------------
 * Tarayıcısız görsel sağlayıcısı: Pollinations URL API'si (iki mod).
 *
 *   TOKENLI (seed-tier)  → gen.pollinations.ai/image + "Authorization: Bearer"
 *     • Gerçek modeller: flux.1-schnell, z-image-turbo, seedream-4.5, flux.2-pro...
 *     • 1024px+ çözünürlük, filigransız (nologo= gerçekten çalışır)
 *     • Canlı ölçüm 2026-09-16: ~8sn/1024px, 402 = ücretli model + bakiye yok
 *   ANON (anahtarsız)    → image.pollinations.ai/prompt (legacy)
 *     • Model parametresi görmezden gelinir → hep "sana" 768px + sağ altta filigran
 *     • Paylaşımlı havuzun geçici "300 RPM" 5xx'leri; 3 denemeli backoff burada da işler
 *
 * Not: URL API'sinde negatif prompt param'ı YOK; stil bilgisi prompt'a eklenir.
 * Anahtarlı modda `delivery:'url'` anlamsızlaşır (URL anahtarsız erişilemez) →
 * 'file'a düşürülür: görsel zaten indirilmiştir, diske persist edilir.
 */
import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { UpstreamError } from '../errors.js';
import { persistArtifact } from './artifactDelivery.js';

const log = logger.child({ mod: 'pollinations' });

/**
 * aspect_ratio ("16:9", "1:1", "3:2", "1.5") → piksel boyutu.
 * Toplam piksel ~1M hedeflenir, kenarlar 16'nın katına yuvarlanır, 2048 tavan.
 */
export function aspectToSize(aspectRatio = '1:1') {
  let w = 1, h = 1;
  const m = /^(\d+(?:\.\d+)?)[:x](\d+(?:\.\d+)?)$/.exec(String(aspectRatio).trim());
  if (m) {
    w = Number(m[1]); h = Number(m[2]);
  } else {
    const r = Number(aspectRatio);
    if (Number.isFinite(r) && r > 0) { w = r; h = 1; }
  }
  if (!(w > 0 && h > 0) || w / h > 8 || h / w > 8) { w = 1; h = 1; }
  const oran = w / h;
  let genislik = Math.round(Math.sqrt(1_048_576 * oran) / 16) * 16;
  let yukseklik = Math.round(genislik / oran / 16) * 16;
  genislik = Math.min(Math.max(genislik, 256), 2048);
  yukseklik = Math.min(Math.max(yukseklik, 256), 2048);
  return { width: genislik, height: yukseklik };
}

/** Stil etiketini prompt'a ekler (URL API'sinde ayrı stil parametresi yok) */
export function buildPrompt(prompt, style = '') {
  const p = String(prompt ?? '').trim();
  const s = String(style ?? '').trim();
  return s ? `${p}, ${s}` : p;
}

/**
 * Parametrelerden üretim URL'si kur.
 * Token varsa gen endpoint'i seçilir ve anahtar URL'e YAZILMAZ (Bearer header'a gider).
 * @returns {{url:string, width:number, height:number, seed:number, promptEtkin:string, tokenMode:boolean, endpoint:'gen'|'legacy'}}
 */
export function buildUrl(params, { cfg = config.imageProvider } = {}) {
  const { width, height } = aspectToSize(params.aspectRatio);
  const promptEtkin = buildPrompt(params.prompt, params.style);
  const seed = params.seed ?? Math.floor(Math.random() * 2 ** 31);
  const tokenMode = Boolean(cfg.token);
  const base = (tokenMode ? (cfg.genBaseUrl || cfg.baseUrl) : cfg.baseUrl).replace(/\/+$/, '');
  const q = new URLSearchParams({
    width: String(width),
    height: String(height),
    model: cfg.model, // kanonik id'deki "/" URLSearchParams ile %2F'a kodlanır (gen endpoint kabul ediyor)
    seed: String(seed),
    nologo: 'true',
  });
  const url = `${base}/${encodeURIComponent(promptEtkin)}?${q}`;
  return { url, width, height, seed, promptEtkin, tokenMode, endpoint: tokenMode ? 'gen' : 'legacy' };
}

/**
 * Üretimi yap ve görseli indir; deliverArtifact ile aynı teslim nesnesini döndür.
 *
 * @param {{prompt:string, aspectRatio?:string, style?:string, negativePrompt?:string, seed?:number}} params
 * @param {{taskId?:string, delivery?:string, signal?:AbortSignal, onProgress?:Function}} opts
 */
export async function pollinationsGenerate(params, { taskId = 'anon', delivery, signal, onProgress } = {}) {
  const t0 = Date.now();
  const cfg = config.imageProvider;
  const { url, width, height, seed, promptEtkin, tokenMode, endpoint } = buildUrl(params);
  onProgress?.({ step: 'pollinations_fetch', ms: 0 });

  const headers = { 'user-agent': config.stealth.userAgent, accept: 'image/*,*/*;q=0.8' };
  if (tokenMode) headers.authorization = `Bearer ${cfg.token}`;

  const zamanAsimi = AbortSignal.timeout(cfg.timeoutMs);
  const sinyal = signal
    ? AbortSignal.any([signal, zamanAsimi])
    : zamanAsimi;

  // Anon havuz 5xx'leri + gen endpoint 429'ları geçicidir → backoff ile 3 deneme.
  // 402 (bakiye/paywall) ve diğer 4xx'ler tekrarlanmaz: kalıcı yanıt demektir.
  const DENEME = 3;
  const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
  let response = null;
  for (let deneme = 1; deneme <= DENEME; deneme += 1) {
    try {
      response = await fetch(url, { signal: sinyal, headers });
    } catch (err) {
      if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
        throw new UpstreamError(`Pollinations ${cfg.timeoutMs}ms içinde yanıt vermedi.`, { provider_http: 0 });
      }
      if (deneme < DENEME) {
        log.warn({ deneme, err: String(err.message).slice(0, 120) }, 'ağ hatası — yeniden deneniyor');
        await bekle(4000 * deneme + Math.random() * 2000);
        continue;
      }
      throw new UpstreamError(`Pollinations'a ulaşılamadı: ${err.message}`, { provider_http: 0 });
    }

    if (response.ok) break;
    const body = await response.text().catch(() => '');
    const gecici = response.status >= 500 || response.status === 429;
    if (gecici && deneme < DENEME) {
      log.warn({ deneme, status: response.status, body: body.slice(0, 120) }, 'geçici backend hatası — yeniden deneniyor');
      response = null;
      await bekle(4000 * deneme + Math.random() * 2000);
      continue;
    }
    const not = response.status === 402
      ? ' Bakiye yetersiz: bu model ücretli Pollen ister; enter.pollinations.ai/top-up bakın veya POLLINATIONS_MODEL ucuz bir modele çekin (flux / z-image-turbo).'
      : '';
    throw new UpstreamError(`Pollinations üretimi başarısız (HTTP ${response.status}).${not}`, {
      provider_http: response.status,
      body: body.slice(0, 200),
    });
  }

  const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!contentType.startsWith('image/')) {
    throw new UpstreamError(`Pollinations görsel yerine '${contentType || 'bilinmeyen'}' döndürdü.`, {
      provider_http: response.status,
    });
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 1024) {
    throw new UpstreamError(`Pollinations bozuk/kısa görsel döndürdü (${buffer.length} bayt).`, {
      provider_http: response.status,
    });
  }
  if (buffer.length > config.artifact.maxDownloadBytes) {
    throw new UpstreamError(`Görsel çok büyük (${buffer.length} bayt).`, { code: 'ASSET_TOO_LARGE' });
  }

  const ext = { 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/avif': '.avif' }[contentType] || '.jpg';
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const ms = Date.now() - t0;
  log.info({ endpoint, width, height, model: cfg.model, seed, bytes: buffer.length, ms }, 'görsel üretildi');
  onProgress?.({ step: 'pollinations_fetch', ms });

  // Teslim biçimi — deliverArtifact ile aynı anlambilim.
  // Tokenlı (gen) modda url'nin anahtarsız dışarıdan bir değeri yok → url istense bile persist et.
  let mode = ['url', 'base64', 'file', 'both'].includes(delivery) ? delivery : config.artifact.delivery;
  let deliveryNote;
  if (tokenMode && mode === 'url') {
    mode = 'file';
    deliveryNote = `url→file: anahtarlı endpoint URL'si dışarıdan anahtarsız okunamaz, görsel kalıcı depolandı`;
  }
  const out = {
    delivery: mode,
    source: 'pollinations',
    mime_type: contentType,
    bytes: buffer.length,
    sha256,
  };
  if (mode === 'url') {
    out.image_url = url; // anon mod: CDN'de cache'li kalır; tekrar indirilebilir
  } else {
    const persisted = persistArtifact({ buffer, contentType, sha256, ext }, { taskId });
    out.image_file = { url: persisted.url, path: persisted.path, filename: persisted.filename };
    out.image_url = persisted.url;
    if (mode === 'base64' || mode === 'both') out.image_base64 = buffer.toString('base64');
  }

  return {
    artifact: out,
    meta: {
      provider: 'pollinations',
      task_id: taskId,
      elapsed_ms: ms,
      endpoint,
      model: cfg.model,
      width,
      height,
      seed,
      aspect_ratio: params.aspectRatio,
      prompt_chars: promptEtkin.length,
      negative_prompt_ignored: Boolean(params.negativePrompt),
      delivery_note: deliveryNote,
      final_url: url,
    },
  };
}
