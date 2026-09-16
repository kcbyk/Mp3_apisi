/**
 * src/scrapers/artifactDelivery.js
 * ---------------------------------------------------------------------------
 * Yakalanan asset URL'ini istemciye uygun çıktı biçimine dönüştürür.
 *
 *   ARTIFACT_DELIVERY=url     → yalnızca CDN/S3 linki (en hızlı; link expire edebilir)
 *   ARTIFACT_DELIVERY=base64  → görseli indirip base64 gömer (payload büyür, kalıcıdır)
 *   ARTIFACT_DELIVERY=file    → diske yazıp servisin kendi public URL'ini döner
 *   ARTIFACT_DELIVERY=both    → url + file + base64 bilgileri
 *
 * Güvenlik: indirme yalnızca allowlist'teki host'lardan yapılır (SSRF koruması),
 * boyut sınırı vardır ve 3xx yönlendirmeleri manuel takip edilerek her hop
 * tekrar doğrulanır.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT_DIR } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { AppError, UpstreamError } from '../errors.js';
import { ArtifactCapture } from './artifactCapture.js';

const log = logger.child({ mod: 'delivery' });

const DEFAULT_ASSET_HOST_SUFFIXES = [
  'amazonaws.com',
  'cloudfront.net',
  'googleusercontent.com',
  'storage.googleapis.com',
  'blob.core.windows.net',
  'cloudinary.com',
  'imgix.net',
  'r2.dev',
  'digitaloceanspaces.com',
  'backblazeb2.com',
  'supabase.co',
  'r2.cloudflarestorage.com',
  'cloudflarestorage.com',
];

function hostAllowed(hostname) {
  const allow = config.artifact.allowedAssetHosts.map((h) => h.trim().toLowerCase()).filter(Boolean);
  const targetHost = new URL(config.target.baseUrl).hostname.toLowerCase();
  const h = hostname.toLowerCase();

  if (h === targetHost || h.endsWith(`.${targetHost}`)) return true;
  if (allow.length && allow.some((a) => h === a || h.endsWith(`.${a}`))) return true;
  if (!allow.length && DEFAULT_ASSET_HOST_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`))) return true;
  // Allowlist verilmişse varsayılan suffix'lere güvenme (katı mod)
  return false;
}

/** Content-Type'dan dosya uzantısı çıkar */
function extFromContentType(ct = '', url = '') {
  const map = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/webp': '.webp',
    'image/avif': '.avif',
    'image/gif': '.gif',
    'image/bmp': '.bmp',
    'image/tiff': '.tiff',
    'image/svg+xml': '.svg',
  };
  const base = ct.split(';')[0].trim().toLowerCase();
  if (map[base]) return map[base];
  const m = /\.(png|jpe?g|webp|avif|gif|bmp|tiff?|svg)(?:[?#]|$)/i.exec(url);
  if (m) return `.${m[1].toLowerCase().replace('jpeg', 'jpg')}`;
  return '.png';
}

/**
 * Görseli indir (allowlist + boyut + redirect doğrulaması ile).
 * @returns {Promise<{buffer:Buffer, contentType:string, finalUrl:string, bytes:number, sha256:string}>}
 */
export async function downloadArtifact(url, { signal, maxBytes = config.artifact.maxDownloadBytes } = {}) {
  const started = Date.now();
  let current = url;
  let redirects = 0;
  let response;

  while (true) {
    let parsed;
    try {
      parsed = new URL(current);
    } catch {
      throw new AppError('Geçersiz asset URL.', { code: 'INVALID_ASSET_URL', httpStatus: 502 });
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new AppError(`Desteklenmeyen protokol: ${parsed.protocol}`, { code: 'INVALID_ASSET_URL', httpStatus: 502 });
    }
    if (!hostAllowed(parsed.hostname)) {
      throw new AppError(`Asset host izin listesinde değil: ${parsed.hostname}`, {
        code: 'ASSET_HOST_BLOCKED',
        httpStatus: 502,
        details: { host: parsed.hostname },
      });
    }

    response = await fetch(current, {
      redirect: 'manual',
      signal,
      headers: {
        'user-agent': config.stealth.userAgent,
        accept: 'image/avif,image/webp,image/png,image/*,*/*;q=0.8',
        referer: `${config.target.baseUrl}/`,
      },
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const loc = response.headers.get('location');
      if (!loc || ++redirects > 5) throw new UpstreamError('Asset indirmede yönlendirme limiti aşıldı.');
      current = new URL(loc, current).toString();
      continue;
    }
    break;
  }

  if (!response.ok) {
    throw new UpstreamError(`Asset indirilemedi (HTTP ${response.status}).`, { status: response.status, url: current });
  }

  const declared = Number(response.headers.get('content-length') || 0);
  if (declared && declared > maxBytes) {
    throw new UpstreamError(`Asset çok büyük (${declared} > ${maxBytes} byte).`, { code: 'ASSET_TOO_LARGE' });
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.length > maxBytes) {
    throw new UpstreamError(`Asset çok büyük (${buffer.length} > ${maxBytes} byte).`, { code: 'ASSET_TOO_LARGE' });
  }

  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  log.info({ bytes: buffer.length, contentType, downloadMs: Date.now() - started }, 'asset indirildi');
  return { buffer, contentType, finalUrl: current, bytes: buffer.length, sha256 };
}

/** Diske yaz, varsa public URL'i döndür */
export function persistArtifact({ buffer, contentType, sha256, ext }, { taskId, signal } = {}) {
  fs.mkdirSync(config.artifact.localDir, { recursive: true });
  const safeId = `${new Date().toISOString().slice(0, 10)}_${sha256.slice(0, 12)}_${taskId}`.replace(/[^a-zA-Z0-9._-]/g, '');
  const filename = `${safeId}${ext}`;
  const absPath = path.join(config.artifact.localDir, filename);
  fs.writeFileSync(absPath, buffer);

  // Public URL, app.js'deki statik mount ile birebir eşleşir: /files/artifacts → config.artifact.localDir
  const base = config.artifact.publicBaseUrl || `http://localhost:${config.server.port}`;
  const publicUrl = `${base.replace(/\/+$/, '')}/files/artifacts/${encodeURIComponent(path.basename(absPath))}`;

  if (config.artifact.deleteAfterMs > 0) {
    const t = setTimeout(() => {
      fs.rm(absPath, { force: true }, () => {});
    }, config.artifact.deleteAfterMs);
    t.unref?.();
  }

  return { path: absPath, filename, url: publicUrl, relative: path.relative(ROOT_DIR, absPath).split(path.sep).join('/') };
}

/**
 * Ana giriş noktası: aday URL → teslim nesnesi.
 *
 * @param {{url:string, source:string, score:number, reasons:string[]}} candidate
 * @param {{page?:import('playwright').Page, taskId?:string, signal?:AbortSignal}} ctx
 * @returns {Promise<{image_url?:string, image_base64?:string, image_file?:object, mime_type?:string, bytes?:number, sha256?:string, delivery:string, source:string}>}
 */
export async function deliverArtifact(candidate, { page, taskId = 'anon', signal, delivery } = {}) {
  // İstek bazlı `delivery` override'ı → global config'i değiştirmeden (yarış koşulu yok)
  const mode = ['url', 'base64', 'file', 'both'].includes(delivery) ? delivery : config.artifact.delivery;
  const out = {
    delivery: mode,
    source: candidate.source,
    capture_score: candidate.score,
    capture_reasons: candidate.reasons,
  };

  // DRY_RUN fixture'ı: indirme/allowlist denetimi yapılmaz, URL olduğu gibi döner
  if (candidate.dry_run) {
    return { ...out, delivery: 'url', image_url: candidate.url, dry_run: true };
  }

  // blob: URL → sayfa içinde dataURL'e çevir (Node fetch edemez)
  if (candidate.url.startsWith('blob:')) {
    if (!page) throw new AppError('blob: URL için sayfa bağlamı gerekli.', { code: 'BLOB_WITHOUT_PAGE', httpStatus: 502 });
    const dataUrl = await ArtifactCapture.prototype.resolveBlobUrl.call({ page, log }, candidate.url);
    if (!dataUrl) throw new AppError('blob: URL okunamadı.', { code: 'BLOB_READ_FAILED', httpStatus: 502 });
    const parsed = ArtifactCapture.parseDataUrl(dataUrl);
    return {
      ...out,
      image_url: undefined,
      image_base64: parsed.buffer.toString('base64'),
      mime_type: parsed.mimeType,
      bytes: parsed.bytes,
      sha256: parsed.sha256,
      delivery: 'base64',
    };
  }

  if (candidate.url.startsWith('data:image/')) {
    const parsed = ArtifactCapture.parseDataUrl(candidate.url);
    return {
      ...out,
      image_base64: parsed.buffer.toString('base64'),
      mime_type: parsed.mimeType,
      bytes: parsed.bytes,
      sha256: parsed.sha256,
      delivery: 'base64',
    };
  }

  out.image_url = candidate.url;
  if (mode === 'url') return out;

  const downloaded = await downloadArtifact(candidate.url, { signal });
  const ext = extFromContentType(downloaded.contentType, downloaded.finalUrl);
  out.mime_type = downloaded.contentType;
  out.bytes = downloaded.bytes;
  out.sha256 = downloaded.sha256;
  out.image_url = out.image_url || downloaded.finalUrl;

  if (mode === 'base64' || mode === 'both') {
    out.image_base64 = downloaded.buffer.toString('base64');
    out.base64_prefix = `data:${extToMime(ext)};base64,`;
  }
  if (mode === 'file' || mode === 'both') {
    const persisted = persistArtifact({ ...downloaded, ext }, { taskId, signal });
    out.image_file = { url: persisted.url, path: persisted.path, filename: persisted.filename };
    out.image_url = mode === 'file' ? persisted.url : out.image_url;
  }
  return out;
}

function extToMime(ext) {
  return (
    {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.webp': 'image/webp',
      '.avif': 'image/avif',
      '.gif': 'image/gif',
      '.bmp': 'image/bmp',
      '.tiff': 'image/tiff',
      '.svg': 'image/svg+xml',
    }[ext] || 'image/png'
  );
}
