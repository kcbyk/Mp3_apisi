/**
 * src/scrapers/arenaScraper.js
 * ---------------------------------------------------------------------------
 * Hedef platformun (varsayılan: Arena AI) görsel üretim arayüzünü süren DOM
 * otomasyon katmanı. Bu dosya **yalnızca tarayıcı içi işlere** odaklanır:
 * navigasyon, form doldurma, tıklama, sonuç yakalama. Kuyruk/retry/metrics
 * sorumluluğu `src/services/assetService.js`'tedir.
 *
 * Akış:
 *   navigate → consent kapat → login wall kontrolü → (gerekirse) generator'e git
 *   → aspect ratio seç → style seç → negatif prompt → prompt yaz
 *   → ArtifactCapture bağla → Generate'e tıkla → asset URL'ini yakala
 */
import fs from 'node:fs';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { resolveSelector, resolveIn } from '../utils/resilientSelector.js';
import { humanClick, humanType, humanScroll, microPause, sleep } from '../utils/humanize.js';
import { ArtifactCapture } from './artifactCapture.js';
import {
  NavigationError,
  SessionError,
  StepTimeoutError,
  ValidationError,
} from '../errors.js';

/* -------------------------------------------------------------------------- */
/*  Selector dosyası                                                          */
/* -------------------------------------------------------------------------- */
let selectorCache = null;
let selectorCachePath = null;

export function loadSelectors(force = false) {
  const p = config.target.selectorsPath;
  if (!force && selectorCache && selectorCachePath === p) return selectorCache;
  if (!fs.existsSync(p)) throw new Error(`Selector dosyası bulunamadı: ${p}`);
  selectorCache = JSON.parse(fs.readFileSync(p, 'utf8'));
  selectorCachePath = p;
  return selectorCache;
}

/* -------------------------------------------------------------------------- */
/*  Parametre doğrulama / normalizasyon                                        */
/* -------------------------------------------------------------------------- */
const RATIO_ALIASES = {
  '1:1': ['1:1', '1x1', 'square', 'kare'],
  '16:9': ['16:9', '16x9', 'landscape', 'yatay'],
  '9:16': ['9:16', '9x16', 'portrait', 'vertical', 'dikey'],
  '4:3': ['4:3', '4x3'],
  '3:4': ['3:4', '3x4'],
  '3:2': ['3:2', '3x2'],
  '2:3': ['2:3', '2x3'],
  '21:9': ['21:9', '21x9', 'cinematic', 'ultrawide'],
};

/**
 * Parametreleri normalize eder. İdempotenttir: hem snake_case (REST gövdesi)
 * hem camelCase (dahili/normalize edilmiş nesne) anahtarlarını kabul eder —
 * böylece aynı nesne iki kez normalize edilse bile değer kaybolmaz.
 */
export function normalizeParams(input = {}) {
  const prompt = String(input.prompt ?? '').trim();
  if (!prompt) throw new ValidationError('`prompt` zorunludur ve boş olamaz.');
  if (prompt.length > 4000) throw new ValidationError('`prompt` 4000 karakterden uzun olamaz.');

  const negativePrompt = String(input.negative_prompt ?? input.negativePrompt ?? '').trim().slice(0, 2000);
  const style = String(input.style ?? '').trim().slice(0, 120);

  let aspectRatio = String(input.aspect_ratio ?? input.aspectRatio ?? '1:1').trim();
  const foundRatio = Object.entries(RATIO_ALIASES).find(([, aliases]) =>
    aliases.includes(aspectRatio.toLowerCase()),
  );
  aspectRatio = foundRatio ? foundRatio[0] : aspectRatio;
  if (!/^\d{1,2}:\d{1,2}$/.test(aspectRatio)) {
    throw new ValidationError(`Geçersiz aspect_ratio: "${aspectRatio}". Beklenen format 16:9 gibi ya da 1.0.`);
  }

  const count = Math.min(Math.max(Number(input.count ?? 1) || 1, 1), 4);

  return { prompt, negativePrompt, style, aspectRatio, count };
}

