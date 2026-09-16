/**
 * src/config/index.js
 * ---------------------------------------------------------------------------
 * Tüm konfigürasyon tek yerden, zod ile doğrulanarak okunur.
 * Eksik/yanlış env → process açılışta anlaşılır bir hatayla durur (fail-fast).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..', '..');

dotenv.config({ path: path.join(ROOT_DIR, '.env') });

/* --------------------------- yardımcı parser'lar --------------------------- */
const bool = (def) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const num = (def) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().int());

const list = (def = []) =>
  z
    .string()
    .optional()
    .transform((v) =>
      (v === undefined || v === '' ? def : v.split(',').map((s) => s.trim()).filter(Boolean)),
    );

const str = (def = '') =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : v));

const schema = z.object({
  NODE_ENV: str('development'),
  PORT: num(8080),
  HOST: str('0.0.0.0'),
  LOG_LEVEL: str('info'),
  LOG_PRETTY: bool(false),
  CORS_ORIGINS: list(['*']),
  API_PREFIX: str('/api/v1'),

  API_KEYS: list([]),
  AUTH_ENABLED: bool(true),

  BROWSER_HEADLESS: bool(true),
  BROWSER_CHANNEL: str(''),
  MAX_CONTEXTS: num(3),
  MAX_PAGES_PER_CONTEXT: num(25),
  CONTEXT_MAX_AGE_MS: num(900_000),
  BROWSER_MAX_AGE_MS: num(3_600_000),
  PERSISTENT_PROFILE: bool(false),
  PROFILE_BASE_DIR: str('./data/profiles'),
  VIEWPORT_WIDTH: num(1440),
  VIEWPORT_HEIGHT: num(900),
  EXTRA_CHROMIUM_ARGS: list([]),
  BLOCK_URL_PATTERNS: list([]),
  BLOCK_FONTS: bool(false),
  BLOCK_MEDIA: bool(false),
  NAVIGATION_TIMEOUT_MS: num(45_000),

  SESSION_MODE: z.enum(['storage', 'profile']).catch('storage'),
  SESSION_STATE_PATH: str('./data/sessions/arena.json'),
  // Bulut ortamları (Render vb.) için: oturum dosyası olmadan, env içinden base64/JSON
  SESSION_STATE_B64: str(''),
  SESSION_STATE_JSON: str(''),
  SESSION_RELOAD_INTERVAL_MS: num(60_000),
  // Ölümsüz oturum (kendini yenileyen çerez) ayarları
  SESSION_COOKIE_NAME: str('arena-auth-prod-v1.0'),
  SESSION_KEEPALIVE_MINUTES: num(25),
  SESSION_REFRESH_THRESHOLD_MINUTES: num(20),
  SESSION_REFRESH_TIMEOUT_MS: num(45_000),
  SESSION_BROWSER_WAIT_MS: num(75_000), // tarayıcı yolu: jeton değişimini bekleme süresi (üst sınır)
  SESSION_HTTP_REFRESH: bool(true), // false → yalnızca tarayıcı yolu (tek tüketici, en güvenli)
  SESSION_PERSIST: str('file+render'),
  SESSION_ENV_VAR_NAME: str('SESSION_STATE_B64'),
  RENDER_API_KEY: str(''),
  RENDER_SERVICE_ID: str(''),
  // Özel GitHub deposunda kalıcılık (repo KESİNLİKLE private olmalı — kod kontrol eder)
  GITHUB_TOKEN: str(''),
  GITHUB_SESSION_REPO: str(''),          // örn: kullanici/arena-oturum
  GITHUB_SESSION_PATH: str('arena-oturum.json'),
  GITHUB_SESSION_BRANCH: str('main'),

  STEALTH_ENABLED: bool(true),
  HUMANIZE: bool(true),
  USER_AGENT: str(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  ),
  LOCALE: str('en-US'),
  TIMEZONE: str('Europe/Istanbul'),
  ACCEPT_LANGUAGE: str('en-US,en;q=0.9'),

  PROXY_ENABLED: bool(false),
  PROXY_SERVER: str(''),
  PROXY_USERNAME: str(''),
  PROXY_PASSWORD: str(''),
  PROXY_BYPASS: list([]),

  QUEUE_CONCURRENCY: num(2),
  QUEUE_RATE_PER_MIN: num(0), // 0 = otomatik (concurrency × 6)
  MAX_QUEUE_SIZE: num(50),
  // Tek işin toplam ömrü — TÜM denemeleri kapsar. Arena 'Max' üretimi canlıda 10+ dk
  // sürebildiği için kısa tutmak retry'ları yarıda keser (bkz. timeoutCoherenceWarnings).
  JOB_TIMEOUT_MS: num(1_500_000),
  QUEUE_WAIT_TIMEOUT_MS: num(60_000),

  RETRY_ATTEMPTS: num(2),
  RETRY_MIN_TIMEOUT_MS: num(1_000),
  RETRY_MAX_TIMEOUT_MS: num(8_000),
  RETRY_ON: list(['NavigationError', 'StepTimeoutError', 'ArtifactNotFoundError', 'BrowserClosedError']),

  TARGET_NAME: str('arena'),
  TARGET_BASE_URL: str('https://arena.ai'),
  TARGET_GENERATE_PATH: str('/'),
  SELECTORS_PATH: str('./src/scrapers/selectors/arena.json'),
  ALLOWED_NAV_HOSTS: list([]),
  STEP_TIMEOUT_MS: num(20_000),
  // "Görsel URL'ini yakala" bekleme süresi — Arena'nın ağır modelleri yoğun saatlerde
  // dakikalarca üretebiliyor (canlı gözlem). Kısa tutulursa ARTIFACT_NOT_FOUND döner.
  GENERATION_TIMEOUT_MS: num(1_200_000),
  // Gönderim stratejisi: auto → arena.ai'de Enter (buton tıklaması ToS/reCAPTCHA kapısını tetikler),
  // diğer hedeflerde butona tıklama. 'enter' | 'click' ile sabitlenebilir.
  TARGET_SEND_MODE: str('auto'),
  ARTIFACT_POLL_INTERVAL_MS: num(500),
  WAIT_FOR_DOM_RESULT: bool(true),
  SCREENSHOT_ON_ERROR: bool(true),
  SCREENSHOT_DIR: str('./data/screenshots'),
  DRY_RUN: bool(false),

  ARTIFACT_DELIVERY: z.enum(['url', 'base64', 'file', 'both']).catch('url'),
  ARTIFACT_LOCAL_DIR: str('./data/artifacts'),
  ARTIFACT_PUBLIC_BASE_URL: str(''),
  MAX_DOWNLOAD_BYTES: num(26_214_400),
  ALLOWED_ASSET_HOSTS: list([]),
  DELETE_ARTIFACT_AFTER_MS: num(86_400_000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('[config] Geçersiz ortam değişkenleri:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const env = parsed.data;
const resolveFromRoot = (p) => (path.isAbsolute(p) ? p : path.resolve(ROOT_DIR, p));

/**
 * Bulut tespiti: Render gibi platformlarda dosya sistemi kalıcı DEĞİLDİR.
 * - Tüm çalışma dizinleri /tmp altına alınır (yazılabilir tek yer)
 * - Bellek sınırı için tek context / tek eşzamanlı iş varsayılan olur
 * Kullanıcı env ile açıkça verirse onun değeri kazanır.
 */
const CLOUD = ['1', 'true', 'yes', 'on'].includes(String(process.env.RENDER || '').toLowerCase());
const pick = (envAdi, ayarliDeger, bulutVarsayilan) =>
  process.env[envAdi] === undefined && CLOUD ? bulutVarsayilan : ayarliDeger;

/** public config nesnesi — kod içinde `config.browser.maxContexts` gibi okunur */
export const config = {
  env: env.NODE_ENV,
  isProd: env.NODE_ENV === 'production',
  server: {
    port: env.PORT,
    host: env.HOST,
    logLevel: env.LOG_LEVEL,
    // Test ortamında pretty transport (worker thread) kapalı: süreç asılı kalmasın
    logPretty: env.NODE_ENV === 'test' ? false : env.LOG_PRETTY,
    corsOrigins: env.CORS_ORIGINS,
    apiPrefix: env.API_PREFIX,
  },
  auth: {
    enabled: env.AUTH_ENABLED,
    keys: env.API_KEYS,
  },
  browser: {
    headless: env.BROWSER_HEADLESS,
    channel: env.BROWSER_CHANNEL || undefined,
    maxContexts: pick('MAX_CONTEXTS', env.MAX_CONTEXTS, 1),
    maxPagesPerContext: env.MAX_PAGES_PER_CONTEXT,
    contextMaxAgeMs: env.CONTEXT_MAX_AGE_MS,
    browserMaxAgeMs: env.BROWSER_MAX_AGE_MS,
    persistentProfile: env.PERSISTENT_PROFILE,
    profileBaseDir: resolveFromRoot(pick('PROFILE_BASE_DIR', env.PROFILE_BASE_DIR, '/tmp/arena-proxy/profiles')),
    viewport: { width: env.VIEWPORT_WIDTH, height: env.VIEWPORT_HEIGHT },
    extraArgs: env.EXTRA_CHROMIUM_ARGS,
    blockUrlPatterns: env.BLOCK_URL_PATTERNS,
    blockFonts: env.BLOCK_FONTS,
    blockMedia: env.BLOCK_MEDIA,
    navigationTimeoutMs: env.NAVIGATION_TIMEOUT_MS,
  },
  session: {
    mode: env.SESSION_MODE,
    statePath: resolveFromRoot(env.SESSION_STATE_PATH),
    reloadIntervalMs: env.SESSION_RELOAD_INTERVAL_MS,
    // Env içinden oturum (dosya sistemi kalıcı değilse): base64 veya düz JSON
    stateB64: env.SESSION_STATE_B64.trim(),
    stateJson: env.SESSION_STATE_JSON.trim(),

    /* Ölümsüz oturum: jeton süresi dolmadan döndürülür ve kalıcı yazılır */
    cookieName: env.SESSION_COOKIE_NAME,
    keepAliveMinutes: env.SESSION_KEEPALIVE_MINUTES, // 0 → bekçi kapalı
    refreshThresholdMinutes: env.SESSION_REFRESH_THRESHOLD_MINUTES,
    refreshTimeoutMs: env.SESSION_REFRESH_TIMEOUT_MS,
    browserRefreshWaitMs: env.SESSION_BROWSER_WAIT_MS,
    httpRefreshEnabled: env.SESSION_HTTP_REFRESH,
    // 'file' | 'render' | 'file+render' | 'none'  → yeni jeton nereye yazılsın
    persist: String(env.SESSION_PERSIST || 'file+render').toLowerCase(),
    envVarName: env.SESSION_ENV_VAR_NAME,
    renderApiKey: env.RENDER_API_KEY.trim(),
    renderServiceId: env.RENDER_SERVICE_ID.trim(),
    githubToken: env.GITHUB_TOKEN.trim(),
    githubRepo: env.GITHUB_SESSION_REPO.trim(),
    githubPath: env.GITHUB_SESSION_PATH.trim(),
    githubBranch: env.GITHUB_SESSION_BRANCH.trim(),
    sonYenileme: null, // runtime: son başarılı yenileme zamanı
  },
  stealth: {
    enabled: env.STEALTH_ENABLED,
    humanize: env.HUMANIZE,
    userAgent: env.USER_AGENT,
    locale: env.LOCALE,
    timezoneId: env.TIMEZONE,
    acceptLanguage: env.ACCEPT_LANGUAGE,
  },
  proxy: {
    enabled: env.PROXY_ENABLED,
    server: env.PROXY_SERVER,
    username: env.PROXY_USERNAME,
    password: env.PROXY_PASSWORD,
    bypass: env.PROXY_BYPASS,
  },
  queue: {
    concurrency: pick('QUEUE_CONCURRENCY', env.QUEUE_CONCURRENCY, 1),
    ratePerMinute: env.QUEUE_RATE_PER_MIN,
    maxSize: env.MAX_QUEUE_SIZE,
    jobTimeoutMs: env.JOB_TIMEOUT_MS,
    waitTimeoutMs: env.QUEUE_WAIT_TIMEOUT_MS,
  },
  retry: {
    attempts: env.RETRY_ATTEMPTS,
    minTimeout: env.RETRY_MIN_TIMEOUT_MS,
    maxTimeout: env.RETRY_MAX_TIMEOUT_MS,
    on: env.RETRY_ON,
  },
  target: {
    name: env.TARGET_NAME,
    baseUrl: env.TARGET_BASE_URL.replace(/\/+$/, ''),
    generatePath: env.TARGET_GENERATE_PATH,
    selectorsPath: resolveFromRoot(env.SELECTORS_PATH),
    allowedNavHosts: env.ALLOWED_NAV_HOSTS,
    stepTimeoutMs: env.STEP_TIMEOUT_MS,
    generationTimeoutMs: env.GENERATION_TIMEOUT_MS,
    sendMode:
      env.TARGET_SEND_MODE === 'auto'
        ? (/arena\.ai/i.test(env.TARGET_BASE_URL) ? 'enter' : 'click')
        : env.TARGET_SEND_MODE,
    artifactPollIntervalMs: env.ARTIFACT_POLL_INTERVAL_MS,
    waitForDomResult: env.WAIT_FOR_DOM_RESULT,
    screenshotOnError: env.SCREENSHOT_ON_ERROR,
    screenshotDir: resolveFromRoot(pick('SCREENSHOT_DIR', env.SCREENSHOT_DIR, '/tmp/arena-proxy/screenshots')),
    dryRun: env.DRY_RUN,
  },
  artifact: {
    delivery: env.ARTIFACT_DELIVERY,
    localDir: resolveFromRoot(pick('ARTIFACT_LOCAL_DIR', env.ARTIFACT_LOCAL_DIR, '/tmp/arena-proxy/artifacts')),
    publicBaseUrl: env.ARTIFACT_PUBLIC_BASE_URL,
    maxDownloadBytes: env.MAX_DOWNLOAD_BYTES,
    allowedAssetHosts: env.ALLOWED_ASSET_HOSTS,
    deleteAfterMs: env.DELETE_ARTIFACT_AFTER_MS,
  },
};

/**
 * Süre tutarlılığı denetimi: JOB_TIMEOUT_MS tüm retry denemelerini karşılayabiliyor mu?
 *
 * Canlı hata (2026-09-16, Azure): JOB_TIMEOUT_MS=300sn + GENERATION_TIMEOUT_MS=240sn +
 * 3 deneme → 1. deneme ARTIFACT_NOT_FOUND, 2. deneme ancak ~29sn bekleyebildi,
 * iş timeout'u kalan denemeleri yarıda abort etti.
 *
 * @param {number} jobTimeoutMs  iş başına toplam süre
 * @param {{attempts?:number, generationTimeoutMs?:number, attemptOverheadMs?:number}} opts
 * @returns {string[]} boş dizi = tutarlı
 */
export function timeoutCoherenceWarnings(jobTimeoutMs = config.queue.jobTimeoutMs, {
  attempts = config.retry.attempts + 1,
  generationTimeoutMs = config.target.generationTimeoutMs,
  attemptOverheadMs = 30_000, // navigate + onay + prompt doldurma (canlı ölçüm ~15-20sn)
  fastRetryBudgetMs = 120_000, // hızlı-hata (nav/oturum) retry'ları için kalan pay
} = {}) {
  const warnings = [];
  const perAttemptMs = generationTimeoutMs + attemptOverheadMs;
  // Kural: iş süresi EN AZ 1 tam denemeyi + hızlı-hata retry paylarını karşılamalı.
  // Tam boy deneme sonrası kalan süre yetmezse queue o denemeyi zaten atlıyor
  // (doomed-retry skip); bu kontrol orantısız kombinasyonları AÇILIŞTA görünür kılar.
  const minMs = perAttemptMs + Math.max(0, attempts - 1) * fastRetryBudgetMs;
  if (jobTimeoutMs < minMs) {
    warnings.push(
      `JOB_TIMEOUT_MS (${jobTimeoutMs}ms) kısa: ~${minMs}ms+ önerilir ` +
        `(1 tam deneme ${perAttemptMs}ms + ${Math.max(0, attempts - 1)} × hızlı-hata payı ${fastRetryBudgetMs}ms). ` +
        `Süre yetmeyen denemeler atlanır → JOB_TIMEOUT_MS büyüt veya RETRY_ATTEMPTS düşür.`,
    );
  }
  return warnings;
}

/** Çalışma zamanı dizinlerini hazırla */
export function ensureRuntimeDirs() {
  const dirs = [
    path.dirname(config.session.statePath),
    path.join(ROOT_DIR, 'data', 'sessions'),
    config.artifact.localDir,
    config.target.screenshotDir,
    config.browser.profileBaseDir,
  ];
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
}

/** Başlangıçta log'lanacak, sır içermeyen özet */
export function redactedSummary() {
  return {
    env: config.env,
    port: config.server.port,
    authEnabled: config.auth.enabled && config.auth.keys.length > 0,
    maxContexts: config.browser.maxContexts,
    concurrency: config.queue.concurrency,
    sessionMode: config.session.mode,
    sessionSource: config.session.stateB64 ? 'env:SESSION_STATE_B64'
      : config.session.stateJson ? 'env:SESSION_STATE_JSON'
      : fs.existsSync(config.session.statePath) ? 'file' : 'YOK',
    cloudMode: CLOUD,
    stealth: config.stealth.enabled,
    proxy: config.proxy.enabled ? String(config.proxy.server).replace(/\/\/.*@/, '//***@') : false,
    delivery: config.artifact.delivery,
    dryRun: config.target.dryRun,
    target: config.target.baseUrl,
    timeouts: {
      jobTimeoutMs: config.queue.jobTimeoutMs,
      generationTimeoutMs: config.target.generationTimeoutMs,
      retryAttempts: config.retry.attempts,
    },
    warnings: timeoutCoherenceWarnings(),
  };
}
