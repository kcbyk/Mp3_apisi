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

/**
 * Parçalı çerez şeması (arena.ai davranışı):
 *   Çerez boyutu 4096 karakteri aşınca site oturumu böler:
 *     arena-auth-prod-v1.0 = "base64-" + akışın ilk parçası
 *     arena-auth-prod-v1.1 = akışın devamı      (v1.2, v1.3 … de olabilir)
 *   Okurken parçalar ana değerin ARDINA eklenir, sonra base64 çözülür.
 *   (Tarayıcıda deneyle doğrulandı: 4596 = 3174 + 1422; ana parça tek başına çözülmez.)
 */
export function oturumParcaCerezleri(state) {
  const ad = config.session.cookieName;
  const kok = ad.replace(/\.[0-9]+$/, '');
  const desen = new RegExp(`^${kok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.[0-9]+$`);
  return (state?.cookies ?? [])
    .filter((c) => c.name !== ad && desen.test(c.name))
    .sort((a, b) => Number(String(a.name).split('.').pop()) - Number(String(b.name).split('.').pop()));
}

/** Ana çerez + parçaları → birleşik çerez değeri (parça yoksa ana değerin kendisi). */
export function birlesikCerezDegeri(state) {
  const ana = oturumCereziniBul(state);
  if (!ana) return null;
  return [ana, ...oturumParcaCerezleri(state)].map((c) => String(c.value ?? '')).join('');
}

/**
 * Uzun oturum değerini çerez sınırına göre böler (yazarken kullanılır).
 * Döner: { ana, ekler: [...] } — ana 'base64-' önekini taşır, ekler taşımaz.
 */