/* -------------------------------------------------------------------------- */
/*  Akış adımları (küçük, tekrar kullanılabilir yardımcılar)                   */
/* -------------------------------------------------------------------------- */

async function gotoWithChallengeCheck(page, url, { signal } = {}) {
  if (signal?.aborted) throw signal.reason;
  const selectors = loadSelectors();

  let response;
  try {
    response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: config.browser.navigationTimeoutMs,
      referer: config.target.baseUrl + '/',
    });
  } catch (err) {
    throw new NavigationError(`Navigasyon başarısız: ${url} — ${err.message}`, { url, err: err.message });
  }

  const status = response?.status() ?? 0;
  if (status >= 400) {
    throw new NavigationError(`Hedef HTTP ${status} döndü.`, { url, status });
  }

  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

  // Cloudflare / Turnstile challenge kontrolü
  const challenge = await resolveSelector(page, selectors.challengeIndicators, {
    key: 'challengeIndicators',
    timeout: 1200,
    waitFor: false,
    optional: true,
  });
  if (challenge) {
    logger.warn('bot challenge sayfası algılandı — görünmez challenge için bekleniyor');
    // Interstisyel challenge genelde 3-8 sn içinde kendiliğinden çözülür (stealth ile)
    await sleep(6000);
    await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});
    const stillThere = await resolveSelector(page, selectors.challengeIndicators, {
      key: 'challengeIndicators:recheck',
      timeout: 800,
      waitFor: false,
      optional: true,
    });
    if (stillThere) {
      throw new NavigationError(
        'Bot koruması aşılamadı (challenge ekranı çözülmedi). Stealth/proxy/session ayarlarını gözden geçirin.',
        { url },
      );
    }
  }
  return response;
}

async function dismissConsent(page) {
  const selectors = loadSelectors();
  const btn = await resolveSelector(page, selectors.consentBanner, {
    key: 'consentBanner',
    timeout: 1500,
    waitFor: false,
    optional: true,
  });
  if (btn) {
    await humanClick(btn).catch(() => {});
    await microPause(0.5);
  }
}

async function assertSessionValid(page) {
  const selectors = loadSelectors();
  const wall = await resolveSelector(page, selectors.loginWall, {
    key: 'loginWall',
    timeout: 1200,
    waitFor: false,
    optional: true,
  });
  if (wall) {
    throw new SessionError(
      'Hedef platform oturum istiyor (login wall). Session dosyanızı yenileyin: npm run session:save → SESSION_GUIDE.md',
      { detected: true },
    );
  }
}

async function ensureGeneratorOpen(page) {
  const selectors = loadSelectors();
  // Zaten prompt alanı var mı?
  const existing = await resolveSelector(page, selectors.promptInput, {
    key: 'promptInput:probe',
    timeout: 2000,
    waitFor: false,
    optional: true,
  });
  if (existing) return;

  const nav = await resolveSelector(page, selectors.navToGenerator, {
    key: 'navToGenerator',
    timeout: 3000,
    waitFor: false,
    optional: true,
  });
  if (nav) {
    await humanClick(nav).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});
  } else if (config.target.generatePath && config.target.generatePath !== '/') {
    await gotoWithChallengeCheck(page, `${config.target.baseUrl}${config.target.generatePath}`);
  } else {
    throw new StepTimeoutError('prompt_input', config.target.stepTimeoutMs, {
      reason: 'Prompt alanı bulunamadı ve generator navigasyonu tespit edilemedi',
    });
  }
}

/**
 * Native <select> için akıllı seçim: önce mevcut <option>'ları okur (kısa
 * timeout), sonra eşleşmeyi bulup seçer. Playwright'ın selectOption'ı
 * eşleşme bulamazsa varsayılan timeout kadar bekler — bu yüzden asla
 * doğrudan çağrılmaz (20 sn'lik gereksiz bekleme).
 */
