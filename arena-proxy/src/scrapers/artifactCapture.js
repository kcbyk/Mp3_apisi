/**
 * src/scrapers/artifactCapture.js
 * ---------------------------------------------------------------------------
 * Üretilen asset'in URL'ini yakalayan çok kanallı dedektör.
 *
 * Kanallar (hepsi aynı anda dinlenir):
 *   1) Network: page.on('response')  → CDN/S3/GCS linkleri, JSON gövdelerdeki asset ref'leri
 *   2) WebSocket: page.on('websocket') → 'framereceived' (birçok platform üretim sonucunu WS ile bildirir)
 *   3) DOM: result <img src>, <a href>, CSS background-image, <video poster>, data-* attribute'ları
 *   4) Blob: blob: URL'leri → sayfa içinde canvas ile dataURL'e çevrilir
 *
 * Her aday skorlanır (sıralama için). Yüksek skorlu aday gelince bekleme biter.
 */
import crypto from 'node:crypto';
import { logger } from '../utils/logger.js';
import { ArtifactNotFoundError } from '../errors.js';

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|avif|gif|bmp|tiff?|svg)(\?|#|$)/i;
const CDN_HOST_RE =
  /(cloudflarestorage\.com|r2\.cloudflarestorage|amazonaws\.com|cloudfront\.net|storage\.googleapis\.com|googleusercontent\.com|blob\.core\.windows\.net|digitaloceanspaces\.com|backblazeb2\.com|cloudflare-?stream|imgix\.net|cloudinary\.com|supabase\.co|r2\.dev|akamaihd\.net|fastly\.net|b-cdn\.net|cdn\.|files\.|media\.|assets\.|static\.)/i;
const NEGATIVE_URL_RE =
  /(favicon|sprite|logo[-_.]?\d*|avatar|placeholder|spinner|loader|loading|blurhash|1x1\.|pixel\.gif|icon[-_.]?\d*\.(png|svg)|apple-touch|og-image|emoji|flag|googleusercontent|gravatar|profile[-_]?(pic|photo|image)|=s\d+(-c)?$)/i;
const IMAGE_MIME_RE = /^image\/(png|jpe?g|webp|avif|gif|bmp|tiff?)/i;

/** İç içe JSON içinde asset benzeri tüm string'leri topla */
function deepCollectStrings(value, out = [], depth = 0) {
  if (depth > 8 || value == null) return out;
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) deepCollectStrings(v, out, depth + 1);
    return out;
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value)) deepCollectStrings(v, out, depth + 1);
  }
  return out;
}

function absolutize(url, base) {
  try {
    if (!url) return null;
    if (url.startsWith('data:') || url.startsWith('blob:')) return url;
    return new URL(url, base).toString();
  } catch {
    return null;
  }
}

