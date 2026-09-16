/**
 * src/app.js
 * Express uygulamasını (middleware + route) kurar. `server.js` bunu dinlemeye alır.
 * Test edilebilirlik için export edilir (supertest ile app'i doğrudan kullanabilirsin).
 */
import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import cors from 'cors';
import pinoHttp from 'pino-http';
import rateLimit from 'express-rate-limit';
import { config, ROOT_DIR } from './config/index.js';
import { logger } from './utils/logger.js';
import { authMiddleware } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import generateRoutes from './routes/generateRoutes.js';
import systemRoutes from './routes/systemRoutes.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  /* ---------------------------- temel middleware --------------------------- */
  app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '2mb' }));

  // İstek kimliği: her log satırında ve hata gövdesinde görünür
  app.use((req, res, next) => {
    req.id = req.get('x-request-id') || crypto.randomUUID();
    res.set('x-request-id', req.id);
    next();
  });

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.id,
      autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/ready' },
      customLogLevel: (req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      customSuccessMessage: (req, res) => `${req.method} ${req.url} → ${res.statusCode}`,
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url, ip: req.remoteAddress }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  const corsOrigins = config.server.corsOrigins;
  app.use(
    cors({
      origin: corsOrigins.includes('*') ? true : corsOrigins,
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['content-type', 'authorization', 'x-api-key', 'x-request-id'],
      exposedHeaders: ['x-request-id', 'retry-after'],
      maxAge: 600,
    }),
  );

  /* ------------------------------- rate limit ------------------------------ */
  const limiter = rateLimit({
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
    max: Number(process.env.RATE_LIMIT_MAX || 60),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.get('x-api-key') || req.get('authorization') || req.ip,
    message: { success: false, error: { code: 'RATE_LIMITED', message: 'Çok fazla istek. Lütfen bekleyin.' } },
  });
  app.use(config.server.apiPrefix, limiter);

  /* --------------------------- statik teslim (narrow) ---------------------- */
  // Sadece artifact ve fixture dizinleri servis edilir — data/sessions ASLA dışa açılmaz.
  app.use(
    '/files/artifacts',
    express.static(config.artifact.localDir, { fallthrough: false, index: false, dotfiles: 'deny', maxAge: '1h' }),
  );
  app.use(
    '/files/fixtures',
    express.static(path.join(ROOT_DIR, 'data', 'fixtures'), { fallthrough: false, index: false, dotfiles: 'deny' }),
  );

  /* --------------------------------- uçlar -------------------------------- */
  app.get('/', (req, res) => {
    res.json({
      service: 'arena-proxy',
      docs: '/docs',
      openapi: '/openapi.json',
      health: '/health',
      api: config.server.apiPrefix,
    });
  });

  app.use('/healthz', (req, res) => res.status(200).send('ok'));
  app.use('/openapi.json', (req, res) => res.sendFile(path.join(ROOT_DIR, 'openapi.json')));
  app.use('/docs', (req, res) => res.sendFile(path.join(ROOT_DIR, 'docs', 'index.html')));

  // Sistem uçları hem kökte (/health, /metrics) hem API prefix'i altında
  // (/api/v1/health) erişilebilir olsun — istemciler tek taban URL kullanabilsin.
  app.use(systemRoutes);
  app.use(config.server.apiPrefix, systemRoutes);

  // Üretim uçları: API anahtarı doğrulaması zorunlu
  app.use(config.server.apiPrefix, authMiddleware, generateRoutes);

  /* ------------------------------- hata yönetimi --------------------------- */
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
