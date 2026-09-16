import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ storageState: 'data/sessions/arena.json', viewport: { width: 1440, height: 1000 } });
const p = await ctx.newPage();
const log = (s) => console.log(`[TANI] ${s}`);

const durum = () => p.evaluate(() => {
  const dl = [...document.querySelectorAll('[role=dialog],[role=alertdialog]')];
  const ta = document.querySelector('textarea[name=message]');
  return {
    diyalogSayisi: dl.length,
    durumlar: dl.map((d) => d.getAttribute('data-state') || 'yok'),
    diyalogButonlari: dl.flatMap((d) => [...d.querySelectorAll('button')].map((x) => `${(x.innerText || '').trim()}${x.disabled ? '(kapalı)' : ''}`)),
    kutuDeger: ta ? ta.value.slice(0, 45) : null,
    girisVar: document.body.innerText.includes('Log In'),
    gorselSayisi: document.querySelectorAll('img').length,
    yol: location.pathname,
  };
});
const jsClick = (ad) => p.evaluate((hedef) => {
  const bts = [...document.querySelectorAll('button')].filter((x) => (x.innerText || '').trim().toLowerCase() === hedef.toLowerCase() && !x.disabled);
  if (!bts.length) return 'buton-yok';
  bts[0].click();
  return 'tıklandı';
}, ad);

await p.goto('https://arena.ai/image/direct', { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForTimeout(6000);
log('1 yükleme: ' + JSON.stringify(await durum()));

for (let tur = 1; tur <= 3; tur++) {
  const d = await durum();
  if (!d.diyalogSayisi) break;
  log(`2.${tur} kapatma denemesi`);
  log('   JS-click Agree → ' + await jsClick('Agree'));
  await p.waitForTimeout(2000); log('   sonra: ' + JSON.stringify(await durum()));
  if ((await durum()).diyalogSayisi) {
    await p.keyboard.press('Escape'); await p.waitForTimeout(1500);
    log('   Escape sonrası: ' + JSON.stringify(await durum()));
  }
  if ((await durum()).diyalogSayisi) {
    await p.keyboard.press('Enter'); await p.waitForTimeout(1500);
    log('   Enter sonrası: ' + JSON.stringify(await durum()));
  }
}

const ta = p.locator('textarea[name=message]').first();
await ta.fill('kırmızı elma, stüdyo ışığı, beyaz arka plan, ürün fotoğrafı').catch((e) => log('fill hata: ' + e.message.slice(0, 60)));
log('3 prompt yazıldı: ' + JSON.stringify(await durum()));
await ta.press('Enter');
await p.waitForTimeout(3000);
log('4 Enter sonrası: ' + JSON.stringify(await durum()));
if ((await durum()).diyalogSayisi) {
  log('   → Agree JS-click: ' + await jsClick('Agree'));
  await p.waitForTimeout(2000);
  log('   → ' + JSON.stringify(await durum()));
  await ta.press('Enter');
  await p.waitForTimeout(2500);
  log('   → 2. Enter sonrası: ' + JSON.stringify(await durum()));
}

const t0 = Date.now();
while (Date.now() - t0 < 150000) {
  await p.waitForTimeout(8000);
  const s = await p.evaluate(() => ({
    gorsel: [...document.querySelectorAll('img')].map((i) => i.currentSrc || i.src).filter((u) => u.includes('cloudflarestorage'))[0] || null,
    son: document.body.innerText.replace(/\s+/g, ' ').slice(-130),
  }));
  if (s.gorsel) { log(`5 ✅ ${Math.round((Date.now()-t0)/1000)}s GÖRSEL: ${s.gorsel.slice(0, 130)}`); break; }
  log(`5 ${Math.round((Date.now()-t0)/1000)}s bekliyor... son="${s.son.slice(-90)}"`);
}
await p.screenshot({ path: '/home/user/tani-7-son.png' });
await b.close();
