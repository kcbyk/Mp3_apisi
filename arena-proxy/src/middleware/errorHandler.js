/**
 * src/middleware/errorHandler.js
 * Tüm hataların tek noktadan, tutarlı JSON şemasıyla dönmesini sağlar.
 */
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { AppError } from '../errors.js';

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
