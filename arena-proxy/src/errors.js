/**
 * src/errors.js
 * ---------------------------------------------------------------------------
 * Tüm servis içi hatalar tek bir AppError hiyerarşisinden türer.
 * - code: istemciye dönen makine-okur hata kodu
 * - httpStatus: REST katmanında kullanılacak HTTP kodu
 * - retryable: kuyruk/retry katmanının bu hatayı tekrar denemesi gerekiyor mu?
 * - details: log'a giden, istemciye nötr dönen ek bilgi (prompt vb. taşımaz)
 */
export class AppError extends Error {
  constructor(message, { code = 'INTERNAL_ERROR', httpStatus = 500, retryable = false, details = {} } = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryable = retryable;
    this.details = details;
  }

  toJSON() {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}

/** İstemci kaynaklı hata: eksik/yanlış parametre */
export class ValidationError extends AppError {
  constructor(message, details = {}) {
    super(message, { code: 'VALIDATION_ERROR', httpStatus: 400, details });
  }
}

/** Kuyruk doldu — istemci sonra tekrar denemeli */
export class QueueFullError extends AppError {
  constructor(message = 'Sunucu kuyruğu dolu, lütfen birkaç saniye sonra tekrar deneyin.') {
    super(message, { code: 'QUEUE_FULL', httpStatus: 429, retryable: true });
  }
}

/** Hedef platform oturumu yok/geçersiz (login wall, cf_clearance expire vb.) */
export class SessionError extends AppError {
  constructor(message = 'Hedef platform oturumu geçersiz. Session dosyasını yenileyin.', details = {}) {
    super(message, { code: 'SESSION_INVALID', httpStatus: 503, retryable: false, details });
  }
}

/** Bir DOM adımı belirtilen sürede tamamlanmadı */
export class StepTimeoutError extends AppError {
  constructor(step, timeoutMs, details = {}) {
    super(`Adım zaman aşımına uğradı: ${step} (${timeoutMs}ms)`, {
      code: 'STEP_TIMEOUT',
      httpStatus: 504,
      retryable: true,
      details: { step, timeoutMs, ...details },
    });
  }
}

/** Navigasyon / ağ kaynaklı hata (DNS, reset, CF challenge) */
export class NavigationError extends AppError {
  constructor(message, details = {}) {
    super(message, { code: 'NAVIGATION_ERROR', httpStatus: 502, retryable: true, details });
  }
}

/** Üretim yapıldı ama asset URL'i yakalanamadı */
export class ArtifactNotFoundError extends AppError {
  constructor(message = 'Üretilen görsel yakalanamadı (network/DOM taraması boş döndü).', details = {}) {
    super(message, { code: 'ARTIFACT_NOT_FOUND', httpStatus: 502, retryable: true, details });
  }
}

/** Tarayıcı/süreç çöktü — context yenilenmeli */
export class BrowserClosedError extends AppError {
  constructor(message = 'Tarayıcı oturumu beklenmedik şekilde kapandı.', details = {}) {
    super(message, { code: 'BROWSER_CLOSED', httpStatus: 503, retryable: true, details });
  }
}

/** Toplam iş süresi aşıldı */
export class JobTimeoutError extends AppError {
  constructor(timeoutMs) {
    super(`İş ${timeoutMs}ms içinde tamamlanamadı.`, {
      code: 'JOB_TIMEOUT',
      httpStatus: 504,
      retryable: true,
      details: { timeoutMs },
    });
  }
}

/** Hedef dışına çıkma / SSRF denemesi */
export class BlockedTargetError extends AppError {
  constructor(message = 'İstenen hedef host izin listesinde değil.', details = {}) {
    super(message, { code: 'BLOCKED_TARGET', httpStatus: 400, details });
  }
}

/** Genel amaçlı 500 */
export class UpstreamError extends AppError {
  constructor(message, details = {}) {
    super(message, { code: 'UPSTREAM_ERROR', httpStatus: 500, details });
  }
}
