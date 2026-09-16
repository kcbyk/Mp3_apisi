/**
 * src/automation/browserManager.js
 * ---------------------------------------------------------------------------
 * Chromium yaşam döngüsü + **browser/context pooling** katmanı.
 *
 * Neden havuz?
 *   Her istekte `chromium.launch()` çağırmak 1-3 saniye CPU + ~200 MB bellek
 *   demektir. Burada tek bir Chromium process'i yaşatıp, içinde **yeniden
 *   kullanılan context'ler** tutuyoruz. Her istek kendi `page`'ini alır ve
 *   iş bitince yalnızca sayfayı kapatır; context havuza geri döner.
 *
 * Geri dönüşüm (recycle) kuralları:
 *   - MAX_PAGES_PER_CONTEXT kadar istek hizmet verdiyse (bellek sızıntısı önlemi)
 *   - CONTEXT_MAX_AGE_MS yaşını geçtiyse
 *   - session dosyası değiştiyse (storage version uyuşmuyorsa → yeni cookie'ler)
 *   - context kapandı/çöktüyse
 *
 * İki çalışma modu:
 *   - SESSION_MODE=storage → `browser.newContext({ storageState })`
 *   - SESSION_MODE=profile / PERSISTENT_PROFILE=true → `launchPersistentContext()`
 *     (cookie + localStorage diske yazılır; giriş bir kez yapılır, oturum kalıcıdır)
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium as playwrightExtraChromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import { config, ensureRuntimeDirs } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { sessionStore } from './sessionStore.js';
import { BrowserClosedError, SessionError, StepTimeoutError } from '../errors.js';

const log = logger.child({ mod: 'browserManager' });

let stealthApplied = false;
function applyStealth() {
  if (stealthApplied) return;
  if (config.stealth.enabled) {
    playwrightExtraChromium.use(stealthPlugin());
    log.info('stealth eklentisi etkinleştirildi (playwright-extra + puppeteer-extra-plugin-stealth)');
  }
  stealthApplied = true;
}

/** Chromium'u otomatikleştirilmiş gibi gösteren bayrakları kaldıran argümanlar */
function chromiumArgs() {
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage', // Docker'da /dev/shm 64MB ise kritik
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process,AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-infobars',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-ipc-flooding-protection',
    '--password-store=basic',
    '--use-mock-keychain',
    '--window-size=' + config.browser.viewport.width + ',' + config.browser.viewport.height,
    ...config.browser.extraArgs,
  ];

  // Proxy verilmişse Chromium argümanı olarak da geç (Playwright seçeneğiyle birlikte yedekli)
  if (config.proxy.enabled && config.proxy.server && !config.proxy.username) {
    args.push(`--proxy-server=${config.proxy.server}`);
    if (config.proxy.bypass.length) args.push(`--proxy-bypass-list=${config.proxy.bypass.join(';')}`);
  }
  return args;
}

function proxyOption() {
  if (!config.proxy.enabled || !config.proxy.server) return undefined;
  let server = config.proxy.server;
  let username = config.proxy.username || undefined;
  let password = config.proxy.password || undefined;

  // http://user:pass@host:port biçiminde verilmişse ayıkla
  try {
    const u = new URL(server);
    if (u.username || u.password) {
      username = username || decodeURIComponent(u.username);
      password = password || decodeURIComponent(u.password);
      u.username = '';
      u.password = '';
      server = u.toString().replace(/\/$/, '');
    }
  } catch {
    /* server zaten host:port olabilir */
  }
  return { server, username, password, bypass: config.proxy.bypass.join(',') || undefined };
}

/** Ortak context seçenekleri (locale, timezone, UA, headers, viewport) */
function baseContextOptions({ storageState } = {}) {
  const opts = {
    viewport: config.browser.viewport,
    screen: config.browser.viewport,
    userAgent: config.stealth.userAgent,
    locale: config.stealth.locale,
    timezoneId: config.stealth.timezoneId,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    colorScheme: 'light',
    ignoreHTTPSErrors: false,
    acceptDownloads: true,
    bypassCSP: true,
    javaScriptEnabled: true,
    extraHTTPHeaders: {
      'accept-language': config.stealth.acceptLanguage,
      'sec-ch-ua': '"Chromium";v="128", "Not(A:Brand";v="24", "Google Chrome";v="128"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'upgrade-insecure-requests': '1',
    },
    proxy: proxyOption(),
  };
  if (storageState) opts.storageState = storageState;
  return opts;
}