export function cerezDegeriniBol(deger, { sinir = 3181 } = {}) {
  const ham = String(deger ?? '');
  if (ham.length <= sinir) return { ana: ham, ekler: [] };
  const gövde = ham.startsWith('base64-') ? ham.slice(7) : ham;
  const kesim = Math.floor((sinir - 7) / 4) * 4; // 4'ün katı: parçalar tek başına da geçerli base64 kalsın
  const ekler = [];
  for (let i = kesim; i < gövde.length; i += kesim) ekler.push(gövde.slice(i, i + kesim));
  return { ana: `base64-${gövde.slice(0, kesim)}`, ekler };
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
  // Parçalı şema: ana çerez tek başına çözülmezse parçaları ekleyerek dene
  const birlesik = birlesikCerezDegeri(state) ?? cer.value;
  let c = oturumCoz({ value: birlesik });
  if (!c.ok && birlesik !== cer.value) c = oturumCoz(cer);
  if (!c.ok) return { ok: false, sebep: c.sebep };
  return {
    ok: c.kalanDk === null || c.kalanDk > 0,
    kalanDk: c.kalanDk,
    refreshVar: c.refreshVar,
    kullanici: c.kullanici,
    sessionId: c.sessionId ? `${String(c.sessionId).slice(0, 8)}…` : null,
    parcaSayisi: oturumParcaCerezleri(state).length,
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

  // 0) CANLI BELLEK: dosya/env bir sonraki açılışta okunur; süreç yeniden başlamadan
  //    yeni çerezle çalışabilmesi için bellekteki oturumu hemen değiştir.
  try {
    sessionStore.guncelle(state, { etiket: `runtime:${neden}` });
    sonuc.bellek = true;
  } catch (e) {
    sonuc.hatalar.push(`bellek: ${String(e.message).slice(0, 60)}`);
  }

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

/** Gelen yeni çerez değerlerini duruma uygular; uzun değeri gerekirse parçalara böler. */
export function cerezleriUygula(state, yeniDegerler) {
  const ad = config.session.cookieName;
  const kok = ad.replace(/\.[0-9]+$/, '');
  const desen = new RegExp(`^${kok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.[0-9]+$`);
  const anaHam = yeniDegerler[ad];
  if (!anaHam) return state;
  // Sunucu zaten parçalı gönderdiyse önce birleştir, sonra kendi sınırımıza göre böl
  const parcaliGelen = Object.keys(yeniDegerler)
    .filter((n) => n !== ad)
    .sort((a, b) => Number(String(a).split('.').pop()) - Number(String(b).split('.').pop()))
    .map((n) => yeniDegerler[n]);
  const birlesikGelen = [anaHam, ...parcaliGelen].join('');
  const bolunmus = cerezDegeriniBol(birlesikGelen);
  const ornek = oturumCereziniBul(state) ?? { name: ad, domain: 'arena.ai', path: '/' };
  const digerleri = (state.cookies ?? []).filter((c) => c.name !== ad && !desen.test(c.name));
  const yenileri = [{ ...ornek, name: ad, value: bolunmus.ana }];
  bolunmus.ekler.forEach((v, i) => yenileri.push({ ...ornek, name: `${kok}.${i + 1}`, value: v }));
  return { ...state, cookies: [...digerleri, ...yenileri] };
}

/**
 * Oturumu "süresi dolmuş" gösteren bir kopya üretir (istemciyi yenilemeye zorlamak için).
 * access_token / refresh_token KORUNUR; yalnızca expires_at geçmişe çekilir.
 * Böylece sitenin kendi istemcisi (Supabase GoTrue) jetonu yeniler — rotasyon meşru olur.
 * (Sunucu düz istekte yeni çerez vermiyor, tarayıcı ise jeton dolmadan yenilemiyor.)
 */
export function suresiGecmisKopya(deger, { saniyeOnce = 120 } = {}) {
  try {
    const ham = String(deger ?? '');
    const onek = ham.startsWith('base64-') ? 'base64-' : '';
    const govde = onek ? ham.slice(7) : ham;
    const json = JSON.parse(Buffer.from(govde, 'base64').toString('utf8'));
    json.expires_at = Math.floor(Date.now() / 1000) - saniyeOnce;
    return onek + Buffer.from(JSON.stringify(json)).toString('base64');
  } catch {
    return deger;
  }
}

/** Yenileme isteği/tarayıcısı için "süresi dolmuş" çerez seti (parçalı şemaya uygun). */
export function yenilemeIcinCerezler(state) {
  const ad = config.session.cookieName;
  const kok = ad.replace(/\.[0-9]+$/, '');
  const ana = oturumCereziniBul(state);
  if (!ana) return [];
  const zorlanmis = suresiGecmisKopya(birlesikCerezDegeri(state) ?? ana.value);
  const { ana: anaDeger, ekler } = cerezDegeriniBol(zorlanmis);
  const liste = [{ ...ana, name: ad, value: anaDeger }];
  ekler.forEach((v, i) => liste.push({ ...ana, name: `${kok}.${i + 1}`, value: v }));
  return liste;
}

/* ----------------------------- Yenileme yolları --------------------------- */

/** A) HTTP yolu: sayfaya çerezle istek → Set-Cookie ile gelen yeni oturum. */
export async function httpIleYenile() {
  const state = sessionStore.get(false);
  const cer = oturumCereziniBul(state);
  if (!cer) return { ok: false, sebep: 'oturum çerezi yok' };
  const parcalar = oturumParcaCerezleri(state);

  const url = `${config.target.baseUrl}${config.target.generatePath || '/'}`;
  const istekCerezleri = yenilemeIcinCerezler(state);
  const r = await fetch(url, {
    headers: {
      // parçalı şema: ana çerez + devam parçaları birlikte gönderilmeli.
      // "Süresi dolmuş" kopya gönderilir → sunucu istemciyi yenilemeye zorlar.
      cookie: istekCerezleri.map((c) => `${c.name}=${c.value}`).join('; '),
      'user-agent': config.stealth.userAgent,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': `${config.stealth.locale},en;q=0.8`,
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(config.session.refreshTimeoutMs),
  });

  const setCookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
  const kok = config.session.cookieName.replace(/\.[0-9]+$/, '');
  const gelenler = {};
  for (const s of setCookies) {
    const i = s.indexOf('=');
    if (i < 0) continue;
    const adi = s.slice(0, i).trim();
    if (adi !== cer.name && !(adi.startsWith(`${kok}.`) && /^\d+$/.test(adi.slice(kok.length + 1)))) continue;
    gelenler[adi] = s.slice(i + 1).split(';')[0];
  }

  if (!gelenler[cer.name] || gelenler[cer.name] === cer.value) {
    return { ok: false, sebep: `Set-Cookie ile yeni oturum gelmedi (HTTP ${r.status})` };
  }

  const yeniDurum = cerezleriUygula(state, gelenler);
  const bilgi = oturumCoz({ value: birlesikCerezDegeri(yeniDurum) });
  await oturumuKaliciYaz(yeniDurum, { neden: 'http' });
  return { ok: true, yol: 'http', yeniKalanDk: bilgi.kalanDk ?? null, refreshVar: bilgi.refreshVar ?? null };
}

/** B) Tarayıcı yolu: sayfayı aç → site kendi akışıyla yeniler → cookie jar'dan oku. */
export async function tarayiciIleYenile({ taskId = 'session-refresh' } = {}) {
  const kiralama = await browserManager.acquirePage({ taskId });
  try {
    const onceki = sessionStore.get(false);
    const cer = oturumCereziniBul(onceki);
    if (!cer) return { ok: false, sebep: 'oturum çerezi yok' };

    // NOT: Çerezi "süresi dolmuş" göstermeye ÇALIŞMA — arena.ai bunu yenileme değil
    // "oturum bitti" sayıp çerezleri siliyor (canlıda doğrulandı). Gerçek tarayıcı gibi
    // sayfayı açık tutup uygulamanın KENDİ yenilemesini bekliyoruz.
    const zorlanmisDeger = cer.value;

    // Sayfayı aç; çerez kendiliğinden değişene kadar bekle
    const url = `${config.target.baseUrl}${config.target.generatePath || '/'}`;
    await kiralama.page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.browser.navigationTimeoutMs }).catch(() => {});

    const kok = config.session.cookieName.replace(/\.[0-9]+$/, '');
    const parcaMi = (ad) => ad === config.session.cookieName || (ad.startsWith(`${kok}.`) && /^\d+$/.test(ad.slice(kok.length + 1)));
    const cerezleriTopla = async () => {
      const liste = await kiralama.context.cookies(config.target.baseUrl);
      const harita = {};
      for (const c of liste) if (parcaMi(c.name)) harita[c.name] = c.value;
      return harita;
    };

    let gelenler = await cerezleriTopla();
    // Bekleme süresi jetonun bitişine göre: uygulama, süresi dolunca yeniler.
    // (Sabit kısa bekleme, jeton henüz tazeyken boşa beklemeye yol açıyordu.)
    const durum = oturumDurumu();
    const kalanDk = Number.isFinite(durum?.kalanDk) ? durum.kalanDk : null;
    const dinamikMs = kalanDk === null ? config.session.browserRefreshWaitMs : Math.round((Math.max(kalanDk, 0) + 5) * 60_000);
    const bekleMs = Math.min(Math.max(dinamikMs, 120_000), config.session.browserRefreshWaitMs);
    log.info({ kalanDk, bekleDk: Math.round(bekleMs / 60_000) }, 'tarayıcı yolu: jeton değişimi bekleniyor');
    const bitis = Date.now() + bekleMs;
    let tur = 0;
    while (Date.now() < bitis && (!gelenler[config.session.cookieName] || gelenler[config.session.cookieName] === zorlanmisDeger)) {
      tur += 1;
      await kiralama.page.waitForTimeout(10000);
      // Sayfa "oturum bitti" diyerek çerezi sildiyse erken çık (nöbeti boşa uzatma)
      const simdiki = await cerezleriTopla();
      if (!simdiki[config.session.cookieName] && tur >= 6) {
        log.warn({ tur, sn: tur * 10 }, 'tarayıcı oturum çerezini sildi (jeton reddedildi?)');
        return { ok: false, sebep: 'tarayıcı oturum çerezini sildi (yenileme reddedildi)' };
      }
      gelenler = simdiki;
      // 5 dk'da bir sayfayı tazele — ilk açılışta istemci yenilemediyse şansı artırır
      if (tur % 30 === 0 && gelenler[config.session.cookieName] === zorlanmisDeger) {
        await kiralama.page.reload({ waitUntil: 'domcontentloaded', timeout: config.browser.navigationTimeoutMs }).catch(() => {});
      }
    }

    if (!gelenler[config.session.cookieName]) return { ok: false, sebep: 'tarayıcıda oturum çerezi bulunamadı' };
    if (gelenler[config.session.cookieName] === zorlanmisDeger || gelenler[config.session.cookieName] === cer.value) {
      return {
        ok: false,
        sebep: `tarayıcı yeni jeton yazmadı (${Math.round(bekleMs / 1000)} sn beklendi)`,
      };
    }

    const yeniDurum = cerezleriUygula(onceki, gelenler);
    const bilgi = oturumCoz({ value: birlesikCerezDegeri(yeniDurum) });
    if (!bilgi.ok) return { ok: false, sebep: `tarayıcıdan gelen yeni çerez çözülemedi: ${bilgi.sebep}` };
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
    if (!config.session.httpRefreshEnabled) {
      // Tek tüketici kuralı: HTTP yolu sunucuda YENİ jeton üretir; açık bir sayfa
      // eski jetonu kullanırsa "reuse" iptali olur. Bu yüzden devre dışı bırakılabilir.
      sonuc = { ok: false, sebep: 'HTTP yenileme kapalı (SESSION_HTTP_REFRESH=false)' };
    } else {
      try {
        sonuc = await httpIleYenile();
      } catch (e) {
        sonuc = { ok: false, sebep: `http hata: ${String(e.message).slice(0, 90)}` };
      }
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
 * Kendini yeniden planlayan bir zamanlayıcıdır:
 *   - başarılı yenileme / jeton taze → normal periyot (varsayılan 25 dk)
 *   - başarısız yenileme → üstel geri çekilme (en fazla 6 saat) — oturum gerçekten
 *     düşmüşse sürekli tarayıcı açıp kaynak tüketmesin.
 * Not: zamanlayıcı unref edilir; testlerin/sürecin kapanmasını engellemez.
 */
const AZAMI_GERI_CEKILME_MS = 6 * 60 * 60 * 1000;
let ardisikHata = 0;

function planla(ms) {
  zamanlayici = setTimeout(bekciTik, ms);
  zamanlayici.unref?.();
  return zamanlayici;
}

async function bekciTik() {
  const d = oturumDurumu();
  if (d.ok && d.kalanDk !== null && d.kalanDk > config.session.refreshThresholdMinutes) {
    ardisikHata = 0;
    log.debug({ kalanDk: d.kalanDk }, 'oturum bekçisi: jeton taze');
    planla(config.session.keepAliveMinutes * 60_000);
    return;
  }
  log.info({ kalanDk: d.kalanDk ?? null, ardisikHata }, 'oturum bekçisi: yenileme başlıyor');
  const sonuc = await oturumuYenile({ taskId: 'keepalive' }).catch((e) => ({ ok: false, sebep: String(e.message) }));
  const taban = config.session.keepAliveMinutes * 60_000;
  if (sonuc?.ok) {
    ardisikHata = 0;
    planla(taban);
    return;
  }
  ardisikHata = Math.min(ardisikHata + 1, 5);
  const bekle = Math.min(taban * 2 ** ardisikHata, AZAMI_GERI_CEKILME_MS);
  log.warn(
    { ardisikHata, bekleDk: Math.round(bekle / 60000), sebep: sonuc?.sebep ?? 'bilinmiyor' },
    'oturum yenilenemedi → geri çekilme (yeni çerez gerekli olabilir)',
  );
  planla(bekle);
}

export function oturumBekcisiniBaslat() {
  if (zamanlayici) return zamanlayici;
  const dk = config.session.keepAliveMinutes;
  if (!dk || dk <= 0) {
    log.info({}, 'oturum bekçisi kapalı (SESSION_KEEPALIVE_MINUTES=0)');
    return null;
  }
  log.info(
    { periyotDk: dk, esikDk: config.session.refreshThresholdMinutes, kalici: config.session.persist },
    'oturum bekçisi başladı',
  );
  // Açılışta hemen değil, kısa bir gecikmeyle ilk kontrol (önyükleme yükünü artırmasın)
  return planla(Math.min(30_000, dk * 60_000));
}

export function oturumBekcisiniDurdur() {
  if (zamanlayici) clearTimeout(zamanlayici);
  zamanlayici = null;
}

/* -------------------------------------------------------------------------- */
/*  Tarayıcıdan taze çerez yakalama                                           */
/* -------------------------------------------------------------------------- */
/**
 * Bir tarayıcı context'i kapandıktan sonra içindeki çerezleri okuyup, mevcut
 * oturumdan FARKLIYSA kalıcı hale getirir.
 *
 * NEDEN: arena.ai'nin kendi istemcisi access_token dolduğunda refresh_token'ı
 * döndürür ve YALNIZCA kendi context'inde saklar. Bu yeni jetonu yakalayıp
 * kaydetmezsek, bir sonraki context bayat jetonla yenilemeye çalışır ve
 * Supabase "refresh token reuse" tespitiyle TÜM aileyi iptal eder (canlıda
 * yaşandı: 06:29 hesap düştü). Tek tüketici kuralı: her kullanımdan sonra yakala.
 */
export async function tarayiciCerezleriniYakala(context, { neden = 'görev' } = {}) {
  if (!context) return { degisti: false, sebep: 'context yok' };
  try {
    const cerezler = await context.cookies(config.target.baseUrl);
    if (!cerezler.length) return { degisti: false, sebep: 'çerez yok' };
    const mevcut = sessionStore.get(false);
    const yeniDurum = {
      ...mevcut,
      cookies: cerezler.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
      })),
    };
    const eski = birlesikCerezDegeri(mevcut);
    const yeni = birlesikCerezDegeri(yeniDurum);
    if (yeni && yeni === eski) return { degisti: false };
    const bilgi = oturumCoz({ value: yeni });
    if (!bilgi.ok) {
      log.warn({ sebep: bilgi.sebep, neden }, 'tarayıcıdan gelen çerez çözülemedi — yazılmadı');
      return { degisti: false, sebep: bilgi.sebep };
    }
    await oturumuKaliciYaz(yeniDurum, { neden });
    log.info({ neden, kalanDk: bilgi.kalanDk, refreshVar: bilgi.refreshVar }, 'tarayıcıdan taze oturum yakalandı ve kaydedildi');
    return { degisti: true, kalanDk: bilgi.kalanDk, refreshVar: bilgi.refreshVar };
  } catch (e) {
    log.warn({ err: String(e.message).slice(0, 120), neden }, 'çerez yakalama başarısız');
    return { degisti: false, sebep: String(e.message).slice(0, 120) };
  }
}
