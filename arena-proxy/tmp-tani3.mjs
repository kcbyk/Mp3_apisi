import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ storageState: 'data/sessions/arena.json', viewport: { width: 1440, height: 1000 } });
const p = await ctx.newPage();
const istekler = [];
p.on('response', async (r) => { const u = r.url(); if (/sign-?up|auth|session|refresh/i.test(u) && !/\.(js|css|png|woff2?)/.test(u)) istekler.push(`${r.status()} ${u.slice(0, 110)}`); });

await p.goto('https://arena.ai/image/direct', { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForTimeout(7000);

// oturum durumu
const durum1 = await p.evaluate(() => ({
  girisMetni: document.body.innerText.includes('Log In'),
  ckSayisi: document.cookie.split(';').length,
  ckAdlar: document.cookie.split(';').map((c) => c.trim().split('=')[0]),
  yerelDepo: Object.keys(localStorage).slice(0, 20),
}));
console.log('1) yükleme sonrası:', JSON.stringify(durum1));

// prompt yaz
const ta = p.locator('textarea:not(.g-recaptcha-response), [contenteditable=true]').first();
await ta.click({ timeout: 15000 });
await ta.fill('kırmızı bir elma, stüdyo ışığı, beyaz arka plan');
await p.waitForTimeout(400);
await ta.press('Enter');
await p.waitForTimeout(3500);

// diyalog çıktıysa Agree'ye tıkla
const dlg = p.getByRole('dialog').first();
if (await dlg.count() && await dlg.isVisible().catch(() => false)) {
  console.log('2) onay kapısı AÇILDI → "Agree" tıklanıyor');
  await p.getByRole('button', { name: 'Agree', exact: true }).first().click({ timeout: 8000 });
  await p.waitForTimeout(2500);
  const kapandi = !(await p.getByRole('dialog').first().isVisible().catch(() => false));
  console.log('   diyalog kapandı mı:', kapandi);
  const deger = await ta.inputValue().catch(() => '(yok)');
  console.log('   metin kutusu:', JSON.stringify(deger.slice(0, 70)));
  if (deger) { await ta.click(); await ta.press('Enter'); console.log('3) Enter tekrar gönderildi'); }
} else { console.log('2) diyalog yok (kapı zaten kapalı)'); }

// sonuç bekle
const t0 = Date.now();
let bulundu = null;
while (Date.now() - t0 < 150000) {
  await p.waitForTimeout(5000);
  const s = await p.evaluate(() => ({
    url: location.pathname,
    gorseller: [...document.querySelectorAll('img')].map((i) => i.currentSrc || i.src).filter((u) => u.includes('cloudflarestorage') || u.includes('blob:')),
    metin: [...document.querySelectorAll('button,[role=button]')].map((e) => (e.innerText || '').trim()).filter(Boolean).slice(0, 14),
    son: document.body.innerText.replace(/\s+/g, ' ').slice(-200),
  }));
  if (s.gorseller.length) { bulundu = s.gorseller[0]; console.log(`\n✅ ${Math.round((Date.now()-t0)/1000)}s → GÖRSEL: ${bulundu.slice(0,140)}`); break; }
  console.log(`${Math.round((Date.now()-t0)/1000)}s | yol=${s.url} | butonlar=${JSON.stringify(s.metin)} | son="${s.son.slice(-110)}"`);
  if (/sign-?up|login/i.test(s.url)) { console.log('⚠️  oturum açma sayfasına yönlendirildi → OTURUM GEÇERSİZ'); break; }
}
console.log('\nauth ile ilgili istekler:', JSON.stringify([...new Set(istekler)].slice(0, 8), null, 0));
await p.screenshot({ path: '/home/user/tani-5-fonksiyonel.png' });
await b.close();