function scoreUrl(url) {
  let score = 0;
  const reasons = [];
  // Not: Aşağıdaki desenler jenerik CDN imzalarıdır; sayfa-dışı host kuralı
  // scanDom içinde büyük görseller için ek puan olarak uygulanır.
  if (!url) return { score: -999, reasons: ['boş'] };
  if (NEGATIVE_URL_RE.test(url)) return { score: -999, reasons: ['negatif pattern (ikon/avatar/placeholder)'] };

  if (CDN_HOST_RE.test(url)) { score += 3; reasons.push('cdn/s3 host'); }
  if (IMAGE_EXT_RE.test(url)) { score += 2; reasons.push('görsel uzantısı'); }
  if (/[?&](w|width|h|height|res|resolution|quality|size|fit)=/i.test(url)) { score += 2; reasons.push('boyut parametresi'); }
  if (/(1024|2048|1536|1792|4096)/.test(url)) { score += 1; reasons.push('yüksek çözünürlük ipucu'); }
  if (/generat|creation|render|output|result|artifact|asset|task|job/i.test(url)) { score += 1; reasons.push('üretim anahtar kelimesi'); }
  if (url.length > 60) { score += 1; reasons.push('uzun imzalı URL'); }
  if (/[?&](X-Amz-Signature|sig|token|expires|Expires)=/i.test(url)) { score += 1; reasons.push('imzalı URL'); }
  if (/^(https?:)?\/\/(localhost|127\.0\.0\.1)/i.test(url)) { score -= 3; reasons.push('yerel host'); }
  if (/\.(js|css|html?|json|woff2?|mp4|webm|m3u8)(\?|#|$)/i.test(url)) { score -= 4; reasons.push('görsel değil'); }
  return { score, reasons };
}

export class ArtifactCapture {
  /**
   * @param {import('playwright').Page} page
   * @param {{taskId?:string, minScore?:number, logger?:object}} opts
   */
  constructor(page, { taskId = 'anon', minScore = 6 } = {}) {
    this.page = page;
    this.taskId = taskId;
    this.minScore = minScore;
    this.log = (logger ?? console).child?.({ mod: 'capture', taskId }) ?? console;
    this.candidates = new Map(); // url → { url, score, reasons, source, at, contentType, width, height, bytes }
    this.jsonHits = [];
    this.wsFrames = 0;
    this.markedAt = Date.now();
    this._baseline = null;
    this._baselineReady = false;
    this._unsubs = [];
    this._attached = false;
  }

  /** Generate butonuna tıklama anını işaretle — yalnızca sonrasındaki adaylar geçerli */
  markBaseline() {
    this.markedAt = Date.now();
    this.candidates.clear();
  }

  attach() {
    if (this._attached) return this;
    this._attached = true;
    const page = this.page;
    const origin = (() => {
      try {
        return new URL(page.url()).origin;
      } catch {
        return '';
      }
    })();

    /* ---------------------------- 1) NETWORK ---------------------------- */
    const onResponse = async (response) => {
      try {
        const request = response.request();
        if (request.method() === 'OPTIONS') return;
        const status = response.status();
        if (status >= 400) return;

        const url = response.url();
        const headers = await response.allHeaders().catch(() => ({}));
        const contentType = headers['content-type'] || '';
        const isImage = IMAGE_MIME_RE.test(contentType);

        // (a) Doğrudan görsel yanıtları
        if (isImage || IMAGE_EXT_RE.test(url)) {
          this._add(url, {
            source: 'network:image',
            contentType,
            score: 2 + (isImage ? 2 : 0),
            reasons: [`status=${status}`, `ct=${contentType.split(';')[0]}`],
            at: Date.now(),
          });
        }

        // (b) Üretim/API JSON yanıtlarında gömülü asset URL'leri
        const likelyApi =
          /json/i.test(contentType) &&
          /(generat|image|creation|asset|render|task|job|feed|output|artifact|prompt|predict)/i.test(url);

        if (likelyApi) {
          let json = null;
          try {
            json = await response.json();
          } catch {
            return;
          }
          this.jsonHits.push({ url, at: Date.now() });
          const strings = deepCollectStrings(json);
          const urls = new Set();
          for (const s of strings) {
            if (!s || s.length < 12) continue;
            if (/^(https?:|data:image\/|blob:|\/\/|\/)/.test(s)) {
              const abs = absolutize(s, url);
              if (abs) urls.add(abs);
            }
          }
          for (const u of urls) {
            const { score, reasons } = scoreUrl(u);
            if (score < 3) continue;
            this._add(u, {
              source: `network:json(${shorten(url)})`,
              score: score + 3, // JSON içinden gelen ref'ler güçlü sinyal
              reasons: [...reasons, 'api-json'],
              at: Date.now(),
            });
          }

          // (c) API ayrıca "task/asset id" döndürüp URL'i hiç dönmüyorsa DOM'a düşeriz (fallback).
        }
      } catch (err) {
        this.log.debug?.({ err: err.message }, 'response inspect hatası (yoksayıldı)');
      }
    };

    page.on('response', onResponse);
    this._unsubs.push(() => page.off('response', onResponse));

    /* --------------------------- 2) WEBSOCKET --------------------------- */
    const onWebSocket = (ws) => {
      ws.on('framereceived', (frame) => {
        try {
          this.wsFrames += 1;
          const payload = typeof frame.payload === 'string' ? frame.payload : frame.payload?.toString?.('utf8') ?? '';
          if (!payload) return;
          const strings = [];
          try {
            deepCollectStrings(JSON.parse(payload), strings);
          } catch {
            strings.push(payload); // düz metin frame
          }
          for (const s of strings) {
            if (typeof s !== 'string' || s.length < 12) continue;
            const matches = s.match(/(https?:\/\/[^\s"'<>\\]+|blob:[^\s"'<>\\]+)/g) || [];
            for (const raw of matches) {
              const u = absolutize(raw, ws.url());
              if (!u) continue;
              const { score, reasons } = scoreUrl(u);
              if (score < 3) continue;
              this._add(u, {
                source: `websocket(${shorten(ws.url())})`,
                score: score + 3,
                reasons: [...reasons, 'ws-frame'],
                at: Date.now(),
              });
            }
          }
        } catch (err) {
          this.log.debug?.({ err: err.message }, 'ws frame parse hatası');
        }
      });
    };
    page.on('websocket', onWebSocket);
    this._unsubs.push(() => page.off('websocket', onWebSocket));

    this.log.debug?.({ origin }, 'ArtifactCapture bağlandı');
    return this;
  }

  detach() {
    for (const off of this._unsubs) {
      try {
        off();
      } catch {
        /* yut */
      }
    }
    this._unsubs = [];
    this._attached = false;
  }

  _add(url, { source, score = 0, reasons = [], contentType = '', at = Date.now() } = {}) {
    if (!url) return;
    const key = url.split('#')[0];
    const prev = this.candidates.get(key);
    const { score: urlScore, reasons: urlReasons } = scoreUrl(key);
    if (urlScore <= -100) return;

    const totalScore = urlScore + score;
    const rec = {
      url: key,
      score: totalScore,
      reasons: [...new Set([...urlReasons, ...reasons])],
      source,
      at,
      contentType,
      first_seen_ms_after_click: at - this.markedAt,
    };
    if (!prev || rec.score > prev.score) {
      this.candidates.set(key, rec);
      this.log.debug?.({ url: shorten(key), score: totalScore, source }, 'aday eklendi');
    }
  }

  /**
   * DOM'u tara: gerçek <img> elementleri en güvenilir kaynaktır.
   * NOT: İlk tarama "temel çizgi" (baseline) olarak kaydedilir; üretimden ÖNCE
   * sayfada duran görseller (kullanıcı avatarı, logo, banner) aday SAYILMAZ.
   */
  async scanDom() {
    const page = this.page;
    const frames = [page, ...page.frames().filter((f) => f !== page.mainFrame())];
    const collected = [];

    for (const frame of frames) {
      try {
        const items = await frame.evaluate(() => {
          const out = [];
          const push = (url, extra) => url && out.push({ url, ...extra });

          document.querySelectorAll('img').forEach((img) => {
            const src = img.currentSrc || img.src;
            if (!src) return;
            const w = img.naturalWidth || img.width || 0;
            const h = img.naturalHeight || img.height || 0;
            push(src, { w, h, tag: 'img', alt: img.alt || '' });
          });

          document.querySelectorAll('*').forEach((el) => {
            const bg = getComputedStyle(el).backgroundImage;
            if (bg && bg !== 'none' && bg.includes('url(')) {
              const m = bg.match(/url\(["']?(.*?)["']?\)/);
              if (m) push(m[1], { tag: 'bg' });
            }
          });

          document.querySelectorAll('a[href]').forEach((a) => {
            const href = a.getAttribute('href') || '';
            if (/\.(png|jpe?g|webp|avif)/i.test(href) || /download|image|asset/i.test(href)) {
              push(a.href, { tag: 'a', download: a.hasAttribute('download') });
            }
          });

          // data-* attribute'larında saklanan asset URL'leri (React/Next.js state kalıntıları)
          document.querySelectorAll('[data-src],[data-image],[data-url],[data-asset]').forEach((el) => {
            for (const attr of ['data-src', 'data-image', 'data-url', 'data-asset']) {
              const v = el.getAttribute(attr);
              if (v && /^(https?:|data:image\/|blob:)/.test(v)) push(v, { tag: attr });
            }
          });

          return out;
        });
        collected.push(...items.map((i) => ({ ...i, frameUrl: frame.url() })));
      } catch {
        /* frame detached olabilir */
      }
    }

    // İlk turda mevcut görselleri temel çizgi olarak al (avatar/logo yanlış eşleşmesini önler)
    if (!this._baselineReady) {
      this._baseline = new Set();
      for (const item of collected) {
        const u = absolutize(item.url, item.frameUrl || page.url());
        if (u) this._baseline.add(u.split('#')[0]);
      }
      this._baselineReady = true;
      this.log.debug?.({ adet: this._baseline.size }, 'DOM temel çizgisi kaydedildi');
      return this.best();
    }

    for (const item of collected) {
      const url = absolutize(item.url, item.frameUrl || page.url());
      if (!url) continue;
      if (this._baseline?.has(url.split('#')[0])) continue; // üretimden önce de vardı → atla
      const isBig = (item.w ?? 0) >= 300 || (item.h ?? 0) >= 300;
      const { score, reasons } = scoreUrl(url);
      // Eşik, bonuslar DAHİL toplam skora göre uygulanır: uzantısız CDN URL'leri
      // (örn. R2) temel skorda düşük kalır ama büyük <img> olarak güçlü sinyaldir.
      const toplam = score + (isBig ? 4 : 1) + (item.tag === 'img' ? 1 : 0) + (item.tag === 'img' && isBig ? 2 : 0);
      if (toplam < 2) continue;
      this._add(url, {
        source: `dom:${item.tag}`,
        score: toplam,
        reasons: [...reasons, `dim=${item.w ?? '?'}x${item.h ?? '?'}`],
        at: Date.now(),
      });
    }
    return this.best();
  }

  /** En yüksek skorlu aday */
  best() {
    const list = this.ranked();
    return list[0] ?? null;
  }

  ranked() {
    return [...this.candidates.values()].sort((a, b) => b.score - a.score || a.at - b.at);
  }

  top(n = 10) {
    return this.ranked().slice(0, n);
  }

  /**
   * Aday gelene kadar bekle. DOM taraması her turda yapılır (WS/JSON hiç gelmediyse kurtarıcı).
   * @returns {Promise<{url:string, source:string, score:number, reasons:string[]}>}
   */
  async waitForArtifact({ timeoutMs, pollIntervalMs = 500, signal, domScan = true, minScore = this.minScore } = {}) {
    const deadline = Date.now() + timeoutMs;
    let round = 0;

    while (Date.now() < deadline) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');

      const strong = this.ranked().find((c) => c.score >= minScore);
      if (strong) return strong;

      if (domScan && round % 2 === 0) {
        await this.scanDom();
        const domStrong = this.ranked().find((c) => c.score >= minScore);
        if (domStrong) return domStrong;
      }

      // Teşhis (DEBUG_CAPTURE=1): her 10 turda sayfada ne olduğunu logla
      if (process.env.DEBUG_CAPTURE === '1' && round % 20 === 0) {
        try {
          const durum = await this.page.evaluate(() => {
            const imgs = [...document.querySelectorAll('img')]
              .filter((x) => x.naturalWidth >= 200 && !/googleusercontent|particles|apple-touch|recaptcha/i.test(x.src))
              .map((x) => ({ src: x.src.slice(0, 90), w: x.naturalWidth, h: x.naturalHeight }));
            return {
              imgs,
              metinSon: document.body.innerText.replace(/\s+/g, ' ').slice(-140),
            };
          });
          this.log.warn?.({
            sn: Math.round((Date.now() - (this.markedAt || Date.now())) / 1000),
            adaySayisi: this.ranked().length,
            enIyi: this.ranked()[0] ? `${this.ranked()[0].score} ${shorten(this.ranked()[0].url)}` : null,
            domGorsel: durum.imgs.length,
            ilkGorsel: durum.imgs[0] || null,
            metinSon: durum.metinSon,
          }, '🔍 yakalama teşhisi');
        } catch (e) {
          this.log.warn?.({ err: String(e).slice(0, 80) }, '🔍 teşhis başarısız');
        }
      }

      round += 1;
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    // Süre doldu: elimizde zayıf aday var mı? Varsa onu döndür (minScore'u düşürerek).
    const weak = this.ranked()[0];
    if (weak && weak.score >= 3) {
      this.log.warn?.({ url: shorten(weak.url), score: weak.score }, 'minScore altında aday döndürülüyor');
      return weak;
    }
    throw new ArtifactNotFoundError('Süre doldu, üretilen görsel URL\'i yakalanamadı.', {
      candidates: this.top(5).map((c) => ({ url: shorten(c.url), score: c.score, source: c.source })),
      wsFrames: this.wsFrames,
      jsonHits: this.jsonHits.length,
    });
  }

  /** blob: URL'lerini sayfa içinde dataURL'e çevir (Node tarafından indirilemezler) */
  async resolveBlobUrl(blobUrl) {
    if (!blobUrl.startsWith('blob:')) return null;
    try {
      return await this.page.evaluate(async (u) => {
        const res = await fetch(u);
        const blob = await res.blob();
        return await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result);
          fr.onerror = reject;
          fr.readAsDataURL(blob);
        });
      }, blobUrl);
    } catch (err) {
      this.log.warn?.({ err: err.message }, 'blob → dataURL dönüşümü başarısız');
      return null;
    }
  }

  /** data:image/...;base64 → { mimeType, buffer, sha256, bytes } */
  static parseDataUrl(dataUrl) {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
    if (!m) return null;
    const [, mimeType = 'image/png', b64, data] = m;
    const buffer = b64 ? Buffer.from(data, 'base64') : Buffer.from(decodeURIComponent(data), 'utf8');
    return { mimeType, buffer, bytes: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
  }
}

function shorten(url, max = 110) {
  if (!url) return '';
  return url.length > max ? `${url.slice(0, max)}…` : url;
}

export { scoreUrl, shorten };
