/**
 * src/utils/logger.js
 * Pino tabanlı yapılandırılmış loglayıcı. Prompt/cookie gibi hassas alanlar
 * log'a düşmesin diye `redact` listesi tanımlıdır.
 */
import pino from 'pino';
import { config } from '../config/index.js';

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'apiKey',
  'storageState',
  'cookies',
  'session.*.cookie',
  'proxy.password',
  'env.PROXY_PASSWORD',
];

export const logger = pino({
  level: config.server.logLevel,
  redact: { paths: redactPaths, censor: '[REDACTED]' },
  base: { service: 'arena-proxy', env: config.env },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(config.server.logPretty && !config.isProd
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service,env' },
        },
      }
    : {}),
});

/** İstek bazlı child logger */
export function childLogger(bindings) {
  return logger.child(bindings);
}
