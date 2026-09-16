/**
 * src/automation/sessionStore.js
 * ---------------------------------------------------------------------------
 * Cookie / LocalStorage (session) yönetimi.
 *
 * Desteklenen giriş formatları (hepsi otomatik algılanır ve normalize edilir):
 *   1) Playwright storageState  → { cookies: [...], origins: [{origin, localStorage: [...]}] }
 *   2) Cookie-Editor / EditThisCookie export → [ {name, value, domain, path, ...}, ... ]
 *   3) { cookies: [...] } (extension veya CDP export)
 *   4) Netscape cookies.txt (satır bazlı, sekmelerle ayrılmış)
 *
 * Özellikler:
 *   - Dosya mtime + boyut değişirse otomatik yeniden yükleme (canlı rotasyon)
 *   - `version` sayacı: context pool, eski session ile açılmış context'leri geri dönüştürür
 *   - SameSite normalize: extension export'larında gelen "no_restriction|unspecified|None" → Playwright enum
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { SessionError } from '../errors.js';

const log = logger.child({ mod: 'sessionStore' });

const SAME_SITE_MAP = {
  no_restriction: 'None',
  unspecified: 'Lax',
  none: 'None',
  lax: 'Lax',
  strict: 'Strict',
  'no-restriction': 'None',
};

function toUnixSeconds(expires) {
  if (expires === undefined || expires === null || expires === '') return -1;
  const n = Number(expires);
  if (!Number.isFinite(n)) return -1;
  // ms cinsinden verilmişse (13 hane) saniyeye çevir
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

/** Tek bir cookie objesini Playwright formatına çevirir */
function normalizeCookie(c) {
  if (!c || !c.name || c.domain === undefined) return null;
  const domain = String(c.domain).trim();
  const sameSiteRaw = String(c.sameSite ?? c.same_site ?? '').toLowerCase();
  const cookie = {
    name: String(c.name),
    value: c.value === undefined || c.value === null ? '' : String(c.value),
    domain,
    path: c.path || '/',
    expires: toUnixSeconds(c.expires ?? c.expirationDate),
    httpOnly: Boolean(c.httpOnly ?? c.http_only ?? false),
    secure: Boolean(c.secure ?? String(domain).startsWith('.') ? c.secure !== false : c.secure ?? false),
    sameSite: SAME_SITE_MAP[sameSiteRaw] || 'Lax',
  };
  // Değer boş ve session cookie değilse anlamsız
  if (cookie.value === '' && cookie.expires !== -1) return null;
  return cookie;
}

function parseNetscapeCookies(txt) {
  const out = [];
  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    const [domain, , cookiePath, secure, expires, name, value] = parts;
    const c = normalizeCookie({
      domain,
      path: cookiePath,
      secure: secure?.toUpperCase() === 'TRUE',
      expires,
      name,
      value,
    });
    if (c) out.push(c);
  }
  return out;
}

/** Her formattan { cookies, origins } üretir */
export function normalizeStorageState(raw, sourceLabel = 'inline') {
  const empty = { cookies: [], origins: [] };
  if (!raw) return empty;

  if (typeof raw === 'string') {
    const txt = raw;
    try {
      return normalizeStorageState(JSON.parse(txt), sourceLabel);
    } catch {
      const parsed = parseNetscapeCookies(txt);
      if (parsed.length) {
        log.info({ source: sourceLabel, cookies: parsed.length, format: 'netscape' }, 'session parse edildi');
        return { cookies: parsed, origins: [] };
      }
      throw new SessionError(`Session dosyası ayrıştırılamadı (geçersiz JSON/Netscape): ${sourceLabel}`);
    }
  }

  let cookies = [];
  let origins = [];

  if (Array.isArray(raw)) {
    cookies = raw; // EditThisCookie / Cookie-Editor export
  } else if (Array.isArray(raw.cookies)) {
    cookies = raw.cookies;
    origins = Array.isArray(raw.origins) ? raw.origins : [];
  } else if (raw.localStorage || raw.sessionStorage) {
    // { localStorage: { key: value } } biçiminde basit export
    const ls = raw.localStorage || {};
    origins = [
      {
        origin: raw.origin || new URL(config.target.baseUrl).origin,
        localStorage: Object.entries(ls).map(([name, value]) => ({ name, value: String(value) })),
      },
    ];
  } else {
    throw new SessionError(`Session dosyası tanınmayan formatta: ${sourceLabel}`);
  }

  const normalized = {
    cookies: cookies.map(normalizeCookie).filter(Boolean),
    origins: origins
      .filter((o) => o && o.origin)
      .map((o) => ({
        origin: o.origin,
        localStorage: (o.localStorage || []).map(({ name, value }) => ({ name, value: String(value) })),
      })),
  };

  if (normalized.cookies.length === 0 && normalized.origins.length === 0) {
    throw new SessionError(`Session dosyasında kullanılabilir cookie/localStorage yok: ${sourceLabel}`);
  }
  log.info(
    { source: sourceLabel, cookies: normalized.cookies.length, origins: normalized.origins.length },
    'session yüklendi',
  );
  return normalized;
}

