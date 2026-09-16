/**
 * src/automation/queue.js
 * ---------------------------------------------------------------------------
 * Asenkron iş kuyruğu: p-queue (concurrency + FIFO) + p-retry (üstel backoff).
 *
 * Neden gerekli?
 *   Her istek bir Chromium context'i tutar. Sınırsız eşzamanlılık = OOM + hedef
 *   platformda rate-limit/ban. Bu katman:
 *     • aynı anda en fazla QUEUE_CONCURRENCY iş çalıştırır,
 *     • kuyruk MAX_QUEUE_SIZE'ı aşarsa 429 (QUEUE_FULL) döner → istemci backoff yapar,
 *     • her işe JOB_TIMEOUT_MS sonrası AbortSignal ile iptal sinyali gönderir,
 *     • retryable AppError'larda üstel backoff ile yeniden dener.
 */
import PQueue from 'p-queue';
import pRetry, { AbortError } from 'p-retry';
import { config, timeoutCoherenceWarnings } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { AppError, JobTimeoutError, QueueFullError } from '../errors.js';

const log = logger.child({ mod: 'queue' });

/** Deneme başına üretim dışı ek süre (navigate + onay + prompt) — canlı ölçüm ~15-20sn */
const ATTEMPT_OVERHEAD_MS = 30_000;

export class TaskQueue {
  constructor() {
    // NOT: p-queue'nun kendi `interval`/`intervalCap` mekanizması kullanılmıyor çünkü
    // içerdeki setInterval unref() edilmiyor → süreç kapanışı 60 sn asılı kalıyor.
    // Bunun yerine kendi iptal edilebilir kayan-pencere hız sınırlayıcımızı uygularız.
    this.queue = new PQueue({
      concurrency: config.queue.concurrency,
      carryoverConcurrencyCount: true,
      autoStart: true,
    });

    /** Dakikalık iş başlatma sınırı (platformu yormamak için) */
    this.ratePerMinute = config.queue.ratePerMinute > 0 ? config.queue.ratePerMinute : config.queue.concurrency * 6;
    this.windowMs = 60_000;
    /** @type {number[]} pencere içindeki iş başlangıç zamanları */
    this.starts = [];

    // Kuyruk boşaldığında context'leri boşa düşürmek için hook
    this.onIdle = null;
    this.queue.on('idle', () => this.onIdle?.());
  }

  /**
   * Kayan pencere hız sınırı: son 60 sn içinde ratePerMinute'dan fazla iş
   * başlatıldıysa, en eski iş pencereden çıkana kadar bekler (iptal edilebilir).
   */
  async _awaitSlot(signal) {
    for (;;) {
      const now = Date.now();
      this.starts = this.starts.filter((t) => now - t < this.windowMs);
      if (this.starts.length < this.ratePerMinute) {
        this.starts.push(now);
        return;
      }
      const waitMs = Math.max(50, this.windowMs - (now - this.starts[0]) + 25);
      log.debug({ waitMs, inWindow: this.starts.length, limit: this.ratePerMinute }, 'hız sınırı: bekleniyor');
      await new Promise((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer);
          reject(signal.reason ?? new JobTimeoutError(config.queue.jobTimeoutMs));
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, waitMs);
        if (!signal) return;
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }
  }

  get size() {
    return this.queue.size;
  }

  get pending() {
    return this.queue.pending;
  }

  stats() {
    return {
      concurrency: this.queue.concurrency,
      size: this.queue.size,
      pending: this.queue.pending,
      maxSize: config.queue.maxSize,
      jobTimeoutMs: config.queue.jobTimeoutMs,
    };
  }

