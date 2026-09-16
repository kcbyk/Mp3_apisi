/**
 * src/routes/generateRoutes.js
 * Üretim uçları: senkron (tek istek → görsel) ve asenkron (job kuyruğu) mod.
 */
import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from '../config/index.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { generateAsset, selectorStats } from '../services/assetService.js';
import { browserManager } from '../automation/browserManager.js';
import { sessionStore, normalizeStorageState } from '../automation/sessionStore.js';
import { loadSelectors } from '../scrapers/arenaScraper.js';
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
