/**
 * src/routes/generateRoutes.js
 * Üretim uçları: senkron (tek istek → görsel) ve asenkron (job kuyruğu) mod.
 */
import { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config, ROOT_DIR } from '../config/index.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { generateAsset, selectorStats } from '../services/assetService.js';
import { tarayiciCerezleriniYakala } from '../automation/sessionRefresh.js';
import { browserManager } from '../automation/browserManager.js';
import { sessionStore, normalizeStorageState } from '../automation/sessionStore.js';
import { oturumDurumu, oturumuYenile } from '../automation/sessionRefresh.js';
import {
  loadSelectors,
  gotoWithChallengeCheck,
  dismissConsent,
  girisDuvariniTespit,
  cerezTercihDiyaloguAcikMi,
} from '../scrapers/arenaScraper.js';
import { AppError, ValidationError } from '../errors.js';
import { logger } from '../utils/logger.js';
import { jobStore } from '../services/jobStore.js';

const router = Router();
const log = logger.child({ mod: 'routes' });

/* ------------------------------- Şema ------------------------------------ */
const generateSchema = z.object({
  prompt: z.string().min(1, 'prompt zorunludur').max(4000),
  negative_prompt: z.string().max(2000).optional().default(''),
  aspect_ratio: z
    .string()
    .regex(/^\d{1,2}[:x]\d{1,2}$|^\d+(\.\d+)?$/, 'aspect_ratio "16:9" veya 1.0 biçiminde olmalı')
    .optional()
    .default('1:1'),
  style: z.string().max(120).optional().default(''),
  count: z.number().int().min(1).max(4).optional().default(1),
  async: z.boolean().optional().default(false),
  callback_url: z.string().url().optional(),
  delivery: z.enum(['url', 'base64', 'file', 'both']).optional(),
}).strict();

