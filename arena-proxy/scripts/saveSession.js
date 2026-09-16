#!/usr/bin/env node
/**
 * scripts/saveSession.js
 * ---------------------------------------------------------------------------
 * İnteraktif oturum kaydedici: görünür bir Chromium açar, sen hedef platforma
 * normal şekilde giriş yaparsın, Enter'a bastığında cookie + localStorage
 * `data/sessions/<target>.json` (Playwright storageState) olarak yazılır.
 *
 * Kullanım:
 *   npm run session:save                       # .env'deki TARGET_BASE_URL
 *   node scripts/saveSession.js https://arena.ai --out data/sessions/arena.json
 *   node scripts/saveSession.js --wait 0       # otomatik kapanma yok, sen bitir
 *
 * Bayraklar:
 *   --out <path>     Çıktı dosyası (varsayılan: .env → SESSION_STATE_PATH)
 *   --url <url>      Giriş yapılacak adres
 *   --check          Kaydetmeden önce oturumu doğrula (login wall kontrolü)
 *   --headless       Görünmez mod (yalnızca cookie'leri başka yolla aldıysan anlamlı)
 *   --profile        storageState yerine kalıcı Chrome profili kullan (PERSISTENT_PROFILE)
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { chromium } from 'playwright';
import { config, ensureRuntimeDirs, ROOT_DIR } from '../src/config/index.js';
import { logger } from '../src/utils/logger.js';

const log = logger.child({ mod: 'saveSession' });

function parseArgs(argv) {
  const args = { url: process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : config.target.baseUrl };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--url') args.url = argv[++i];
    else if (a === '--wait') args.wait = Number(argv[++i]);
    else if (a === '--profile') args.profile = true;
    else if (a === '--headless') args.headless = true;
    else if (a === '--check') args.check = true;
  }
  args.out = args.out || config.session.statePath;
  args.wait = Number.isFinite(args.wait) ? args.wait : 0; // 0 = Enter bekle
  return args;
}

const waitForEnter = async (message) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((resolve) => rl.question(message, resolve));
  rl.close();
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  ensureRuntimeDirs();
  fs.mkdirSync(path.dirname(args.out), { recursive: true });

  const profileDir = path.join(ROOT_DIR, 'data', 'profiles', 'interactive');
  const useProfile = args.profile || config.browser.persistentProfile;

  // NOT: Kaydetme akışında stealth şart değil; gerçek kullanıcı gibi davrandığın için
  // tespit riski zaten düşük. Yine de UA tutarlılığı için aynı ayarları kullanıyoruz.
  const launchOpts = {
    headless: args.headless ?? !process.env.DISPLAY ? false : config.browser.headless,
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--start-maximized'],
    viewport: null,
    locale: config.stealth.locale,
    timezoneId: config.stealth.timezoneId,
    userAgent: config.stealth.userAgent,
    acceptDownloads: true,
    ...(config.proxy.enabled && config.proxy.server
      ? { proxy: { server: config.proxy.server, username: config.proxy.username, password: config.proxy.password } }
      : {}),
  };

  let browser;
  let context;

  if (useProfile) {
    fs.mkdirSync(profileDir, { recursive: true });
    log.info({ profileDir }, 'kalıcı profil modunda açılıyor (cookie\'ler bu dizinde saklanır)');
    context = await chromium.launchPersistentContext(profileDir, launchOpts);
    browser = context.browser();
  } else {
    browser = await chromium.launch({ ...launchOpts });
    context = await browser.newContext({
      locale: launchOpts.locale,
      timezoneId: launchOpts.timezoneId,
      userAgent: launchOpts.userAgent,
      viewport: { width: 1440, height: 900 },
    });
  }

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch((e) => log.warn(e.message));

  console.log(`
──────────────────────────────────────────────────────────────
 1) Açılan pencerede platforma NORMAL şekilde giriş yap
    (kullanıcı adı/şifre, OAuth, e-posta linki — fark etmez)
 2) Giriş sonrası ana sayfaya geldiğinden emin ol
 3) Bu terminale dön ve ENTER'a bas
${args.wait ? `   (${args.wait} sn sonra otomatik kaydedilecek)\n` : ''}──────────────────────────────────────────────────────────────`);

  if (args.wait) await new Promise((r) => setTimeout(r, args.wait * 1000));
  else await waitForEnter('\n▶ Girişi tamamladıysanız ENTER: ');

  if (args.check) {
    const text = await page.evaluate(() => document.body.innerText.slice(0, 4000).toLowerCase());
    const looksLoggedOut = /sign in|log in|giriş yap|create account/.test(text) && text.length < 3000;
    if (looksLoggedOut) log.warn('Sayfa hâlâ giriş istiyor gibi görünüyor — yine de kaydediliyor.');
  }

  if (useProfile) {
    await context.close();
    log.info({ profileDir }, 'kalıcı profil kaydedildi. .env → PERSISTENT_PROFILE=true ve SESSION_MODE=profile');
    return;
  }

  const state = await context.storageState({ path: args.out });
  fs.writeFileSync(args.out, JSON.stringify(state, null, 2), { mode: 0o600 });

  const cookieNames = state.cookies.map((c) => c.name);
  const sessionish = cookieNames.filter((n) => /session|auth|token|jwt|sid|cf_clearance|csrftoken|access/i.test(n));

  log.info(
    {
      out: args.out,
      cookies: state.cookies.length,
      origins: state.origins.length,
      session_cookie_candidates: sessionish.slice(0, 12),
    },
    'oturum kaydedildi (dosya izni 600)',
  );

  if (!sessionish.length) {
    log.warn('Oturum benzeri cookie bulunamadı. Login gerçekten tamamlandı mı?');
  }
  if (!cookieNames.includes('cf_clearance')) {
    log.debug('cf_clearance yok: Cloudflare challenge henüz görülmemiş olabilir (şart değil).');
  }

  console.log(`
✅ Kaydedildi: ${args.out}
   Cookie sayısı        : ${state.cookies.length}
   localStorage origin  : ${state.origins.length}
   Oturum cookie adayları: ${sessionish.join(', ') || '(yok)'}

⚠️  UYARI: cf_clearance gibi cookie'ler IP + User-Agent'a bağlıdır.
   Üretimde (server) aynı UA ve mümkünse aynı/a yakın IP kullanın; aksi halde
   platform oturumu düşürür. UA ayarı: .env → USER_AGENT
   Şimdi servisi başlatın: npm start
`);
  await context.close();
  await browser.close().catch(() => {});
}

main().catch((err) => {
  log.error({ err: err.message }, 'session kaydetme başarısız');
  process.exit(1);
});
