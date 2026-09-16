/**
 * server.js — giriş noktası
 * ---------------------------------------------------------------------------
 *  1) Config doğrula, çalışma dizinlerini hazırla
 *  2) Express uygulamasını ayağa kaldır
 *  3) Chromium'u önceden ısıt (ilk istek 1-3 sn kazanır)
 *  4) Session dosyası izleyicisini başlat (cookie rotasyonu)
 *  5) SIGTERM/SIGINT'te graceful shutdown: kuyruğu boşalt, tarayıcıyı kapat
 */
import http from 'node:http';
import { config, ensureRuntimeDirs, redactedSummary } from './src/config/index.js';
import { logger } from './src/utils/logger.js';
import { createApp } from './src/app.js';
import { browserManager } from './src/automation/browserManager.js';
import { taskQueue } from './src/automation/queue.js';
import { sessionStore } from './src/automation/sessionStore.js';

const log = logger.child({ mod: 'server' });

async function main() {
  ensureRuntimeDirs();

  log.info(redactedSummary(), '★ arena-proxy başlatılıyor');

  // Uyarılar (fail etmeyiz, uyarırız)
  if (config.auth.enabled && config.auth.keys.length === 0) {
    if (config.isProd) {
      log.error('AUTH_ENABLED=true fakat API_KEYS boş — istekler 500 ile reddedilecek.');
    } else {
      log.warn('API_KEYS tanımlı değil: geliştirme modunda API açık.');
    }
  }
  if (!config.target.dryRun && config.session.mode === 'storage' && !sessionStore.exists()) {
    log.warn(
      { path: config.session.statePath },
      'Oturum dosyası yok. Gerçek üretim çağrıları 503 SESSION_INVALID ile dönecek. "DRY_RUN=true" ile mimari test edilebilir.',
    );
  }
  if (config.queue.concurrency > config.browser.maxContexts) {
    log.warn(
      { concurrency: config.queue.concurrency, maxContexts: config.browser.maxContexts },
      'QUEUE_CONCURRENCY > MAX_CONTEXTS: istekler context havuzunda bekleyecek. Değerleri eşitleyin.',
    );
  }

  const app = createApp();
  const server = http.createServer(app);

  // Soket zaman aşımı: asılı kalan bağlantıları keser
  server.headersTimeout = 65_000;
  server.requestTimeout = (config.queue.jobTimeoutMs || 120_000) + 30_000;
  server.keepAliveTimeout = 30_000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.server.port, config.server.host, () => {
      server.off('error', reject);
      log.info(
        { url: `http://${config.server.host}:${config.server.port}`, api: config.server.apiPrefix },
        'HTTP dinleniyor',
      );
      resolve();
    });
  });

  // --- Chromium'u ısıt (opsiyonel ama önerilir) ---
  if (process.env.PREWARM_BROWSER !== 'false' && !config.target.dryRun) {
    browserManager
      .ensureBrowser()
      .then(() => log.info('Chromium ön ısıtma tamam'))
      .catch((err) => log.error({ err: err.message }, 'Chromium başlatılamadı — ilk istekte tekrar denenecek'));
  }

  // --- Session dosyası izleyicisi ---
  if (config.session.mode === 'storage') {
    sessionStore.startWatcher();
    log.info({ path: config.session.statePath, intervalMs: config.session.reloadIntervalMs }, 'session izleyicisi aktif');
  }

  // --- Periyodik sağlık logu ---
  const healthTimer = setInterval(() => {
    log.debug({ browser: browserManager.health(), queue: taskQueue.stats() }, 'sağlık durumu');
  }, 120_000);
  healthTimer.unref?.();

  /* ----------------------------- graceful shutdown ---------------------------- */
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.warn({ signal }, 'kapatma sinyali alındı — graceful shutdown');

    const hardExit = setTimeout(() => {
      log.error('Graceful shutdown zaman aşımına uğradı, zorla çıkılıyor.');
      process.exit(1);
    }, 25_000);
    hardExit.unref?.();

    try {
      server.close(() => log.info('HTTP sunucusu kapatıldı'));
      taskQueue.pause();
      await taskQueue.drain().catch(() => {});
      sessionStore.stopWatcher();
      clearInterval(healthTimer);
      await browserManager.closeAll();
      log.info('Temiz çıkış tamamlandı.');
      process.exit(0);
    } catch (err) {
      log.error({ err: err.message }, 'shutdown sırasında hata');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => log.error({ reason: String(reason) }, 'unhandledRejection'));
  process.on('uncaughtException', (err) => {
    log.fatal({ err: err.message, stack: err.stack }, 'uncaughtException — süreç kapatılıyor');
    shutdown('uncaughtException');
  });
}

main().catch((err) => {
  logger.fatal({ err: err.message, stack: err.stack }, 'Sunucu başlatılamadı');
  process.exit(1);
});