  /**
   * İşi kuyruğa al ve sonucu bekle.
   *
   * @template T
   * @param {(ctx:{signal:AbortSignal, attempt:number, taskId:string}) => Promise<T>} fn
   * @param {{taskId:string, timeoutMs?:number, attempts?:number, onRetry?:Function}} opts
   * @returns {Promise<T>}
   */
  async run(fn, { taskId, timeoutMs = config.queue.jobTimeoutMs, attempts = config.retry.attempts + 1, onRetry } = {}) {
    // --- Süre tutarlılığı: iş timeout'u tüm denemeleri karşılıyor mu? ---
    // Değilse son denemeler abort'a kurban gider; erkenden, anlaşılır uyarı ver.
    // (Canlı hata: 300sn iş süresi + 3 deneme → 2. ve 3. deneme ~30sn sonra kesildi.)
    const coherence = timeoutCoherenceWarnings(timeoutMs, {
      attempts,
      generationTimeoutMs: config.target.generationTimeoutMs,
      attemptOverheadMs: ATTEMPT_OVERHEAD_MS,
    });
    for (const w of coherence) log.warn({ taskId, timeoutMs, attempts }, w);

    // --- Backpressure: kuyruk sınırı ---
    if (this.queue.size >= config.queue.maxSize) {
      log.warn({ taskId, size: this.queue.size }, 'kuyruk dolu, istek reddedildi (429)');
      throw new QueueFullError(
        `Kuyruk dolu (${this.queue.size}/${config.queue.maxSize}). Lütfen birkaç saniye sonra tekrar deneyin.`,
      );
    }

    const controller = new AbortController();
    const killTimer = setTimeout(() => {
      log.warn({ taskId, timeoutMs }, 'iş zaman aşımı → abort sinyali gönderiliyor');
      controller.abort(new JobTimeoutError(timeoutMs));
    }, timeoutMs);
    killTimer.unref?.(); // zamanlayıcı süreci canlı tutmasın

    let lastError;
    const started = Date.now();

    try {
      return await this.queue.add(
        () => {
          const is = pRetry(
            async (attemptNumber) => {
              if (controller.signal.aborted) throw controller.signal.reason;
              // Kaderi belli denemeyi başlatma: kalan süre tam boy bir denemeyi
              // karşılamıyorsa (ör. 20dk'lık ilk denemenin ardından 4dk kaldıysa)
              // bu deneme zaten abort'a kurban gidecek — tarayıcıyı boşa yakma,
              // son hatayı dürüstçe döndür. (Canlı vaka: 2. deneme 29sn sonra
              // JOB_TIMEOUT ile öldü, hiçbir şey kazandırmadı.)
              if (attemptNumber > 1) {
                const perAttemptMs = config.target.generationTimeoutMs + ATTEMPT_OVERHEAD_MS;
                const elapsedMs = Date.now() - started;
                if (elapsedMs + perAttemptMs >= timeoutMs) {
                  log.warn(
                    { taskId, attempt: attemptNumber, elapsedMs, kalanMs: Math.max(0, timeoutMs - elapsedMs), perAttemptMs },
                    'kalan süre tam denemeyi karşılamıyor → deneme atlanıyor, son hata döndürülüyor',
                  );
                  throw new AbortError(lastError ?? new JobTimeoutError(timeoutMs));
                }
              }
              try {
                await this._awaitSlot(controller.signal); // dakikalık hız sınırı
                return await fn({ signal: controller.signal, attempt: attemptNumber, taskId });
              } catch (err) {
                const retryable =
                  (err instanceof AppError && err.retryable) ||
                  config.retry.on.includes(err?.name) ||
                  config.retry.on.includes(err?.code);

                // Kalıcı hatalar → p-retry'ı hemen kes
                if (!retryable) throw new AbortError(err);
                throw err;
              }
            },
            {
              retries: Math.max(0, attempts - 1),
              minTimeout: config.retry.minTimeout,
              maxTimeout: config.retry.maxTimeout,
              factor: 2,
              randomize: true,
              signal: controller.signal,
              onFailedAttempt: async (err) => {
                lastError = err;
                const delayNote = `deneme ${err.attemptNumber}/${attempts} başarısız`;
                log.warn({ taskId, attempt: err.attemptNumber, err: err.message }, delayNote);
                try {
                  await onRetry?.(err);
                } catch {
                  /* onRetry hatası akışı bozmasın */
                }
              },
            },
          );

          // Takılı kalan gövde kuyruğu kilitlemesin: zaman aşımı/abort anında
          // yarışı kaybettir → p-queue slot'u serbest kalır. Arka planda süren iş
          // sayfayı bırakırsa browserManager bekçisi (watchdog) de devreye girer.
          const iptal = new Promise((_, reddet) => {
            if (controller.signal.aborted) return reddet(controller.signal.reason);
            controller.signal.addEventListener('abort', () => reddet(controller.signal.reason), { once: true });
            return undefined;
          });
          is.catch(() => {}); // yarışı kaybederse yutulmayan reddi önle
          return Promise.race([is, iptal]);
        },
        { signal: controller.signal },
      );
    } catch (err) {
      // Abort kaynaklıysa anlamlı hataya çevir
      if (controller.signal.aborted) throw controller.signal.reason ?? new JobTimeoutError(timeoutMs);
      throw err?.originalError ?? err ?? lastError;
    } finally {
      clearTimeout(killTimer);
      log.debug({ taskId, elapsedMs: Date.now() - started }, 'iş kuyruğu tamamlandı');
    }
  }

  async drain() {
    await this.queue.onEmpty();
  }

  pause() {
    this.queue.pause();
  }

  resume() {
    this.queue.start();
  }
}

export const taskQueue = new TaskQueue();
