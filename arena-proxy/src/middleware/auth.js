/**
 * src/middleware/auth.js
 * API anahtarı doğrulaması. `Authorization: Bearer <key>` veya `x-api-key: <key>`.
 * Sabit-zamanlı karşılaştırma (timing attack önlemi) kullanılır.
 */
import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { AppError } from '../errors.js';

function timingSafeEqual(a = '', b = '') {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    // Uzunluk farkını sızdırmamak için sabit iş yap
    crypto.timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32));
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

export function authMiddleware(req, res, next) {
  if (!config.auth.enabled || config.auth.keys.length === 0) {
    if (config.isProd) {
      return next(
        new AppError('AUTH_ENABLED=true ama API_KEYS tanımlı değil. Üretimde bu yapılandırma reddedilir.', {
          code: 'AUTH_MISCONFIGURED',
          httpStatus: 500,
        }),
      );
    }
    return next(); // dev modda açık
  }

  const header = req.get('authorization') || '';
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  const provided = bearer || req.get('x-api-key') || '';

  if (!provided) {
    return next(new AppError('API anahtarı gerekli (Authorization: Bearer <key> veya x-api-key).', {
      code: 'UNAUTHORIZED',
      httpStatus: 401,
    }));
  }

  const ok = config.auth.keys.some((k) => timingSafeEqual(k, provided));
  if (!ok) {
    return next(new AppError('Geçersiz API anahtarı.', { code: 'FORBIDDEN', httpStatus: 403 }));
  }
  return next();
}
