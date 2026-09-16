import { chromium } from 'playwright';
import fs from 'node:fs';

const OUT = '/home/user';
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ storageState: 'data/sessions/arena.json', viewport: { width: 1440, height: 1000 } });
const p = await ctx.newPage();
await p.goto('https://arena.ai/image/direct', { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForTimeout(8000);

const ozet = async () => p.evaluate(() => {
  const gorunur = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const btn = [...document.querySelectorAll('button,[role=button]')].filter(gorunur).map((e) => (e.innerText || e.getAttribute('aria-label') || '').trim().slice(0, 40)).filter(Boolean);
  const diyalog = [...document.querySelectorAll('[role=dialog],[role=alertdialog],dialog')].filter(gorunur).map((e) => (e.innerText || '').replace(/\s+/g, ' ').slice(0, 300));
  const ta = [...document.querySelectorAll('textarea,[contenteditable=true],input[type=text]')].filter(gorunur).map((e) => ({ etiket: e.getAttribute('placeholder') || e.getAttribute('aria-label'), deger: (e.value ?? e.innerText ?? '').slice(0, 60) }));
  const gorseller = [...document.querySelectorAll('img')].filter(gorunur).map((i) => (i.currentSrc || i.src || '').slice(0, 110)).filter((u) => u.startsWith('http'));
  const metin = document.body.innerText.replace(/\s+/g, ' ');
  return { btn: [...new Set(btn)], diyalog, ta, gorseller: gorseller.slice(0, 10), metinSon: metin.slice(-500), metinBasi: metin.slice(0, 500) };
});

let d = await ozet();
console.log('=== 1) İLK YÜKLEME ===');
console.log('butonlar:', JSON.stringify(d.btn));
console.log('diyaloglar:', JSON.stringify(d.diyalog));
console.log('metin kutuları:', JSON.stringify(d.ta));
console.log('görseller:', JSON.stringify(d.gorseller));
console.log('metin başı:', d.metinBasi);
console.log('metin sonu:', d.metinSon);
await p.screenshot({ path: `${OUT}/tani-1-ilk.png`, fullPage: false });

// Diyalog varsa kapatmayı dene: her görünür butona sırayla bas
if (d.diyalog.length) {
  console.log('\n=== 2) DİYALOG KAPATMA DENEMESİ ===');
  for (const metin of d.btn) {
    try {
      const loc = p.getByRole('button', { name: metin, exact: false }).first();
      if (await loc.count() === 0) continue;
      if (!(await loc.isVisible())) continue;
      await loc.click({ timeout: 4000 });
      await p.waitForTimeout(2500);
      const sonra = await ozet();
      console.log(`  "${metin}" tıklandı → diyalog sayısı: ${sonra.diyalog.length}`);
      if (sonra.diyalog.length === 0) { console.log('  ✅ kapandı:', metin); d = sonra; break; }
    } catch (e) { console.log(`  "${metin}" başarısız: ${String(e.message).slice(0, 60)}`); }
  }
  await p.screenshot({ path: `${OUT}/tani-2-diyalog-sonrasi.png` });
}

// Enter ile göndermeyi dene
console.log('\n=== 3) PROMPT + ENTER ===');
try {
  const ta = p.locator('textarea, [contenteditable=true]').first();
  await ta.click({ timeout: 10000 });
  await ta.fill('test onay kapısı denemesi, kırmızı elma, stüdyo ışığı');
  await p.waitForTimeout(500);
  await ta.press('Enter');
  await p.waitForTimeout(4000);
  const sonra = await ozet();
  console.log('butonlar:', JSON.stringify(sonra.btn));
  console.log('diyaloglar:', JSON.stringify(sonra.diyalog));
  console.log('metin kutuları:', JSON.stringify(sonra.ta));
  console.log('görseller:', JSON.stringify(sonra.gorseller));
  console.log('metin sonu:', sonra.metinSon);
  await p.screenshot({ path: `${OUT}/tani-3-enter-sonrasi.png` });

  // 90 sn görsel bekle
  console.log('\n=== 4) GÖRSEL BEKLEME (90 sn) ===');
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    await p.waitForTimeout(5000);
    const g = await p.evaluate(() => [...document.querySelectorAll('img')].map((i) => i.currentSrc || i.src).filter((u) => u.includes('cloudflarestorage') || u.includes('arena')));
    if (g.length) { console.log(`  ${Math.round((Date.now() - t0) / 1000)}s → GÖRSEL: ${g[0].slice(0, 130)}`); break; }
    if ((Date.now() - t0) % 15000 < 5000) console.log(`  ${Math.round((Date.now() - t0) / 1000)}s → görsel yok...`);
  }
  await p.screenshot({ path: `${OUT}/tani-4-son.png` });
} catch (e) { console.log('HATA:', String(e.message).slice(0, 200)); }

await b.close();