async function selectFromNativeSelect(select, desired, { timeout = 1500 } = {}) {
  let options = [];
  try {
    options = await select.evaluate(
      (el) => [...el.options].map((o) => ({ value: o.value, label: (o.label || o.text || '').trim() })),
      null,
      { timeout },
    );
  } catch {
    return null;
  }
  const want = String(desired).trim().toLowerCase();
  const exotic = options.find((o) => o.value.toLowerCase() === want || o.label.toLowerCase() === want);
  const fuzzy = options.find((o) => o.value.toLowerCase().includes(want) || o.label.toLowerCase().includes(want));
  const match = exotic ?? fuzzy;
  if (!match) return null;
  try {
    await select.selectOption(match.value, { timeout });
    return `${match.label || match.value}`;
  } catch {
    return null;
  }
}

/** Aspect ratio: <select> ya da buton grubu ya da dropdown olabilir */
async function selectAspectRatio(page, aspectRatio) {
  const selectors = loadSelectors();

  // 1) Native <select>
  const select = await resolveSelector(page, selectors.aspectRatioSelect, {
    key: 'aspectRatioSelect',
    timeout: 1500,
    waitFor: false,
    optional: true,
  });
  if (select) {
    for (const candidate of [aspectRatio, ...(RATIO_ALIASES[aspectRatio] ?? [])]) {
      const applied = await selectFromNativeSelect(select, candidate);
      if (applied) return `select:${applied}`;
    }
  }

  // 2) Buton / radio grubu
  const buttons = await resolveSelector(page, selectors.aspectRatioButtons, {
    key: 'aspectRatioButtons',
    timeout: 1500,
    waitFor: false,
    optional: true,
  });
  if (buttons) {
    const count = await buttons.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const el = buttons.nth(i);
      const label = ((await el.innerText().catch(() => '')) || (await el.getAttribute('aria-label').catch(() => '')) || '').trim();
      if (RATIO_ALIASES[aspectRatio]?.some((a) => label.toLowerCase().includes(a))) {
        await humanClick(el);
        return `radio:${label}`;
      }
    }
  }

  // 3) Dropdown trigger + option
  const trigger = await resolveSelector(page, selectors.aspectRatioDropdownTrigger, {
    key: 'aspectRatioDropdownTrigger',
    timeout: 1200,
    waitFor: false,
    optional: true,
  });
  if (trigger) {
    await humanClick(trigger);
    const option = await resolveSelector(page, selectors.dropdownOption, {
      key: 'ratioOption',
      timeout: 2500,
      vars: { option: aspectRatio },
      optional: true,
      waitFor: false,
    });
    if (option) {
      await humanClick(option);
      return `dropdown:${aspectRatio}`;
    }
  }

  logger.warn({ aspectRatio }, 'aspect ratio uygulanamadı — platform varsayılanı kullanılacak (opsiyonel adım)');
  return null;
}

async function selectStyle(page, style) {
  if (!style) return null;
  const selectors = loadSelectors();

  const select = await resolveSelector(page, selectors.styleSelect, {
    key: 'styleSelect',
    timeout: 1500,
    waitFor: false,
    optional: true,
  });
  if (select) {
    const applied = await selectFromNativeSelect(select, style);
    if (applied) return `select:${applied}`;
    logger.warn({ style }, 'style <select> içinde bulunamadı — dropdown deneniyor');
  }

  const trigger = await resolveSelector(page, selectors.styleDropdownTrigger, {
    key: 'styleDropdownTrigger',
    timeout: 1500,
    waitFor: false,
    optional: true,
  });
  if (trigger) {
    await humanClick(trigger);
    const option = await resolveSelector(page, selectors.dropdownOption, {
      key: 'styleOption',
      timeout: 2500,
      vars: { option: style },
      waitFor: false,
      optional: true,
    });
    if (option) {
      await humanClick(option);
      return `dropdown:${style}`;
    }
  }

  logger.warn({ style }, 'style uygulanamadı — platform varsayılanı kullanılacak (opsiyonel adım)');
  return null;
}

