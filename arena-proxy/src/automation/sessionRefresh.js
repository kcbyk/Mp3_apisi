/**
 * src/automation/sessionRefresh.js
 * ---------------------------------------------------------------------------
 * ÖLÜMSÜZ OTURUM (kendini yenileyen çerez) motoru.
 *
 * Neden gerekli?
 *   arena.ai oturumu Supabase GoTrue tabanlıdır:
 *     cookie `arena-auth-prod-v1.0` = base64({"access_token","refresh_token","expires_at",...})
 *   - access_token  : 1 saat ömürlü
 *   - refresh_token : her kullanımda DEĞİŞİR (rotation)
 *   - Aynı refresh_token'ı iki farklı yer kullanırsa (iki sekme, iki sunucu, tarayıcı +
 *     otomasyon) Supabase "yeniden kullanım" algılar ve TÜM jeton ailesini iptal eder.
 *     (Canlıda yaşandı: Render + yerel test + kullanıcı tarayıcısı aynı çerezi kullandı.)
 *
 * Çözüm:  Oturumun TEK SAHİBİ bu servis olsun ve jetonu süresi dolmadan kendisi döndürsün.
 *   1) Zamanlayıcı (varsayılan 25 dk) → access_token dolmadan yeniler (rotation bizde).
 *   2) Yeni çerez kalıcı bir yere YAZILIR (dosya + gerekiyorsa Render env).
 *      Bu şart: eski/kullanılmış jetonla yeniden başlatmak = yeniden kullanım = aile iptali.
 *   3) Tek kopya kuralı: aynı oturumu ikinci bir süreç/tarayıcı kullanmamalı.
 *
 * İki yenileme yolu (otomatik seçilir):
 *   A) HTTP: hedef sayfaya mevcut çerezle istek at → Set-Cookie ile dönen yeni çerezi al.
 *   B) Tarayıcı: sayfa aç → sitenin kendi yenileme akışı işlesin → cookie jar'dan oku.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { sessionStore } from './sessionStore.js';
import { browserManager } from './browserManager.js';

const log = logger.child({ mod: 'sessionRefresh' });

let zamanlayici = null;
let surenIslem = null; // eşzamanlı yenilemeleri engeller (rotation yarışı = aile iptali)

/* ------------------------------- Yardımcılar ------------------------------ */

/** Oturum çerezini bulur (config.session.cookieName). */
export function oturumCereziniBul(state) {
  const ad = config.session.cookieName;
  return (state?.cookies ?? []).find((c) => c.name === ad) ?? null;
}

/** Çerez değerini çözer: base64 JSON oturum (Supabase) → ayrıntılar. */
export function oturumCoz(cer) {
  if (!cer?.value) return { ok: false, sebep: 'çerez yok' };
  const ham = String(cer.value);
  const b64 = ham.startsWith('base64-') ? ham.slice(7) : ham;
  try {
    const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    const expiresAt = Number(json.expires_at) || 0;
    const simdi = Math.floor(Date.now() / 1000);
    let sessionId = null;
    try {
      const p = String(json.access_token).split('.')[1];
      sessionId = JSON.parse(Buffer.from(p, 'base64').toString('utf8')).session_id ?? null;
    } catch {
      /* JWT çözülemedi — sorun değil */
    }
    return {
      ok: true,
      expiresAt,
      kalanDk: expiresAt ? Math.round((expiresAt - simdi) / 60) : null,
      refreshVar: Boolean(json.refresh_token),
      kullanici: json?.user?.email ?? null,
      sessionId,
      json,
    };
  } catch {
    return { ok: false, sebep: 'çerez çözülemedi (base64 JSON değil)' };
  }
}

