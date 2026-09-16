/**
 * src/middleware/errorHandler.js
 * Tüm hataların tek noktadan, tutarlı JSON şemasıyla dönmesini sağlar.
 */
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { AppError } from '../errors.js';

/**
 * Sık görülen "bekledi ama çıkmadı" hataları için istemciye dönük aksiyon ipuçları.
 * (Canlı not: istemci tarafındaki curl/async istemcisi senkron isteği 3dk'da kestiğinde
 * sunucu 504 JOB_TIMEOUT'unu zaten yazamıyor — bu ipuçları async akışa yönlendirir.)
 */
const ERROR_HINTS = {
  JOB_TIMEOUT:
    'Uzun üretimlerde senkron çağrı yerine {"async":true} gönderin; sonra GET /api/v1/jobs/<job_id> ile sonucu izleyin. İstemci timeout\'unu JOB_TIMEOUT_MS\'den büyük tutun.',
  ARTIFACT_NOT_FOUND:
    'Üretim süresi GENERATION_TIMEOUT_MS\'i aştıysa süreyi büyütün; sayfa kapıya takıldıysa POST /api/v1/debug/probe (gonder:true) ile canlı teşhis yapın.',
};

export function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    error: { code: 'NOT_FOUND', message: `${req.method} ${req.path} bulunamadı.` },
  });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const isApp = err instanceof AppError;
  const status = isApp ? err.httpStatus : err.status || 500;
  const code = isApp ? err.code : err.code || 'INTERNAL_ERROR';

  const payload = {
    success: false,
    error: {
      code,
      message: isApp ? err.message : status >= 500 ? 'Beklenmeyen sunucu hatası.' : err.message,
    },
    request_id: req.id,
  };

  // Bilinen kodlara istemciye dönük çözüm ipucu ekle
  if (ERROR_HINTS[code]) payload.error.hint = ERROR_HINTS[code];

  // Hata ayıklama bilgisi: üretimde yalnızca 5xx ve DEBUG_ERRORS=true iken
  if ((!config.isProd || process.env.DEBUG_ERRORS === 'true') && (isApp ? err.details : true)) {
    payload.error.details = isApp ? err.details : { name: err.name, stack: err.stack?.split('\n').slice(0, 6) };
  }

  if (status >= 500) {
    logger.error(
      { requestId: req.id, code, status, err: err.message, stack: err.stack?.split('\n').slice(0, 8) },
      'istek başarısız',
    );
  } else {
    logger.warn({ requestId: req.id, code, status, err: err.message }, 'istek reddedildi');
  }

  if (res.headersSent) return;
  res.status(status).json(payload);
}

/** async route handler'ları sarmalayan yardımcı */
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