async function fillPrompts(page, { prompt, negativePrompt }) {
  const selectors = loadSelectors();

  const promptEl = await resolveSelector(page, selectors.promptInput, {
    key: 'promptInput',
    timeout: config.target.stepTimeoutMs,
  });
  await humanType(promptEl, prompt);

  let negativeApplied = null;
  if (negativePrompt) {
    let negEl = await resolveSelector(page, selectors.negativePromptInput, {
      key: 'negativePromptInput',
      timeout: 1200,
      waitFor: false,
      optional: true,
    });
    if (!negEl) {
      const toggle = await resolveSelector(page, selectors.negativePromptToggle, {
        key: 'negativePromptToggle',
        timeout: 1200,
        waitFor: false,
        optional: true,
      });
      if (toggle) {
        await humanClick(toggle);
        await microPause(0.4);
        negEl = await resolveSelector(page, selectors.negativePromptInput, {
          key: 'negativePromptInput:afterToggle',
          timeout: 2500,
          waitFor: false,
          optional: true,
        });
      }
    }
    if (negEl) {
      await humanType(negEl, negativePrompt);
      negativeApplied = true;
    } else {
      logger.warn('negative_prompt alanı bu platformda bulunamadı — yoksayıldı');
      negativeApplied = false;
    }
  }
  return { negativeApplied };
}

async function clickGenerate(page) {
  const selectors = loadSelectors();
  const btn = await resolveSelector(page, selectors.generateButton, {
    key: 'generateButton',
    timeout: config.target.stepTimeoutMs,
  });

  // Buton disabled olabilir (prompt henüz React state'ine işlenmemiş)
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const disabled = await btn.isDisabled().catch(() => false);
    if (!disabled) break;
    await sleep(250);
  }
  await humanScroll(page, { steps: 1 });
  await humanClick(btn);
  return btn;
}

async function saveErrorScreenshot(page, taskId, label = 'error') {
  if (!config.target.screenshotOnError) return null;
  try {
    fs.mkdirSync(config.target.screenshotDir, { recursive: true });
    const file = `${config.target.screenshotDir}/${new Date().toISOString().replace(/[:.]/g, '-')}_${taskId}_${label}.png`;
    await page.screenshot({ path: file, fullPage: false, timeout: 10_000 });
    return file;
  } catch {
    return null;
  }
}

