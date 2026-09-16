/**
 * src/services/jobStore.js
 * ---------------------------------------------------------------------------
 * Asenkron mod için hafif iş deposu (in-memory, TTL'li).
 *
 * Neden in-memory? Tek süreçli bir "browser proxy" için yeterlidir ve ek
 * altyapı istemez. Yatay ölçekleme (birden fazla replika) gerektiğinde bu
 * sınıfı Redis tabanlı bir implementasyonla değiştirmen yeterlidir — arayüz
 * bilinçli olarak minimal tutuldu: create/get/complete/fail/list/delete.
 */
import crypto from 'node:crypto';
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';

const log = logger.child({ mod: 'jobStore' });

const JOB_TTL_MS = Number(process.env.JOB_TTL_MS || 3_600_000); // 1 saat
const MAX_JOBS = Number(process.env.MAX_JOBS || 500);

class JobStore {
  constructor() {
    /** @type {Map<string, object>} */
    this.jobs = new Map();
    const t = setInterval(() => this.sweep(), 60_000);
    t.unref?.();
  }

  create({ request_id, params }) {
    const id = crypto.randomUUID();
    const job = {
      id,
      request_id,
      status: 'queued',
      params,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      result: null,
      error: null,
    };
    this.jobs.set(id, job);
    this.sweep();
    return this.get(id);
  }

  get(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    return this.serialize(job);
  }

  complete(id, result) {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = 'succeeded';
    job.result = result;
    job.updated_at = new Date().toISOString();
    log.info({ jobId: id, elapsedMs: result.execution_time_ms }, 'asenkron iş tamamlandı');
  }

  fail(id, error) {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = 'failed';
    job.error = error;
    job.updated_at = new Date().toISOString();
    log.warn({ jobId: id, code: error?.code }, 'asenkron iş başarısız');
  }

  delete(id) {
    return this.jobs.delete(id);
  }

  list({ limit = 100 } = {}) {
    return [...this.jobs.values()].slice(-limit).map((j) => this.serialize(j));
  }

  /** Kuyruk pozisyonu: bu iş yaratıldığında kuyrukta bekleyen iş sayısı */
  serialize(job) {
    return { ...job, queue_position: job.status === 'queued' ? Math.max(0, this.pendingCount()) : 0 };
  }

  pendingCount() {
    return [...this.jobs.values()].filter((j) => j.status === 'queued').length;
  }

  sweep() {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (now - new Date(job.updated_at).getTime() > JOB_TTL_MS && job.status !== 'queued') this.jobs.delete(id);
    }
    // Kapasite aşımı: en eski bitmiş işleri at
    if (this.jobs.size > MAX_JOBS) {
      const finished = [...this.jobs.values()]
        .filter((j) => j.status !== 'queued')
        .sort((a, b) => new Date(a.updated_at) - new Date(b.updated_at));
      for (const job of finished.slice(0, this.jobs.size - MAX_JOBS)) this.jobs.delete(job.id);
    }
  }

  /** Webhook bildirimi (retryable, 5s timeout) */
  async fireCallback(url, payload) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.auth.keys[0] ?? '',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(t);
      log.info({ url, status: res.status }, 'callback gönderildi');
    } catch (err) {
      log.warn({ url, err: err.message }, 'callback gönderilemedi (istemci yok sayabilir, /jobs/:id ile yoklayın)');
    }
  }
}

export const jobStore = new JobStore();
