/**
 * src/services/assetService.js
 * ---------------------------------------------------------------------------
 * Orkestrasyon katmanı: kuyruk → tarayıcı havuzu → scraper → teslim.
 * Route'lar bu katmanı çağırır; scraper tarayıcıyı, browserManager context'i,
 * queue ise eşzamanlılığı yönetir. Sorumluluklar net biçimde ayrılmıştır.
 */
import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { taskQueue } from '../automation/queue.js';
import { browserManager } from '../automation/browserManager.js';
import { sessionStore } from '../automation/sessionStore.js';
import { oturumDurumu, yenilemeGerekliMi, oturumuYenile } from '../automation/sessionRefresh.js';
import { runGeneration, normalizeParams, loadSelectors } from '../scrapers/arenaScraper.js';
import { deliverArtifact } from '../scrapers/artifactDelivery.js';
import { selectorReport } from '../utils/resilientSelector.js';
import { AppError, SessionError, ValidationError } from '../errors.js';

const log = logger.child({ mod: 'assetService' });

/** Prometheus tarzı basit metrik sayaçları */
class Metrics {
  constructor() {
    this.counters = { requests_total: 0, requests_success: 0, requests_failed: 0, retries: 0, queue_rejections: 0 };
    this.latencySamples = [];
    this.byCode = {};
  }
  inc(name, n = 1) {
    this.counters[name] = (this.counters[name] ?? 0) + n;
  }
  observeLatency(ms) {
    this.latencySamples.push(ms);
    if (this.latencySamples.length > 500) this.latencySamples.shift();
  }
  fail(code) {
    this.byCode[code] = (this.byCode[code] ?? 0) + 1;
  }
  snapshot() {
    const l = [...this.latencySamples].sort((a, b) => a - b);
    const pct = (p) => (l.length ? l[Math.min(l.length - 1, Math.floor((p / 100) * l.length))] : 0);
    return {
      ...this.counters,
      errors_by_code: { ...this.byCode },
      latency_ms: { p50: pct(50), p90: pct(90), p99: pct(99), samples: l.length },
      queue: taskQueue.stats(),
      browser: browserManager.health(),
    };
  }
}

export const metrics = new Metrics();

/* -------------------------------------------------------------------------- */
/*  Oturum doğrulama                                                          */
/* -------------------------------------------------------------------------- */

export function requireSession() {
  if (config.target.dryRun) return null;
  if (config.browser.persistentProfile || config.session.mode === 'profile') {
    return null; // profilden açılıyor; dosya zorunlu değil
  }
  try {
    return sessionStore.get(false);
  } catch (err) {
    throw err instanceof SessionError ? err : new SessionError(err.message);
  }
}

/* -------------------------------------------------------------------------- */
/*  Ana üretim akışı                                                          */
/* -------------------------------------------------------------------------- */

/**
 * POST /generate-asset işini uçtan uca yürütür.
 *
 * @param {object} rawParams  { prompt, negative_prompt, aspect_ratio, style, count }
 * @param {{requestId?:string, onRetry?:Function, onProgress?:Function}} opts
 */