/** İsteğe bağlı: trace kaydı hata ayıklama için (yalnızca DEBUG_TRACE=true iken) */
async function maybeStartTrace(context, taskId) {
  if (process.env.DEBUG_TRACE !== 'true') return null;
  try {
    const dir = `${config.target.screenshotDir}/../traces`;
    fs.mkdirSync(dir, { recursive: true });
    return await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  Ana akış                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Tek bir üretim işini hedef platformda çalıştırır.
 *
 * @param {{page: import('playwright').Page, context: import('playwright').Context}} ctx
 * @param {object} params  doğrulanmamış ham parametreler (normalizeParams uygulanır)
 * @param {{signal?:AbortSignal, taskId?:string, onProgress?:Function}} opts
 * @returns {Promise<{artifact:{url,source,score,reasons}, capture:object, meta:object}>}
 */
export async function runGeneration({ page, context }, params, { signal, taskId = 'anon', onProgress } = {}) {
  const t0 = Date.now();
  const log = logger.child({ mod: 'arenaScraper', taskId });
  const selectors = loadSelectors();
  const norm = normalizeParams(params);
  const steps = {};

  const step = async (name, fn) => {
    const s = Date.now();
    const result = await fn();
    steps[name] = Date.now() - s;
    onProgress?.({ step: name, ms: steps[name] });
    log.debug({ step: name, ms: steps[name] }, 'adım tamamlandı');
    return result;
  };

  // 0) DRY_RUN: tarayıcıya hiç dokunmadan şemayı doğrula (CI / demo)
  if (config.target.dryRun) {
    return dryRunResult(norm, taskId, t0);
  }

  const trace = await maybeStartTrace(context, taskId);
  const capture = new ArtifactCapture(page, { taskId });

  try {
    // 1) Navigasyon + oturum kontrolü
    await step('navigate', () => gotoWithChallengeCheck(page, `${config.target.baseUrl}${config.target.generatePath}`));
    await step('consent', () => dismissConsent(page));
    await step('session_check', () => assertSessionValid(page));
    await step('open_generator', () => ensureGeneratorOpen(page));

    // 2) Parametreler
    await step('aspect_ratio', async () => {
      const applied = await selectAspectRatio(page, norm.aspectRatio);
      return applied;
    });
    await step('style', () => selectStyle(page, norm.style));
    await step('prompts', () => fillPrompts(page, norm));

    // 3) Yakalamayı başlat + baseline
    capture.attach();
    capture.markBaseline();

    await step('click_generate', () => clickGenerate(page));

    // 4) Üretim tamamlanmasını bekle + asset URL'ini yakala
    const candidate = await step('capture_artifact', () =>
      capture.waitForArtifact({
        timeoutMs: config.target.generationTimeoutMs,
        pollIntervalMs: config.target.artifactPollIntervalMs,
        signal,
      }),
    );

    if (trace) {
      await context.tracing.stop({ path: `${config.target.screenshotDir}/../traces/${taskId}.zip` }).catch(() => {});
    }

    return {
      captureCandidate: candidate,
      meta: {
        task_id: taskId,
        elapsed_ms: Date.now() - t0,
        steps,
        page_url: page.url(),
        normalized_params: { ...norm, prompt: `${norm.prompt.slice(0, 60)}${norm.prompt.length > 60 ? '…' : ''}` },
        candidates: capture.top(5).map((c) => ({ url: c.url.slice(0, 160), score: c.score, source: c.source })),
        ws_frames: capture.wsFrames,
        json_hits: capture.jsonHits.length,
      },
    };
  } catch (err) {
    const shot = await saveErrorScreenshot(page, taskId, err.code || err.name || 'error');
    if (shot) log.warn({ screenshot: shot }, 'hata ekran görüntüsü kaydedildi');
    err.details = { ...(err.details || {}), steps, screenshot: shot, page_url: page.url() };
    throw err;
  } finally {
    capture.detach();
  }
}

/** DRY_RUN çıktısı: gerçek bir fixture görseli döndürür, tarayıcı açmaz */
function dryRunResult(norm, taskId, t0) {
  const fixtureDir = `${config.target.screenshotDir}/../fixtures`;
  const fixture = `${fixtureDir}/sample.png`;
  const base = config.artifact.publicBaseUrl || `http://localhost:${config.server.port}`;
  const url = fs.existsSync(fixture)
    ? `${base}/files/fixtures/sample.png`
    : `data:image/svg+xml;base64,${Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="100%" height="100%" fill="#0f172a"/><text x="50%" y="50%" fill="#38bdf8" font-family="sans-serif" font-size="20" text-anchor="middle">DRY_RUN</text></svg>`,
      ).toString('base64')}`;

  return {
    captureCandidate: {
      url,
      source: 'dry-run:fixture',
      score: 99,
      reasons: ['dry_run'],
      dry_run: true,
    },
    meta: {
      task_id: taskId,
      dry_run: true,
      elapsed_ms: Date.now() - t0,
      steps: { dry_run: Date.now() - t0 },
      normalized_params: { ...norm, prompt: `${norm.prompt.slice(0, 60)}…` },
      note: 'DRY_RUN=true: tarayıcı açılmadı, fixture görsel döndürüldü.',
    },
  };
}

export { saveErrorScreenshot, gotoWithChallengeCheck, dismissConsent, assertSessionValid, ensureGeneratorOpen };