/** Bot tespitini azaltan ek init script'ler (stealth eklentisine ek güvence) */
const INIT_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['tr-TR','tr','en-US','en'] });
  Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
  Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
  if (!window.chrome) { window.chrome = { runtime: {}, app: { isInstalled: false }, csi: () => {}, loadTimes: () => {} }; }
  const origQuery = window.navigator.permissions && window.navigator.permissions.query;
  if (origQuery) {
    window.navigator.permissions.query = (p) =>
      p && p.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission, onchange: null })
        : origQuery.call(window.navigator.permissions, p);
  }
  const getParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function (p) {
    if (p === 37445) return 'Intel Inc.';
    if (p === 37446) return 'Intel Iris OpenGL Engine';
    return getParameter.apply(this, [p]);
  };
`;

export class BrowserManager {
  constructor() {
    /** @type {import('playwright').Browser|null} */
    this.browser = null;
    /** @type {Array<object>} havuzdaki context kayıtları */
    this.pool = [];
    /** @type {Array<{resolve:Function,reject:Function,taskId:string,timer:NodeJS.Timeout}>} */
    this.waiters = [];
    this.launching = null;
    this.closing = false;
    this.metrics = {
      launches: 0,
      contextsCreated: 0,
      contextsRecycled: 0,
      pagesServed: 0,
      pagesFailed: 0,
      lastLaunchAt: null,
      lastError: null,
    };
    /** @type {Map<string, Set<import('playwright').Page>>} */
    this.pagesByEntry = new Map();
  }

  /* ------------------------------------------------------------------ */
  /*  Yaşam döngüsü                                                      */
  /* ------------------------------------------------------------------ */

  async ensureBrowser() {
    if (this.browser && this.browser.isConnected()) return this.browser;
    if (this.launching) return this.launching;
    this.launching = this._launch().finally(() => {
      this.launching = null;
    });
    return this.launching;
  }

  async _launch() {
    ensureRuntimeDirs();
    applyStealth();
    const args = chromiumArgs();
    log.info({ headless: config.browser.headless, proxy: config.proxy.enabled }, 'Chromium başlatılıyor');

    const browser = await playwrightExtraChromium.launch({
      headless: config.browser.headless,
      channel: config.browser.channel,
      args,
      proxy: proxyOption(),
      timeout: Math.max(30_000, config.browser.navigationTimeoutMs),
      downloadsPath: path.join(config.artifact.localDir, '_downloads'),
    });

    browser.on('disconnected', () => {
      log.error('Chromium bağlantısı koptu — havuz sıfırlanıyor');
      this.metrics.lastError = 'browser_disconnected';
      for (const entry of this.pool) entry.dead = true;
      this.pool = [];
      this.browser = null;
      this._flushWaiters(new BrowserClosedError());
    });

    this.browser = browser;
    this.metrics.launches += 1;
    this.metrics.lastLaunchAt = new Date().toISOString();
    return browser;
  }

  /* ------------------------------------------------------------------ */
  /*  Context havuzu                                                     */
  /* ------------------------------------------------------------------ */

  _sessionVersion() {
    if (config.session.mode !== 'storage') return 0;
    try {
      sessionStore.get(false);
      return sessionStore.version;
    } catch (err) {
      throw err instanceof SessionError ? err : new SessionError(err.message);
    }
  }

  _isStale(entry, sessionVersion) {
    if (entry.dead || entry.context.isClosed?.()) return true;
    if (entry.uses >= config.browser.maxPagesPerContext) return true;
    if (Date.now() - entry.createdAt > config.browser.contextMaxAgeMs) return true;
    if (entry.sessionVersion !== sessionVersion) return true;
    return false;
  }

  async _createEntry() {
    const sessionVersion = this._sessionVersion();
    let entry;

    if (config.browser.persistentProfile || config.session.mode === 'profile') {
      // --- Kalıcı profil modu: her context kendi kullanıcı dizininde yaşar ---
      const userDataDir = path.join(config.browser.profileBaseDir, `ctx-${Date.now()}-${this.pool.length}`);
      fs.mkdirSync(userDataDir, { recursive: true });
      const context = await playwrightExtraChromium.launchPersistentContext(userDataDir, {
        headless: config.browser.headless,
        channel: config.browser.channel,
        args: chromiumArgs(),
        proxy: proxyOption(),
        ...baseContextOptions(),
      });
      entry = { id: userDataDir, context, browser: null, persistent: true, createdAt: Date.now(), uses: 0, sessionVersion, dead: false, inUse: false, profileDir: userDataDir };
    } else {
      // --- Storage modu (önerilen): session dosyası her context'e enjekte edilir ---
      const browser = await this.ensureBrowser();
      const storageState = sessionStore.get(false);
      const context = await browser.newContext(baseContextOptions({ storageState }));
      entry = { id: `ctx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, context, browser, persistent: false, createdAt: Date.now(), uses: 0, sessionVersion, dead: false, inUse: false };
    }

    // Ortak context ayarları (her iki modda da entry.context üzerinden)
    const context = entry.context;
    context.setDefaultTimeout(config.target.stepTimeoutMs);
    context.setDefaultNavigationTimeout(config.browser.navigationTimeoutMs);
    await context.addInitScript(INIT_SCRIPT);
    context.on('close', () => {
      entry.dead = true;
    });
    this.pagesByEntry.set(entry.id, new Set());
    this.pool.push(entry);
    this.metrics.contextsCreated += 1;
    log.debug({ id: entry.id, pool: this.pool.length }, 'yeni context oluşturuldu');
    return entry;
  }

  /** Havuzdan uygun entry al; yoksa üret veya bekle */
  async _acquireEntry(taskId) {
    const sessionVersion = this._sessionVersion();

    // 1) Boşta olan ve taze bir entry var mı?
    for (const entry of this.pool) {
      if (entry.inUse) continue;
      if (this._isStale(entry, sessionVersion)) {
        await this._destroyEntry(entry, 'stale');
        continue;
      }
      entry.inUse = true;
      return entry;
    }

    // 2) Kapasite var mı?
    const aliveCount = this.pool.filter((e) => !e.dead).length;
    if (aliveCount < config.browser.maxContexts) {
      const entry = await this._createEntry();
      entry.inUse = true;
      return entry;
    }

    // 3) Kapasite dolu → sıraya gir (bounded bekleme)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== resolve);
        reject(new StepTimeoutError('context_pool_wait', config.queue.waitTimeoutMs));
      }, config.queue.waitTimeoutMs);
      this.waiters.push({ resolve, reject, taskId, timer, sessionVersion });
      log.debug({ taskId, waiters: this.waiters.length }, 'context havuzu dolu, bekleniyor');
    });
  }

  async _destroyEntry(entry, reason) {
    entry.dead = true;
    entry.inUse = false;
    if (reason === 'stale' || reason === 'recycle') this.metrics.contextsRecycled += 1;

    const pages = this.pagesByEntry.get(entry.id);
    if (pages) {
      await Promise.allSettled([...pages].map((p) => (p.isClosed() ? null : p.close({ runBeforeUnload: false }))));
      this.pagesByEntry.delete(entry.id);
    }
    try {
      await entry.context.close();
    } catch (err) {
      log.debug({ id: entry.id, err: err.message }, 'context kapatılamadı');
    }
    // Kalıcı profilliyse ve bir daha kullanılmayacaksa diski temizle (yalnızca stale)
    if (entry.persistent && entry.profileDir && reason === 'stale') {
      fs.rm(entry.profileDir, { recursive: true, force: true }, () => {});
    }
    this.pool = this.pool.filter((e) => e !== entry);
    log.debug({ id: entry.id, reason }, 'context kapatıldı');
  }

  _flushWaiters(error) {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.reject(error);
    }
  }

  /** Havuzda yer açıldığında bekleyenleri uyandır */
  async _pumpWaiters() {
    while (this.waiters.length) {
      const sessionVersion = this._sessionVersion();
      let free = this.pool.find(
        (e) => !e.inUse && !e.dead && !this._isStale(e, sessionVersion),
      );
      if (!free) {
        const aliveCount = this.pool.filter((e) => !e.dead).length;
        if (aliveCount < config.browser.maxContexts && !this.closing) {
          try {
            free = await this._createEntry();
          } catch (err) {
            const w = this.waiters.shift();
            clearTimeout(w.timer);
            w.reject(err);
            continue;
          }
        } else {
          return; // yer yok, beklemede kalsınlar
        }
      }
      const waiter = this.waiters.shift();
      clearTimeout(waiter.timer);
      free.inUse = true;
      waiter.resolve(free);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Public API                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * İstek için bir sayfa al.
   * @returns {Promise<{page, context, release:(opts?:{ok?:boolean})=>Promise<void>, entryId:string, reused:boolean}>}
   */
  async acquirePage({ taskId = 'anon' } = {}) {
    if (this.closing) throw new BrowserClosedError('Servis kapanıyor, yeni iş kabul edilmiyor.');
    const entry = await this._acquireEntry(taskId);
    const reused = entry.uses > 0;

    let page;
    try {
      page = await entry.context.newPage();
    } catch (err) {
      // Context bozulmuş olabilir: bu entry'i imha edip TEK seferlik yeniden dene
      log.warn({ id: entry.id, err: err.message }, 'newPage başarısız, context yenileniyor');
      await this._destroyEntry(entry, 'crashed');
      const retryEntry = await this._acquireEntry(taskId);
      page = await retryEntry.context.newPage();
      entry = retryEntry;
      this.pagesByEntry.get(entry.id)?.add(page);
    }

    entry.uses += 1;
    entry.lastUsedAt = Date.now();
    this.metrics.pagesServed += 1;
    this.pagesByEntry.get(entry.id)?.add(page);

    if (config.browser.blockUrlPatterns.length || config.browser.blockFonts || config.browser.blockMedia) {
      await this._installResourceBlocking(page);
    }
    page.setDefaultTimeout(config.target.stepTimeoutMs);
    page.setDefaultNavigationTimeout(config.browser.navigationTimeoutMs);

    return this._wrap(entry, page, taskId, reused);
  }

  _wrap(entry, page, taskId, reused) {
    let released = false;
    const release = async ({ ok = true } = {}) => {
      if (released) return;
      released = true;
      if (!ok) this.metrics.pagesFailed += 1;
      try {
        if (!page.isClosed()) await page.close({ runBeforeUnload: false });
      } catch {
        /* yut */
      }
      this.pagesByEntry.get(entry.id)?.delete(page);
      entry.inUse = false;

      if (entry.dead || this.closing) {
        await this._destroyEntry(entry, 'closed');
      } else if (this._isStale(entry, config.session.mode === 'storage' ? sessionStore.version : 0)) {
        await this._destroyEntry(entry, 'recycle');
      } else if (entry.uses >= config.browser.maxPagesPerContext) {
        await this._destroyEntry(entry, 'recycle');
      }
      // NOT: Context geri havuza dönerken cookie'ler TEMİZLENMEZ —
      // aksi halde storage modunda oturum kaybedilir. Oturum izolasyonu
      // gerekiyorsa SESSION_MODE=storage + her istekte yeni context yeterlidir.
      await this._pumpWaiters();
    };
    return { page, context: entry.context, entryId: entry.id, reused, release };
  }

  /** Analytics/tracker ve (opsiyonel) font/medya isteklerini engelle */
  async _installResourceBlocking(page) {
    const patterns = config.browser.blockUrlPatterns;
    const re = patterns.length ? new RegExp(patterns.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i') : null;

    await page.route('**/*', (route) => {
      const request = route.request();
      const url = request.url();
      const type = request.resourceType();

      if (re && re.test(url)) return route.abort('blockedbyclient').catch(() => {});
      if (config.browser.blockFonts && type === 'font') return route.abort('blockedbyclient').catch(() => {});
      if (config.browser.blockMedia && (type === 'media' || type === 'image')) {
        // DİKKAT: image engellenirse üretilen asset URL'i response event'inden yakalanamaz.
        if (type === 'media') return route.abort('blockedbyclient').catch(() => {});
      }
      return route.continue().catch(() => {});
    });
  }

  /** Esnek bekleme: havuzdaki tüm işler bitene kadar bekle (graceful shutdown) */
  async drain(timeoutMs = 30_000) {
    const started = Date.now();
    while (this.pool.some((e) => e.inUse) && Date.now() - started < timeoutMs) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  async closeAll() {
    this.closing = true;
    this.sessionWatcherStopped = true;
    this._flushWaiters(new BrowserClosedError('Servis kapatılıyor.'));
    await this.drain(15_000);
    const entries = [...this.pool];
    await Promise.allSettled(entries.map((e) => this._destroyEntry(e, 'closed')));
    try {
      if (this.browser) await this.browser.close();
    } catch {
      /* yut */
    }
    this.browser = null;
    this.pool = [];
    log.info('tüm tarayıcı kaynakları kapatıldı');
  }

  /** Sağlık kontrolü + metrikler */
  health() {
    const now = Date.now();
    return {
      browserConnected: Boolean(this.browser?.isConnected()),
      persistentMode: config.browser.persistentProfile || config.session.mode === 'profile',
      contextsAlive: this.pool.filter((e) => !e.dead).length,
      contextsInUse: this.pool.filter((e) => e.inUse).length,
      maxContexts: config.browser.maxContexts,
      waiting: this.waiters.length,
      oldestContextAgeMs: this.pool.length ? now - Math.min(...this.pool.map((e) => e.createdAt)) : 0,
      metrics: this.metrics,
    };
  }
}

export const browserManager = new BrowserManager();
export { baseContextOptions, chromiumArgs };