/* ------------------------ POST /generate-asset ---------------------------- */
router.post(
  '/generate-asset',
  asyncHandler(async (req, res) => {
    const parsed = generateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ValidationError('İstek gövdesi geçersiz.', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    // `delivery` istek bazlı override olarak params içinde taşınır (global config mutasyona uğramaz)
    const { async: asAsync, callback_url, ...params } = parsed.data;
    const requestId = req.id || crypto.randomUUID();

    if (asAsync) {
      const job = jobStore.create({ request_id: requestId, params });
      // Arka planda çalıştır; istemci /jobs/:id ile yoklar veya callback alır.
      generateAsset(params, { requestId })
        .then(async (result) => {
          jobStore.complete(job.id, result);
          if (callback_url) await jobStore.fireCallback(callback_url, { job_id: job.id, result });
        })
        .catch(async (err) => {
          jobStore.fail(job.id, { code: err.code, message: err.message });
          if (callback_url) await jobStore.fireCallback(callback_url, { job_id: job.id, error: { code: err.code, message: err.message } });
        });

      return res.status(202).json({
        success: true,
        job_id: job.id,
        status: 'queued',
        poll_url: `${config.server.apiPrefix}/jobs/${job.id}`,
        queue_position: job.queue_position,
      });
    }

    const result = await generateAsset(params, { requestId });
    res.status(200).json(result);
  }),
);

/* --------------------------- GET /jobs/:id -------------------------------- */
router.get(
  '/jobs/:id',
  asyncHandler(async (req, res) => {
    const job = jobStore.get(req.params.id);
    if (!job) throw new AppError('İş bulunamadı (veya TTL doldu).', { code: 'JOB_NOT_FOUND', httpStatus: 404 });
    res.json({
      success: job.status !== 'failed',
      job_id: job.id,
      status: job.status,
      created_at: job.created_at,
      updated_at: job.updated_at,
      result: job.result ?? null,
      error: job.error ?? null,
    });
  }),
);

/* --------------------------- DELETE /jobs/:id ----------------------------- */
router.delete(
  '/jobs/:id',
  asyncHandler(async (req, res) => {
    const deleted = jobStore.delete(req.params.id);
    res.json({ success: deleted, job_id: req.params.id, status: deleted ? 'deleted' : 'not_found' });
  }),
);

/* ------------------- GET /debug/screenshot (son hata görüntüsü) ----------- */
/**
 * Canlıda hata ayıklama: konteynerdeki en yeni ekran görüntüsünü base64 döner.
 * API anahtarı gerektirir (diğer uçlarla aynı middleware).
 * Kullanım: GET /api/v1/debug/screenshot            → en yeni
 *           GET /api/v1/debug/screenshot?n=2        → sondan 2.
 */
router.get(
  '/debug/screenshot',
  asyncHandler(async (req, res) => {
    const n = Math.max(1, Math.min(20, Number(req.query.n) || 1));
    const dir =
      config.target?.screenshotDir || config.paths?.screenshotDir || path.join(ROOT_DIR, 'data', 'screenshots');
    let dosyalar = [];
    try {
      dosyalar = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.png'))
        .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
    } catch {
      /* dizin yok */
    }
    if (!dosyalar.length) return res.json({ success: true, dosya: null, adet: 0 });
    const sec = dosyalar[Math.min(n - 1, dosyalar.length - 1)];
    const tam = path.join(dir, sec.f);
    const buf = fs.readFileSync(tam);
    res.json({
      success: true,
      adet: dosyalar.length,
      dosya: sec.f,
      zaman: new Date(sec.t).toISOString(),
      boyut: buf.length,
      image_base64: buf.toString('base64'),
      dosyalar: dosyalar.slice(0, 10).map((d) => d.f),
    });
  }),
);

/* ------------------- POST /debug/probe (canlı DOM teşhisi) ---------------- */
/**
 * Hedef sayfayı gerçek tarayıcıyla açar, seçicilerin eşleşme durumunu,
 * giriş duvarını, modal/uyarı katmanlarını ve gönderim adımını raporlar.
 * Gövde: { gonder?: boolean, prompt?: string }  (varsayılan: yalnızca incele)
 */
function adayCoz(page, aday) {
  const { by, value, name, role, nth } = aday;
  if (by === 'css') return nth === -1 ? page.locator(value).last() : page.locator(value).nth(nth ?? 0);
  if (by === 'testid') return page.getByTestId(value).nth(nth ?? 0);
  if (by === 'text') return page.getByText(value, { exact: false }).nth(nth ?? 0);
  if (by === 'role') return page.getByRole(role, name ? { name } : {}).nth(nth ?? 0);
  return page.locator(value ?? 'body');
}

async function grupIncele(page, grup, ad) {
  const cikti = [];
  for (let i = 0; i < (grup ?? []).length; i += 1) {
    const aday = grup[i];
    try {
      const l = adayCoz(page, aday);
      const adet = await l.count();
      if (!adet) continue;
      const gorunur = await l.first().isVisible().catch(() => false);
      const kapali = await l.first().isDisabled?.().catch(() => false);
      cikti.push({ aday: i, secici: aday.value ?? `${aday.by}:${aday.role ?? ''}${aday.name ? ':' + aday.name : ''}`, adet, gorunur, kapali });
    } catch {
      /* eşleşmedi */
    }
  }
  return { [ad]: cikti };
}

router.post(
  '/debug/probe',
  asyncHandler(async (req, res) => {
    const gonder = Boolean(req.body?.gonder);
    const prompt = String(req.body?.prompt ?? 'test görseli');
    const kiralama = await browserManager.acquirePage({ taskId: 'probe' });
    const rapor = { gonder, prompt };
    const konsol = [];
    const sayfaHatalari = [];
    try {
      const page = kiralama.page;
      page.on('console', (m) => {
        if (['error', 'warning'].includes(m.type()) && konsol.length < 25) konsol.push(`${m.type()}: ${String(m.text()).slice(0, 200)}`);
      });
      page.on('pageerror', (e) => sayfaHatalari.length < 10 && sayfaHatalari.push(String(e.message).slice(0, 200)));

      const hedef = `${config.target.baseUrl}${config.target.generatePath || '/'}`;
      const yanit = await page.goto(hedef, { waitUntil: 'domcontentloaded', timeout: config.browser.navigationTimeoutMs }).catch((e) => ({ durumHatasi: String(e.message).slice(0, 120) }));
      rapor.http = yanit?.status?.() ?? null;
      rapor.hedef = hedef;
      const cerezOnce = new Set((await page.context().cookies()).map((c) => c.name));
      await page.waitForTimeout(4000);
      rapor.cerezModaliIlk = await cerezTercihDiyaloguAcikMi(page).catch(() => null);
      await dismissConsent(page).catch(() => {});
      rapor.cerezModaliSonra = await cerezTercihDiyaloguAcikMi(page).catch(() => null);
      // Onay/yenileme izleri: hangi çerez/localStorage anahtarı doğdu? (değer yok, sadece ad)
      rapor.cerezIzi = {
        yeniCerezler: (await page.context().cookies()).map((c) => c.name).filter((n) => !cerezOnce.has(n)),
        localStorageAnahtarlari: await page
          .evaluate(() => Object.keys(window.localStorage || {}).slice(0, 20))
          .catch(() => []),
      };
      rapor.url = page.url();
      rapor.girisDuvari = await girisDuvariniTespit(page).catch((e) => `hata: ${String(e.message).slice(0, 80)}`);

      const sel = loadSelectors();
      const gruplar = ['promptInput', 'generateButton', 'aspectRatioButtons', 'aspectRatioDropdownTrigger', 'challengeIndicators', 'consentBanner'];
      rapor.eslesme = Object.assign({}, ...(await Promise.all(gruplar.map((g) => grupIncele(page, sel[g], g)))));

      // Görünür metin + katmanlar
      rapor.metin = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 400);
      rapor.katmanlar = await page
        .locator("[role='dialog'], [data-state='open'], [class*='modal' i], [class*='overlay' i]")
        .evaluateAll((dlar) => dlar.slice(0, 8).map((d) => ({ etiket: d.getAttribute('role') || d.className?.toString?.().slice(0, 60) || '', metin: (d.innerText || '').replace(/\s+/g, ' ').slice(0, 120), gorunur: d.offsetParent !== null })))
        .catch(() => []);

      if (gonder) {
        const girdi = await page.locator("textarea[placeholder^='Describe the image'], textarea[placeholder*='Describe the image']").first();
        rapor.girdiVar = await girdi.count();
        await girdi.fill(prompt).catch((e) => (rapor.doldurmaHatasi = String(e.message).slice(0, 120)));
        await page.waitForTimeout(800);
        rapor.girdiSonrakiDeger = await girdi.inputValue().catch(() => null);
        const btn = page.locator("button[aria-label='Send message']").first();
        rapor.butonAdet = await btn.count();
        rapor.butonKapali = await btn.isDisabled().catch(() => null);
        rapor.butonKutu = await btn.boundingBox().catch(() => null);
        // Katman var mı? (tıklamayı emen görünmez katmanlar dahil)
        rapor.katmanUstte = await page
          .evaluate(() => {
            const b = document.querySelector("button[aria-label='Send message']");
            if (!b) return null;
            const r = b.getBoundingClientRect();
            const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            return { ust: el ? `${el.tagName}.${String(el.className).slice(0, 60)}` : null, ayni: el === b || b.contains(el) };
          })
          .catch(() => null);

        const gonderildi = async () => {
          const v = await girdi.inputValue().catch(() => null);
          const govde = await page.locator('body').innerText().catch(() => '');
          return { girdiBos: v === '', girdiDeger: v, uretiyor: /Generating|Creating|Rendering/i.test(govde), url: page.url() };
        };
        const denemeler = [];
        const dene = async (ad, fn) => {
          const once = page.url();
          await fn().catch((e) => denemeler.push({ ad, hata: String(e.message).slice(0, 90) }));
          await page.waitForTimeout(2500);
          const durum = await gonderildi();
          denemeler.push({ ad, ...durum, urlDegisti: page.url() !== once });
          return durum.girdiBos || durum.urlDegisti || durum.uretiyor;
        };

        // 1) Enter
        if (!(await dene('enter', async () => { await girdi.focus(); await page.keyboard.press('Enter'); }))) {
          // 2) gönder düğmesine normal tıklama
          if (!(await dene('buton-click', async () => { await btn.click({ timeout: 8000 }); }))) {
            // 3) DOM click (katman pointer'ı emiyorsa)
            if (!(await dene('js-click', async () => { await page.evaluate(() => document.querySelector("button[aria-label='Send message']")?.click()); }))) {
              // 4) metin alanına tıkla + Enter (düğme yerine klavye)
              if (!(await dene('click+enter', async () => { await girdi.click({ timeout: 5000 }); await page.keyboard.press('Enter'); }))) {
                await dene('ctrl+enter', async () => { await girdi.focus(); await page.keyboard.press('Control+Enter'); });
              }
            }
          }
        }
        rapor.gonderimDenemeleri = denemeler;
        rapor.enterSonrasiGirdi = (await girdi.inputValue().catch(() => null));
        rapor.enterSonrasiGenerating = await grupIncele(page, loadSelectors().generatingIndicator, 'generatingIndicator');
        await page.waitForTimeout(4000);
        rapor.sonUrl = page.url();
        rapor.sonMetin = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
      }

      const png = await page.screenshot({ type: 'jpeg', quality: 60, fullPage: false }).catch(() => null);
      if (png) rapor.screenshot_base64 = Buffer.from(png).toString('base64');
      rapor.konsol = konsol;
      rapor.sayfaHatalari = sayfaHatalari;
      // Onay (cookie-preferences) ve varsa döndürülmüş jetonları kalıcılaştır
      await tarayiciCerezleriniYakala(kiralama.context, { neden: 'prob' }).catch(() => {});
      res.json({ success: true, rapor });
    } finally {
      await kiralama.release({ ok: true });
    }
  }),
);

