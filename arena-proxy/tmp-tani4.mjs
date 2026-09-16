import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ storageState: 'data/sessions/arena.json', viewport: { width: 1440, height: 1000 } });
const p = await ctx.newPage();
const kal = (s) => console.log(`   ${s}`);

const diyalogAcik = async () => {
  const d = p.locator('[role=dialog][data-state=open], [role=alertdialog]').first();
  return (await d.count()) ? d.isVisible().catch(() => false) : false;
};
const kapat = async () => {
  for (const ad of ['Agree', 'I Agree', 'Accept', 'Got it']) {
    for (const kapsam of [p.locator('[role=dialog]').first(), p]) {
      const l = kapsam.getByRole('button', { name: ad, exact: false }).first();
      if (await l.count().catch(() => 0) && await l.isVisible().catch(() => false)) {
        await l.click({ timeout: 8000 }).catch(async () => l.click({ timeout: 8000, force: true }));
        await p.waitForTimeout(2000);
        kal(`"${ad}" tıklandı → diyalog açık mı: ${await diyalogAcik()}`);
        return true;
      }
    }
  }
  return false;
};

await p.goto('https://arena.ai/image/direct', { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForTimeout(6000);
kal(`yüklendi | diyalog açık mı: ${await diyalogAcik()} | Log In görünür: ${await p.getByRole('button', { name: 'Log In' }).first().isVisible().catch(() => false)}`);
if (await diyalogAcik()) await kapat();

const ta = p.locator('textarea:not(.g-recaptcha-response), [contenteditable=true]').first();
await ta.click({ timeout: 15000 });
await ta.fill('kırmızı elma, stüdyo ışığı, beyaz arka plan, ürün fotoğrafı');
kal('prompt yazıldı');
await p.waitForTimeout(400);
await ta.press('Enter');
await p.waitForTimeout(3000);
kal(`Enter sonrası | diyalog açık mı: ${await diyalogAcik()} | kutuda: ${JSON.stringify((await ta.inputValue().catch(() => '')).slice(0, 40))}`);
if (await diyalogAcik()) { await kapat(); await ta.click({ timeout: 10000 }); await ta.press('Enter'); kal('Enter tekrar gönderildi'); }

const t0 = Date.now();
let sonuc = null;
while (Date.now() - t0 < 170000) {
  await p.waitForTimeout(5000);
  const s = await p.evaluate(() => ({
    yol: location.pathname,
    g: [...document.querySelectorAll('img')].map((i) => i.currentSrc || i.src).filter((u) => u.includes('cloudflarestorage')),
    metin: document.body.innerText.replace(/\s+/g, ' ').slice(-160),
  }));
  if (s.g.length) { sonuc = s.g[0]; kal(`✅ ${Math.round((Date.now()-t0)/1000)}s GÖRSEL: ${s.g[0].slice(0, 130)}`); break; }
  kal(`${Math.round((Date.now()-t0)/1000)}s yol=${s.yol} son="${s.metin.slice(-100)}"`);
}
await p.screenshot({ path: '/home/user/tani-6-fonksiyonel.png' });
if (!sonuc) kal('❌ 170 sn içinde görsel yok');
await b.close();
