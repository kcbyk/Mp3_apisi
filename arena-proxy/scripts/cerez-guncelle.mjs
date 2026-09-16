#!/usr/bin/env node
/**
 * scripts/cerez-guncelle.mjs
 * ---------------------------------------------------------------------------
 * arena.ai oturumunu TEK KOMUTLA günceller:  dosya → yerel oturum → Render env
 * → yeniden dağıtım → oturum doğrulaması.
 *
 * Neden gerekli: Arena/Supabase yenileme jetonunu DÖNDÜRÜR. Dışa aktarılan
 * çerez, kaynak tarayıcı arena.ai'yi kullandıkça geçersizleşir. Bu yüzden
 * üretimden hemen önce taze çerez alıp bu betiği koşturmak en güvenli yoldur.
 *
 * Kullanım:
 *   node scripts/cerez-guncelle.mjs --dosya ~/arena-cerez.json
 *   node scripts/cerez-guncelle.mjs --dosya ~/arena-cerez.json --kuru      # sadece yerel dosya
 *   node scripts/cerez-guncelle.mjs --metin "a=b; c=d"                     # document.cookie
 *   node scripts/cerez-guncelle.mjs --dosya ... --env                      # base64'ü ekrana yaz
 *
 * Kabul edilen girdiler:
 *   1) Cookie-Editor "Export as JSON"  → [{name,value,domain,...}, ...]   (ÖNERİLEN)
 *   2) Playwright storageState         → {cookies:[...],origins:[...]}
 *   3) Tek cookie nesnesi              → {name,value,...}
 *   4) "a=b; c=d" başlık metni         → ⚠️ httpOnly çerezler GÖRÜNMEZ
 *   5) Netscape cookies.txt satırları
 *
 * Render otomasyonu için ortam değişkenleri (opsiyonel):
 *   RENDER_API_KEY, RENDER_SERVICE_ID, RENDER_HEALTH_URL
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { ROOT_DIR } from '../src/config/index.js';

const arg = (ad) => {
  const i = process.argv.indexOf(ad);
  return i > -1 ? process.argv[i + 1] : null;
};
const bayrak = (ad) => process.argv.includes(ad);
const HEDEF_DOMAIN = '.arena.ai';
const KRITIK_CEREZ = 'arena-auth-prod-v1.0';

/* ------------------------------- Ayrıştırma ------------------------------- */
function cerezleriCikar(ham) {
  const metin = String(ham).trim();

  // JSON denemesi
  try {
    const j = JSON.parse(metin);
    const dizi = Array.isArray(j) ? j : Array.isArray(j?.cookies) ? j.cookies : j?.name ? [j] : [];
    if (dizi.length) {
      return dizi.map((c) => ({
        name: String(c.name),
        value: String(c.value ?? ''),
        domain: c.domain || HEDEF_DOMAIN,
        path: c.path || '/',
        expires: typeof c.expirationDate === 'number' ? c.expirationDate : typeof c.expires === 'number' ? c.expires : -1,
        httpOnly: c.httpOnly ?? true,
        secure: c.secure ?? true,
        sameSite: ['Strict', 'Lax', 'None'].includes(c.sameSite) ? c.sameSite : c.sameSite === 'no_restriction' ? 'None' : 'Lax',
      }));
    }
  } catch {
    /* JSON değil → diğer biçimleri dene */
  }

  // Netscape cookies.txt: domain \t flag \t path \t secure \t expiry \t name \t value
  if (/^#|\t/.test(metin)) {
    const satirlar = metin
      .split(/\r?\n/)
      .filter((s) => s && !s.startsWith('#') && s.includes('\t'))
      .map((s) => s.split('\t'));
    if (satirlar.length) {
      return satirlar
        .filter((p) => p.length >= 7)
        .map((p) => ({
          name: p[5],
          value: p[6],
          domain: p[0].startsWith('.') ? p[0] : `.${p[0].replace(/^\./, '')}`,
          path: p[2] || '/',
          expires: Number(p[4]) || -1,
          httpOnly: p[1]?.toUpperCase() === 'TRUE' || true,
          secure: true,
          sameSite: 'Lax',
        }));
    }
  }

  // "a=b; c=d" başlık metni
  if (metin.includes('=')) {
    return metin
      .split(';')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const i = p.indexOf('=');
        return {
          name: p.slice(0, i).trim(),
          value: p.slice(i + 1),
          domain: HEDEF_DOMAIN,
          path: '/',
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        };
      })
      .filter((c) => c.name && c.value);
  }

  return [];
}