/* ------------------------- GET /debug/selectors --------------------------- */

router.get(
  '/debug/selectors',
  asyncHandler(async (req, res) => {
    const { stats } = selectorStats();
    res.json({ success: true, path: config.target.selectorsPath, hits: stats, healthy: stats.length > 0 });
  }),
);

/* --------------------- GET /debug/session-preview ------------------------- */
/** Session dosyasının şema önizlemesi (cookie DEĞERLERİ maskelenir) */
router.get(
  '/debug/session-preview',
  asyncHandler(async (req, res) => {
    const state = sessionStore.get(false);
    res.json({
      success: true,
      version: sessionStore.version,
      oturum: oturumDurumu(),
      cookies: state.cookies.map((c) => ({
        name: c.name,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite,
        expires_in_s: c.expires === -1 ? null : c.expires - Math.floor(Date.now() / 1000),
        value_preview: `${String(c.value).slice(0, 4)}***${String(c.value).slice(-2)} (${String(c.value).length} char)`,
      })),
      origins: state.origins.map((o) => ({ origin: o.origin, localStorage_keys: o.localStorage.map((i) => i.name) })),
    });
  }),
);

/* ---------------------- POST /session-yenile (jeton döndür) ---------------- */
/**
 * Oturum jetonunu şimdi yeniler (rotation bizde kalsın diye).
 * Access token 1 saat ömürlüdür; bekçi normalde 25 dk'da bir kendisi yeniler.
 */
