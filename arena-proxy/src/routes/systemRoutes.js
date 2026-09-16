/**
 * src/routes/systemRoutes.js
 * Sağlık, hazırlık (readiness), metrik ve iş kuyruğu gözlemleme uçları.
 */
import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { healthPayload, readiness, metrics } from '../services/assetService.js';
import { jobStore } from '../services/jobStore.js';

const router = Router();

router.get('/health', (req, res) => {
  res.json(healthPayload());
});

router.get('/ready', (req, res) => {
  const r = readiness();
  res.status(r.ready ? 200 : 503).json(r);
});

router.get('/metrics', (req, res) => {
  res.json(metrics.snapshot());
});

router.get(
  '/jobs',
  asyncHandler(async (req, res) => {
    res.json({ success: true, jobs: jobStore.list() });
  }),
);

router.get('/version', (req, res) => {
  res.json({
    name: 'arena-proxy',
    version: process.env.npm_package_version || '1.0.0',
    node: process.version,
  });
});

export default router;