/** Mevcut oturumun durumu (sağlık uçlarında gösterilir). */
export function oturumDurumu() {
  if (config.session.mode === 'storage' && !sessionStore.exists()) {
    return { ok: false, sebep: 'oturum dosyası/env yok' };
  }
  let state;
  try {
    state = sessionStore.get(false);
  } catch (e) {
    return { ok: false, sebep: `oturum okunamadı: ${String(e.message).slice(0, 80)}` };
  }
  const cer = oturumCereziniBul(state);
  if (!cer) return { ok: false, sebep: `${config.session.cookieName} çerezi bulunamadı` };
  const c = oturumCoz(cer);
  if (!c.ok) return { ok: false, sebep: c.sebep };
  return {
    ok: c.kalanDk === null || c.kalanDk > 0,
    kalanDk: c.kalanDk,
    refreshVar: c.refreshVar,
    kullanici: c.kullanici,
    sessionId: c.sessionId ? `${String(c.sessionId).slice(0, 8)}…` : null,
    sonYenileme: config.session.sonYenileme ?? null,
  };
}

/** access_token bitmek üzere mi? */
export function yenilemeGerekliMi(esikDk = config.session.refreshThresholdMinutes) {
  const d = oturumDurumu();
  if (!d.ok || d.kalanDk === null) return true;
  return d.kalanDk <= esikDk;
}

/* ------------------------------ Kalıcı yazım ------------------------------ */

/**
 * Yeni oturumu kalıcı hale getirir: yerel dosya + (isteğe bağlı) Render env.
 * Env güncellemesi şart çünkü Render dosya sistemi kalıcı değil; eski jetonla
 * yeniden başlamak yeniden-kullanım tespitine ve aile iptaline yol açar.
 */