router.post(
  '/session-yenile',
  asyncHandler(async (req, res) => {
    const once = oturumDurumu();
    const sonuc = await oturumuYenile({ zorla: true, taskId: 'manuel-yenileme' });
    res.status(sonuc.ok ? 200 : 502).json({
      success: sonuc.ok,
      once,
      sonra: sonuc.durum,
      yol: sonuc.yol ?? null,
      sebep: sonuc.ok ? null : sonuc.sebep,
      sure_ms: sonuc.sureMs,
    });
  }),
);

/* -------------------- GET /session-dogrula (canlı oturum testi) ------------ */
/**
 * Gerçek tarayıcıyla hedefe gider ve oturumun geçerli olup olmadığını söyler.
 * Amaç: 10 dakikalık üretim denemesi yerine saniyeler içinde net cevap almak.
 */
router.get(
  '/session-dogrula',
  asyncHandler(async (req, res) => {
    const t0 = Date.now();
    const lease = await browserManager.acquirePage({ taskId: 'session-check' });
    let duvar = { duvar: true, sebep: 'kontrol tamamlanamadı' };
    let ayrinti = {};
    try {
      await gotoWithChallengeCheck(lease.page, `${config.target.baseUrl}${config.target.generatePath}`).catch(() => {});
      await dismissConsent(lease.page).catch(() => {});
      duvar = await girisDuvariniTespit(lease.page);
      ayrinti = await lease.page
        .evaluate(() => {
          const gorunur = (e) => e.getBoundingClientRect().width > 1;
          const metinler = [...document.querySelectorAll('button,a')]
            .filter(gorunur)
            .map((e) => (e.innerText || '').trim())
            .filter((t) => /log ?in|log ?out|sign ?in|sign ?out/i.test(t))
            .slice(0, 6);
          const cerezAdlari = document.cookie.split(';').map((c) => c.trim().split('=')[0]).filter(Boolean);
          return { oturumButonlari: metinler, cerezSayisi: cerezAdlari.length, cerezler: cerezAdlari.slice(0, 14) };
        })
        .catch(() => ({}));
    } finally {
      await lease.release({ ok: !duvar.duvar }).catch(() => {});
    }
    res.status(duvar.duvar ? 200 : 200).json({
      success: true,
      oturum_gecerli: !duvar.duvar,
      sebep: duvar.duvar ? duvar.sebep : 'oturum geçerli görünüyor',
      url: lease.page?.url?.() ?? `${config.target.baseUrl}${config.target.generatePath}`,
      hedef: config.target.baseUrl,
      sure_ms: Date.now() - t0,
      ...ayrinti,
    });
  }),
);