export async function generateAsset(rawParams, { requestId = crypto.randomUUID(), onProgress } = {}) {
  const t0 = Date.now();
  const taskId = requestId.slice(0, 18);
  const log_ = log.child({ taskId });
  metrics.inc('requests_total');

  // 1) Input doğrulama (kuyruğa girmeden, hızlı başarısızlık)
  let params;
  try {
    params = normalizeParams(rawParams);
  } catch (err) {
    metrics.inc('requests_failed');
    metrics.fail(err.code ?? 'VALIDATION_ERROR');
    throw err;
  }

  log_.info(
    { aspect_ratio: params.aspectRatio, style: params.style || null, prompt_chars: params.prompt.length, negative: Boolean(params.negativePrompt) },
    'üretim isteği alındı',
  );

  // 0) Jeton dolmak üzereyse üretimden ÖNCE yenile (iş ortasında oturum düşmesin)
  if (!config.target.dryRun && yenilemeGerekliMi(10)) {
    await oturumuYenile({ taskId }).catch((e) =>
      log_.warn({ err: String(e.message).slice(0, 100) }, 'üretim öncesi oturum tazeleme başarısız'),
    );
  }

  // İstek bazlı teslim biçimi (global config'i mutasyona uğratmadan)
  const delivery = ['url', 'base64', 'file', 'both'].includes(rawParams?.delivery) ? rawParams.delivery : undefined;

  // 2) Kuyruk + retry + timeout sarmalayıcısı
  try {
    const result = await taskQueue.run(
      async ({ signal, attempt }) => {
        if (attempt > 1) metrics.inc('retries');

        // Oturum dosyası her denemede yeniden okunur (mtime değişmişse tazelenir)
        requireSession();

        // DRY_RUN: tarayıcı/context hiç açılmaz → fixture ile şema doğrulanır
        const lease = config.target.dryRun
          ? { page: null, context: null, reused: false, entryId: 'dry-run', release: async () => {} }
          : await browserManager.acquirePage({ taskId });
        let ok = true;
        try {
          const { captureCandidate, meta } = await runGeneration(
            { page: lease.page, context: lease.context },
            params,
            { signal, taskId, onProgress },
          );

          const artifact = await deliverArtifact(captureCandidate, {
            page: lease.page,
            taskId,
            signal,
            delivery,
          });

          return { artifact, meta, lease };
        } catch (err) {
          ok = !(err.retryable ?? false) ? true : false; // retryable ise sayfa "başarısız" sayılır
          throw err;
        } finally {
          await lease.release({ ok });
        }
      },
      {
        taskId,
        timeoutMs: config.queue.jobTimeoutMs,
        onRetry: async (err) => {
          metrics.fail(err.code ?? err.name ?? 'UNKNOWN');
        },
      },
    ).catch((err) => {
      if (err?.code === 'QUEUE_FULL') metrics.inc('queue_rejections');
      throw err;
    });

    const elapsed = Date.now() - t0;
    metrics.inc('requests_success');
    metrics.observeLatency(elapsed);

    log_.info({ elapsedMs: elapsed, delivery: result.artifact.delivery, source: result.artifact.source }, 'üretim başarılı');

    return {
      success: true,
      image_url: result.artifact.image_url ?? null,
      image_base64: result.artifact.image_base64 ?? null,
      image_file: result.artifact.image_file ?? null,
      mime_type: result.artifact.mime_type ?? null,
      bytes: result.artifact.bytes ?? null,
      sha256: result.artifact.sha256 ?? null,
      delivery: result.artifact.delivery,
      captured_from: result.artifact.source,
      execution_time_ms: elapsed,
      meta: {
        ...result.meta,
        reused_context: result.lease?.reused ?? false,
        context_id: result.lease?.entryId ?? null,
      },
      request_id: requestId,
    };
  } catch (err) {
    metrics.inc('requests_failed');
    metrics.fail(err.code ?? err.name ?? 'UNKNOWN');
    const elapsed = Date.now() - t0;
    log_.error({ err: err.message, code: err.code, elapsedMs: elapsed, stack: err.stack?.split('\n').slice(0, 6) }, 'üretim başarısız');
    if (err instanceof AppError) throw err;
    // Beklenmeyen hataları da tutarlı hata şemasına çevir ama orijinalini koru
    const wrapped = new AppError(err.message, { details: { name: err.name } });
    wrapped.stack = err.stack;
    throw wrapped;
  }
}

/* -------------------------------------------------------------------------- */
/*  Durum bilgileri                                                           */
/* -------------------------------------------------------------------------- */

export function healthPayload() {
  const oturum = config.target.dryRun ? { ok: true, skipped: 'dry_run' } : oturumDurumu();
  return {
    status: 'ok',
    uptime_s: Math.round(process.uptime()),
    env: config.env,
    dry_run: config.target.dryRun,
    session: { ...(config.target.dryRun ? { skipped: 'dry_run' } : sessionStore.describe()), oturum: oturum },
    browser: browserManager.health(),
    queue: taskQueue.stats(),
    selectors_file: config.target.selectorsPath,
  };
}

export function readiness() {
  const problems = [];
  if (!config.target.dryRun && config.session.mode === 'storage' && !sessionStore.exists()) {
    problems.push('session_file_missing');
  }
  if (config.auth.enabled && config.auth.keys.length === 0) problems.push('auth_enabled_but_no_keys');
  return { ready: problems.length === 0, problems };
}

export function selectorStats() {
  loadSelectors(false);
  return {
    path: config.target.selectorsPath,
    stats: selectorReport(),
  };
}

export { ValidationError };