/* --------------------------------- Girdi ---------------------------------- */
const kaynakDosya = arg('--dosya');
const metinGirdi = arg('--metin') ?? arg('--metin-dosyasi');
let ham = '';

if (kaynakDosya) {
  const tam = kaynakDosya.replace(/^~/, process.env.HOME || '~');
  if (!fs.existsSync(tam)) {
    console.error(`\n❌ Dosya bulunamadı: ${tam}\n`);
    process.exit(1);
  }
  ham = fs.readFileSync(tam, 'utf8');
  console.log(`\n📄 Kaynak: ${tam}`);
} else if (metinGirdi) {
  const tam = metinGirdi.replace(/^~/, process.env.HOME || '~');
  ham = fs.existsSync(tam) ? fs.readFileSync(tam, 'utf8') : metinGirdi;
  console.log(`\n📄 Kaynak: ${fs.existsSync(tam) ? tam : 'komut satırı metni'}`);
} else {
  console.error(`
Kullanım:
  node scripts/cerez-guncelle.mjs --dosya ~/arena-cerez.json [--kuru] [--env]
  node scripts/cerez-guncelle.mjs --metin "arena-auth-prod-v1.0=...; _ga=..."

Cookie-Editor ile: arena.ai'de giriş yapılı sayfada uzantı → "Export as JSON" → dosyaya kaydet.
`);
  process.exit(1);
}

const cerezler = cerezleriCikar(ham);
if (!cerezler.length) {
  console.error('\n❌ Girdiden hiç çerez çıkarılamadı. Cookie-Editor "Export as JSON" çıktısını deneyin.\n');
  process.exit(1);
}

/* ------------------------------ Doğrulama/durum ---------------------------- */
const adlar = cerezler.map((c) => c.name);
const kritikVar = adlar.includes(KRITIK_CEREZ);
const kritikUzunluk = kritikVar ? cerezler.find((c) => c.name === KRITIK_CEREZ).value.length : 0;

console.log(`   çerez sayısı : ${cerezler.length}`);
console.log(`   çerezler     : ${adlar.slice(0, 14).join(', ')}${adlar.length > 14 ? ' …' : ''}`);
console.log(`   ${KRITIK_CEREZ}: ${kritikVar ? `${kritikUzunluk} karakter` : 'YOK'}`);

if (!kritikVar) {
  console.warn(
    `\n⚠️  ${KRITIK_CEREZ} çerezi yok. Bu çerez httpOnly'dir; document.cookie çıktısında GÖRÜNMEZ.\n` +
      '   Cookie-Editor (veya DevTools → Application → Cookies) ile tam dışa aktarım gerekir.\n' +
      '   Yine de yazıp deniyorum — başarısız olursa tam dışa aktarım isteyin.',
  );
}
if (kritikVar && (kritikUzunluk < 1500 || kritikUzunluk > 4096)) {
  console.warn(
    `\n⚠️  ${KRITIK_CEREZ} uzunluğu ${kritikUzunluk} karakter (beklenen ~2000-4096).\n` +
      '   Kısa kopyalar (kırpılmış base64) oturumu açmaz; tarayıcıda çerezi kırpmadan kopyalayın.',
  );
}

/* ------------------------------ Yerel yazım ------------------------------- */
const durum = { cookies: cerezler, origins: [] };
const hedef = path.join(ROOT_DIR, 'data', 'sessions', 'arena.json');
fs.mkdirSync(path.dirname(hedef), { recursive: true });
fs.writeFileSync(hedef, JSON.stringify(durum, null, 2), { mode: 0o600 });
console.log(`\n✅ Yerel oturum yazıldı: ${path.relative(ROOT_DIR, hedef)} (izin 600)`);

const b64 = Buffer.from(JSON.stringify(durum), 'utf8').toString('base64');
console.log(`   SESSION_STATE_B64 uzunluğu: ${b64.length} karakter (değer gizli tutuldu)`);

if (bayrak('--env')) {
  console.log(`\nSESSION_STATE_B64=${b64}\n`);
}

if (bayrak('--kuru')) {
  console.log('\n(--kuru) Render adımı atlandı. Elle: Render → Environment → SESSION_STATE_B64 → Manual Deploy.\n');
  process.exit(0);
}

