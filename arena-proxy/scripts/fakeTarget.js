#!/usr/bin/env node
/**
 * scripts/fakeTarget.js
 * ---------------------------------------------------------------------------
 * Yerel "hedef platform" simülatörü. arena.ai'ye dokunmadan servisi uçtan uca
 * (gerçek Chromium ile) denemek için kullanılır: prompt alanı, Generate butonu,
 * CDN'den servis edilen sonuç görseli ve JSON API yanıtı.
 *
 * Kullanım:
 *   node scripts/fakeTarget.js                                  # 8x8 fixture görsel
 *   node scripts/fakeTarget.js --port 9099 --asset data/fixtures/shark.png
 *   node scripts/fakeTarget.js --latency 2500 --login-wall      # senaryo testleri
 *
 * Ardından servisi bu sahte platforma yönlendirin:
 *   DRY_RUN=false SESSION_MODE=profile \
 *   TARGET_BASE_URL=http://127.0.0.1:9099 ARTIFACT_DELIVERY=file npm start
 */
import { startFakeTarget } from '../tests/fakeTargetServer.js';

function parseArgs(argv) {
  const args = { port: 9099, latencyMs: 1500, ws: false, consent: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--asset') args.assetFile = argv[++i];
    else if (a === '--latency') args.latencyMs = Number(argv[++i]);
    else if (a === '--ws') args.ws = true;
    else if (a === '--login-wall') args.loginWall = true;
    else if (a === '--consent') args.consent = true;
    else if (a === '--no-consent') args.consent = false;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const fake = await startFakeTarget(args);

console.log(`
┌─ Fake Studio (yerel hedef platform simülatörü) ─────────────────────────
│  URL      : ${fake.baseUrl}
│  Görsel   : ${args.assetFile ?? '(8x8 PNG fixture)'}
│  Gecikme  : ${args.latencyMs} ms   WebSocket: ${args.ws ? 'açık' : 'kapalı'}
│  Senaryo  : ${args.loginWall ? 'login wall açık' : 'normal akış'}
└─────────────────────────────────────────────────────────────────────────

Servisi bu hedefe yönlendirmek için:

  DRY_RUN=false SESSION_MODE=profile \\
  TARGET_BASE_URL=${fake.baseUrl} TARGET_GENERATE_PATH=/ \\
  ARTIFACT_DELIVERY=file PORT=8080 node server.js

http://localhost:${args.port} adresini tarayıcıda açıp sayfayı da görebilirsiniz.
Ctrl+C ile kapatın.
`);

const shutdown = async () => {
  console.log('\nFake Studio kapatılıyor…');
  await fake.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