class SessionStore {
  constructor() {
    this.statePath = config.session.statePath;
    this.cached = null;
    this.version = 0;
    this.signature = null;
    this.timer = null;
  }

  /** Oturum kaynağı var mı? (env > dosya) */
  exists() {
    if (config.session.stateB64 || config.session.stateJson) return true;
    try {
      return fs.existsSync(this.statePath) && fs.statSync(this.statePath).size > 0;
    } catch {
      return false;
    }
  }

  /**
   * Oturumun okunacağı kaynak + değişiklik imzası.
   * Sıra: SESSION_STATE_B64 → SESSION_STATE_JSON → dosya.
   * Env tabanlı kaynaklar Render gibi kalıcı diski olmayan ortamlar içindir.
   */
  _kaynak() {
    const b64 = config.session.stateB64;
    if (b64) {
      const raw = Buffer.from(b64, 'base64').toString('utf8');
      return {
        etiket: 'SESSION_STATE_B64',
        raws: raw,
        signature: `b64:${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16)}`,
        dosyaMi: false,
      };
    }
    const js = config.session.stateJson;
    if (js) {
      return {
        etiket: 'SESSION_STATE_JSON',
        raws: js,
        signature: `json:${crypto.createHash('sha256').update(js).digest('hex').slice(0, 16)}`,
        dosyaMi: false,
      };
    }
    if (!this.exists()) {
      throw new SessionError(
        `Session bulunamadı: ${this.statePath} (veya SESSION_STATE_B64 env'i). ` +
          '"npm run session:save" ile oluşturun; bulut ortamı için: npm run session:env (bkz. SESSION_GUIDE.md)',
      );
    }
    try {
      const st = fs.statSync(this.statePath);
      return {
        etiket: path.basename(this.statePath),
        raws: fs.readFileSync(this.statePath, 'utf8'),
        signature: `${st.mtimeMs}:${st.size}`,
        dosyaMi: true,
      };
    } catch (err) {
      throw new SessionError(`Session dosyası okunamadı: ${err.message}`);
    }
  }

  /**
   * storageState döndürür. Dosya değişmediyse cache'ten verir.
   * @param {boolean} force diskten zorla oku
   */
  get(force = false) {
    const kaynak = this._kaynak();
    if (!force && this.cached && kaynak.signature === this.signature) return this.cached;

    const state = normalizeStorageState(kaynak.raws, kaynak.etiket);
    this.cached = state;
    this.signature = kaynak.signature;
    this.version += 1;
    log.info(
      { version: this.version, cookies: state.cookies.length, kaynak: kaynak.etiket },
      'session cache yenilendi',
    );
    return state;
  }

  /**
   * Session dosyasını periyodik kontrol et (mtime değişince otomatik reload).
   * Dosya yoksa her turda uyarı basmak yerine yalnızca bir kez bilgilendirir.
   */
  startWatcher() {
    if (this.timer) return;
    if (config.session.stateB64 || config.session.stateJson) {
      log.info({ kaynak: config.session.stateB64 ? 'SESSION_STATE_B64' : 'SESSION_STATE_JSON' },
        'oturum env üzerinden geliyor — dosya izleyicisi başlatılmadı');
      return;
    }
    let warnedMissing = false;
    this.timer = setInterval(() => {
      if (!this.exists()) {
        if (!warnedMissing) {
          log.info({ path: this.statePath }, 'session dosyası yok — izleyici bekliyor (oluşturulunca otomatik yüklenecek)');
          warnedMissing = true;
        }
        return;
      }
      warnedMissing = false;
      try {
        this.get(false);
      } catch (err) {
        log.warn({ err: err.message }, 'session reload başarısız');
      }
    }, config.session.reloadIntervalMs);
    this.timer.unref?.();
  }

  stopWatcher() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** /session/status için özet (cookie değerleri ASLA dönmez) */
  describe() {
    try {
      const state = this.get(false);
      return {
        ok: true,
        path: config.session.stateB64 ? 'env:SESSION_STATE_B64'
          : config.session.stateJson ? 'env:SESSION_STATE_JSON' : this.statePath,
        version: this.version,
        cookie_count: state.cookies.length,
        origin_count: state.origins.length,
        cookie_names: state.cookies.map((c) => c.name).slice(0, 40),
        earliest_expiry: state.cookies
          .map((c) => c.expires)
          .filter((e) => typeof e === 'number' && e > 0)
          .sort((a, b) => a - b)[0] ?? null,
      };
    } catch (err) {
      return { ok: false, path: this.statePath, error: err.message };
    }
  }
}

export const sessionStore = new SessionStore();
export { normalizeCookie };