/* --------------------------- Render'a aktarım ----------------------------- */
const rKey = process.env.RENDER_API_KEY;
const rService = process.env.RENDER_SERVICE_ID;
const saglikUrl = process.env.RENDER_HEALTH_URL || 'https://arena-proxy.onrender.com/health';

if (!rKey || !rService) {
  console.log(
    '\nℹ️  RENDER_API_KEY / RENDER_SERVICE_ID tanımlı değil → Render adımı elle yapılmalı:\n' +
      '   1) Render → arena-proxy → Environment → SESSION_STATE_B64 güncelle\n' +
      '   2) Manual Deploy (Clear build cache & deploy)\n' +
      '   3) Doğrula: curl "<proxy>/api/v1/session-dogrula" -H "x-api-key: <API_KEYS değeri>"\n',
  );
  process.exit(0);
}

const apiBase = `https://api.render.com/v1/services/${rService}`;
const basliklar = { Authorization: `Bearer ${rKey}`, 'Content-Type': 'application/json' };
const bekle = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n→ Render: SESSION_STATE_B64 güncelleniyor…');
let y = await fetch(`${apiBase}/env-vars/SESSION_STATE_B64`, {
  method: 'PUT',
  headers: basliklar,
  body: JSON.stringify({ value: b64 }),
});
if (!y.ok) {
  console.error(`❌ Env güncellenemedi: HTTP ${y.status} ${(await y.text()).slice(0, 200)}`);
  process.exit(1);
}
console.log('✅ Env güncellendi');

console.log('→ Render: yeniden dağıtım tetikleniyor…');
y = await fetch(`${apiBase}/deploys`, { method: 'POST', headers: basliklar, body: JSON.stringify({ clearCache: 'clear' }) });
if (!y.ok) {
  console.error(`❌ Dağıtım tetiklenemedi: HTTP ${y.status} ${(await y.text()).slice(0, 200)}`);
  process.exit(1);
}
const depGovde = await y.json();
const dep = depGovde.deploy ?? depGovde;
console.log(`✅ Dağıtım: ${dep.id ?? '(id yok)'} — canlı olması bekleniyor (2-4 dk)`);

const proxyTaban = saglikUrl.replace(/\/health$/, '');
const proxyKey = process.env.RENDER_PROXY_API_KEY || '';
let canli = false;
for (let i = 0; i < 60; i += 1) {
  await bekle(15000);
  try {
    const r = await fetch(saglikUrl, { signal: AbortSignal.timeout(20000) });
    if (r.ok) {
      const h = await r.json();
      if (h?.status === 'ok') {
        canli = true;
        console.log(`   ${new Date().toISOString().slice(11, 19)} servis canlı`);
        break;
      }
    }
  } catch {
    /* yeniden başlıyor */
  }
  if (i % 4 === 3) console.log(`   ${new Date().toISOString().slice(11, 19)} bekleniyor…`);
}
if (!canli) {
  console.warn('\n⚠️  Servis 15 dakikada canlı görünmedi — Render panelinden dağıtımı kontrol edin.');
  process.exit(1);
}

console.log('\n→ Oturum doğrulanıyor (/api/v1/session-dogrula)…');
if (!proxyKey) {
  console.log('   ℹ️  RENDER_PROXY_API_KEY verilmedi → doğrulamayı elle yapın.');
  process.exit(0);
}
for (let i = 0; i < 12; i += 1) {
  try {
    const r = await fetch(`${proxyTaban}/api/v1/session-dogrula`, { headers: { 'x-api-key': proxyKey }, signal: AbortSignal.timeout(120000) });
    const d = await r.json();
    if (d.oturum_gecerli) {
      console.log(`\n🎉 OTURUM GEÇERLİ — ${d.sebep} (${d.sure_ms}ms)\n   Artık üretim yapabilirsiniz.`);
      process.exit(0);
    }
    console.log(`   ${i + 1}. deneme → geçersiz: ${d.sebep}`);
  } catch (e) {
    console.log(`   ${i + 1}. deneme → hata: ${String(e.message).slice(0, 80)}`);
  }
  await bekle(20000);
}
console.warn(`\n⚠️  Oturum hâlâ geçersiz görünüyor. Çerezde ${KRITIK_CEREZ} tam mı? Kaynak tarayıcıda arena.ai kullanıldı mı?`);
process.exit(1);