/* ------------------- POST /session/import (canlı güncelleme) --------------- */
/**
 * Çalışan servise yeni cookie/session enjekte eder → context'ler otomatik yenilenir.
 * Kullanım: POST /api/v1/session/import  (gövde: storageState | cookie dizisi | Netscape metni)
 */
router.post(
  '/session/import',
  asyncHandler(async (req, res) => {
    const body = req.body;
    const state = typeof body === 'string' ? normalizeStorageState(body, 'request') : normalizeStorageState(body?.storage_state ?? body, 'request');
    const fs = await import('node:fs');
    fs.writeFileSync(config.session.statePath, JSON.stringify(state, null, 2), 'utf8');
    sessionStore.get(true); // cache'i zorla yenile → version artar → havuzdaki context'ler geri dönüşür
    log.info({ cookies: state.cookies.length, version: sessionStore.version }, 'session import edildi');
    res.json({
      success: true,
      imported_cookies: state.cookies.length,
      imported_origins: state.origins.length,
      session_version: sessionStore.version,
    });
  }),
);

/* --------------------------- POST /browser/reset -------------------------- */
router.post(
  '/browser/reset',
  asyncHandler(async (req, res) => {
    const before = browserManager.health();
    await browserManager.closeAll();
    browserManager.closing = false;
    await browserManager.ensureBrowser().catch(() => {});
    res.json({ success: true, before, after: browserManager.health() });
  }),
);

/* --------------------------- GET /selectors/file -------------------------- */
router.get(
  '/selectors/file',
  asyncHandler(async (req, res) => {
    res.json({ success: true, selectors: loadSelectors(true) });
  }),
);

export default router;