export async function oturumuKaliciYaz(state, { neden = 'refresh' } = {}) {
  const sonuc = { dosya: false, render: false, github: false, hatalar: [] };

  // 1) yerel dosya (atomik yazım, 600)
  try {
    const hedef = config.session.statePath;
    fs.mkdirSync(path.dirname(hedef), { recursive: true });
    const gecici = `${hedef}.tmp`;
    fs.writeFileSync(gecici, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(gecici, hedef);
    sonuc.dosya = true;
  } catch (e) {
    sonuc.hatalar.push(`dosya: ${String(e.message).slice(0, 80)}`);
  }

  // 2) Render env (self-update) — SESSION_PERSIST içinde 'render' varsa
  if (config.session.persist.includes('render') && config.session.renderApiKey && config.session.renderServiceId) {
    try {
      const b64 = Buffer.from(JSON.stringify(state), 'utf8').toString('base64');
      const r = await fetch(
        `https://api.render.com/v1/services/${config.session.renderServiceId}/env-vars/${config.session.envVarName}`,
        {
          method: 'PUT',
          headers: { Authorization: `Bearer ${config.session.renderApiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: b64 }),
          signal: AbortSignal.timeout(30000),
        },
      );
      if (r.ok) sonuc.render = true;
      else sonuc.hatalar.push(`render env: HTTP ${r.status}`);
    } catch (e) {
      sonuc.hatalar.push(`render env: ${String(e.message).slice(0, 80)}`);
    }
  }

  // 2b) Özel GitHub deposu (yalnız private repo — aksi halde oturum herkese açık olurdu)
  if (config.session.persist.includes('github') && config.session.githubToken && config.session.githubRepo) {
    try {
      const [sahip, ad] = config.session.githubRepo.split('/');
      const ghBaslik = {
        Authorization: `Bearer ${config.session.githubToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'arena-proxy',
      };
      const repoBilgi = await fetch(`https://api.github.com/repos/${sahip}/${ad}`, {
        headers: ghBaslik,
        signal: AbortSignal.timeout(20000),
      });
      const repo = repoBilgi.ok ? await repoBilgi.json() : null;
      if (repo?.private === true) {
        const yol = `https://api.github.com/repos/${sahip}/${ad}/contents/${config.session.githubPath}`;
        const mevcut = await fetch(`${yol}?ref=${config.session.githubBranch}`, { headers: ghBaslik, signal: AbortSignal.timeout(20000) });
        const sha = mevcut.ok ? (await mevcut.json()).sha : undefined;
        const govde = {
          message: `oturum güncellendi (${new Date().toISOString()})`,
          content: Buffer.from(JSON.stringify(state), 'utf8').toString('base64'),
          branch: config.session.githubBranch,
          ...(sha ? { sha } : {}),
        };
        const yaz = await fetch(yol, { method: 'PUT', headers: ghBaslik, body: JSON.stringify(govde), signal: AbortSignal.timeout(30000) });
        if (yaz.ok) sonuc.github = true;
        else sonuc.hatalar.push(`github: HTTP ${yaz.status}`);
      } else {
        sonuc.hatalar.push('github: repo private DEĞİL → oturum yazılmadı (güvenlik)');
      }
    } catch (e) {
      sonuc.hatalar.push(`github: ${String(e.message).slice(0, 80)}`);
    }
  }

  // 3) bellekteki oturumu tazele (version artar → havuzdaki context'ler geri dönüşür)
  try {
    sessionStore.get(true);
  } catch {
    /* okuma hatası yut */
  }

  log.info(
    { neden, dosya: sonuc.dosya, render: sonuc.render, github: sonuc.github, hatalar: sonuc.hatalar.length ? sonuc.hatalar : undefined },
    'oturum kalıcı yazıldı',
  );
  return sonuc;
}

/* ----------------------------- Yenileme yolları --------------------------- */

/** A) HTTP yolu: sayfaya çerezle istek → Set-Cookie ile gelen yeni oturum. */
export async function httpIleYenile() {
  const state = sessionStore.get(false);
  const cer = oturumCereziniBul(state);
  if (!cer) return { ok: false, sebep: 'oturum çerezi yok' };

  const url = `${config.target.baseUrl}${config.target.generatePath || '/'}`;
  const r = await fetch(url, {
    headers: {
      cookie: `${cer.name}=${cer.value}`,
      'user-agent': config.stealth.userAgent,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': `${config.stealth.locale},en;q=0.8`,
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(config.session.refreshTimeoutMs),
  });

  const setCookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
  const yeni = setCookies
    .map((s) => s.split(';')[0])
    .map((s) => {
      const i = s.indexOf('=');
      return { name: s.slice(0, i).trim(), value: s.slice(i + 1) };
    })
    .find((c) => c.name === cer.name && c.value && c.value !== cer.value);

  if (!yeni) return { ok: false, sebep: `Set-Cookie ile yeni oturum gelmedi (HTTP ${r.status})` };

  const yeniDurum = {
    ...state,
    cookies: state.cookies.map((c) => (c.name === cer.name ? { ...c, value: yeni.value } : c)),
  };
  const bilgi = oturumCoz({ value: yeni.value });
  await oturumuKaliciYaz(yeniDurum, { neden: 'http' });
  return { ok: true, yol: 'http', yeniKalanDk: bilgi.kalanDk ?? null, refreshVar: bilgi.refreshVar ?? null };
}

/** B) Tarayıcı yolu: sayfayı aç → site kendi akışıyla yeniler → cookie jar'dan oku. */
export async function tarayiciIleYenile({ taskId = 'session-refresh' } = {}) {
  const kiralama = await browserManager.acquirePage({ taskId });
  try {
    await kiralama.page
      .goto(`${config.target.baseUrl}${config.target.generatePath || '/'}`, {
        waitUntil: 'domcontentloaded',
        timeout: config.browser.navigationTimeoutMs,
      })
      .catch(() => {});
    await kiralama.page.waitForTimeout(6000);

    const yeniCerezler = await kiralama.context.cookies(config.target.baseUrl);
    const onceki = sessionStore.get(false);
    const eskiCer = oturumCereziniBul(onceki);
    const yeniCer = yeniCerezler.find((c) => c.name === config.session.cookieName);
    if (!yeniCer) return { ok: false, sebep: 'tarayıcıda oturum çerezi bulunamadı' };
    if (eskiCer && eskiCer.value === yeniCer.value) {
      return { ok: false, sebep: 'tarayıcı çerezi değiştirmedi (yenileme tetiklenmedi)' };
    }

    const yeniDurum = {
      cookies: [...onceki.cookies.filter((c) => c.name !== yeniCer.name), yeniCer],
      origins: onceki.origins ?? [],
    };
    const bilgi = oturumCoz(yeniCer);
    await oturumuKaliciYaz(yeniDurum, { neden: 'tarayıcı' });
    return { ok: true, yol: 'tarayıcı', yeniKalanDk: bilgi.kalanDk ?? null, refreshVar: bilgi.refreshVar ?? null };
  } finally {
    await kiralama.release({ ok: true });
  }
}

/* ------------------------------- Ana akış -------------------------------- */

/**
 * Oturumu yeniler: önce HTTP (hızlı), olmazsa tarayıcı (kesin).
 * Eşzamanlı çağrılar tek işlemde birleşir — rotasyon yarışı yasak.
 */
export async function oturumuYenile({ zorla = false, esikDk, taskId } = {}) {
  if (surenIslem) return surenIslem;
  if (!zorla && !yenilemeGerekliMi(esikDk)) {
    return { ok: true, atlandi: true, sebep: 'jeton henüz taze', durum: oturumDurumu() };
  }

  surenIslem = (async () => {
    const t0 = Date.now();
    let sonuc;
    try {
      sonuc = await httpIleYenile();
    } catch (e) {
      sonuc = { ok: false, sebep: `http hata: ${String(e.message).slice(0, 90)}` };
    }
    if (!sonuc.ok) {
      log.warn({ sebep: sonuc.sebep }, 'HTTP yenileme olmadı → tarayıcı yolu denenecek');
      try {
        sonuc = await tarayiciIleYenile({ taskId });
      } catch (e) {
        sonuc = { ok: false, sebep: `tarayıcı hata: ${String(e.message).slice(0, 90)}` };
      }
    }
    const ozet = { ...sonuc, sureMs: Date.now() - t0, durum: oturumDurumu() };
    if (ozet.ok) log.info({ yol: ozet.yol, kalanDk: ozet.durum?.kalanDk, sureMs: ozet.sureMs }, 'oturum yenilendi');
    else log.error({ sebep: ozet.sebep, kalanDk: ozet.durum?.kalanDk }, 'oturum yenilenemedi');
    return ozet;
  })();

  try {
    return await surenIslem;
  } finally {
    surenIslem = null;
  }
}

/**
 * Arka plan bekçisi: access_token dolmadan yeniler → oturum zinciri hiç kopmaz.
 * Not: interval unref edilir; testlerin/sürecin kapanmasını engellemez.
 */
export function oturumBekcisiniBaslat() {
  if (zamanlayici) return zamanlayici;
  const dk = config.session.keepAliveMinutes;
  if (!dk || dk <= 0) {
    log.info({}, 'oturum bekçisi kapalı (SESSION_KEEPALIVE_MINUTES=0)');
    return null;
  }
  const periyotMs = dk * 60_000;
  zamanlayici = setInterval(() => {
    const d = oturumDurumu();
    if (d.ok && d.kalanDk !== null && d.kalanDk > config.session.refreshThresholdMinutes) {
      log.debug({ kalanDk: d.kalanDk }, 'oturum bekçisi: jeton taze, işlem yok');
      return;
    }
    log.info({ kalanDk: d.kalanDk ?? null }, 'oturum bekçisi: yenileme başlıyor');
    oturumuYenile({ taskId: 'keepalive' }).catch((e) =>
      log.error({ err: String(e.message).slice(0, 120) }, 'oturum bekçisi hatası'),
    );
  }, periyotMs);
  zamanlayici.unref?.();
  log.info(
    { periyotDk: dk, esikDk: config.session.refreshThresholdMinutes, kalici: config.session.persist },
    'oturum bekçisi başladı',
  );
  return zamanlayici;
}

export function oturumBekcisiniDurdur() {
  if (zamanlayici) clearInterval(zamanlayici);
  zamanlayici = null;
}
