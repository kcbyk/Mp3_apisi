/**
 * src/services/imageChain.js
 * ---------------------------------------------------------------------------
 * "auto" zinciri: isteği sırayla birden çok tarayıcısız sağlayıcıya yollar;
 * ilk başaran kazanır. Başarısızlıklar meta.fallback_attempts içinde izlenir.
 *
 *   Anahtar VARSA : pollinations(seed) → ovh → pollinations(anon)
 *   Anahtar YOKSA : ovh → pollinations-anon   (anonsuz kaliteye göre sıralı)
 */
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { pollinationsGenerate } from '../scrapers/directPollinations.js';
import { ovhGenerate } from '../scrapers/directOvh.js';

const log = logger.child({ mod: 'imageChain' });

/** Oturum gerektirmeyen sağlayıcılar — readiness'te session_file kuralı atlanır */
export const BROWSERLESS_PROVIDERS = new Set(['pollinations', 'ovh', 'auto']);

export function zincirKur() {
  const anonPol = {
    name: 'pollinations-anon',
    g: (p, o) => pollinationsGenerate(p, { ...o, cfgOverride: { ...config.imageProvider, token: null } }),
  };
  const ovh = { name: 'ovh', g: (p, o) => ovhGenerate(p, o) };
  if (config.imageProvider.token) {
    return [
      { name: 'pollinations', g: (p, o) => pollinationsGenerate(p, o) },
      ovh,
      anonPol,
    ];
  }
  return [ovh, anonPol];
}

/**
 * Zincirle üret: her adımda UpstreamError yutulup sonraki sağlayıcıya geçilir.
 * @returns pollinationsGenerate/ovhGenerate ile aynı {artifact, meta} şekli (+chain kaydı)
 */
export async function runImageChain(params, opts = {}) {
  const zincir = zincirKur();
  const attempts = [];
  let sonHata = null;

  for (const adim of zincir) {
    const t = Date.now();
    try {
      const pkg = await adim.g(params, opts);
      if (attempts.length) {
        pkg.meta = {
          ...pkg.meta,
          fallback_attempts: attempts.concat({ provider: adim.name, ok: true, ms: Date.now() - t }),
        };
      }
      log.info({ kazanan: adim.name, deneme: attempts.length + 1, ms: Date.now() - t }, 'zincir başarılı');
      return pkg;
    } catch (err) {
      attempts.push({
        provider: adim.name,
        ok: false,
        ms: Date.now() - t,
        error: err.code || err.name || 'ERR',
        http: err.details?.provider_http,
      });
      log.warn({ provider: adim.name, err: err.message.slice(0, 120) }, 'zincir halkası başarısız — sıradakine geçiliyor');
      sonHata = err;
    }
  }

  if (sonHata) {
    sonHata.details = { ...(sonHata.details || {}), chain: attempts };
    throw sonHata;
  }
  throw new Error('zincir boş (hiç sağlayıcı kurulamadı)');
}
