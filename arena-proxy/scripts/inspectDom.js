#!/usr/bin/env node
/**
 * scripts/inspectDom.js
 * ---------------------------------------------------------------------------
 * "Selector doktoru": hedef sayfayı (session ile) açar ve selectors/arena.json
 * içindeki hangi stratejinin gerçek DOM'da tuttuğunu raporlar. DOM değiştiğinde
 * JSON dosyasını elle düzenlemek yerine bu çıktıyla hızlıca düzeltirsin.
 *
 * Kullanım:
 *   npm run session:inspect                       # TARGET_GENERATE_PATH
 *   node scripts/inspectDom.js --url https://arena.ai/image --dump
 *   node scripts/inspectDom.js --keys promptInput,generateButton
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { config, ensureRuntimeDirs, ROOT_DIR } from '../src/config/index.js';
import { loadSelectors } from '../src/scrapers/arenaScraper.js';
import { strategyToLocator, resetSelectorStats } from '../src/utils/resilientSelector.js';
import { sessionStore } from '../src/automation/sessionStore.js';

function parseArgs(argv) {
  const args = { url: `${config.target.baseUrl}${config.target.generatePath}` };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url') args.url = argv[++i];
    else if (argv[i] === '--keys') args.keys = argv[++i].split(',').map((s) => s.trim());
    else if (argv[i] === '--dump') args.dump = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  ensureRuntimeDirs();
  resetSelectorStats();

  const useProfile = config.browser.persistentProfile || config.session.mode === 'profile';
  let context;
  let browser;

  if (useProfile) {
    const userDataDir = path.join(config.browser.profileBaseDir, 'inspect');
    fs.mkdirSync(userDataDir, { recursive: true });
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: config.browser.headless,
      viewport: config.browser.viewport,
      locale: config.stealth.locale,
      timezoneId: config.stealth.timezoneId,
      userAgent: config.stealth.userAgent,
    });
    browser = context.browser();
  } else {
    const storageState = sessionStore.exists() ? sessionStore.get(false) : undefined;
    browser = await chromium.launch({ headless: config.browser.headless });
    context = await browser.newContext({
      storageState,
      viewport: config.browser.viewport,
      locale: config.stealth.locale,
      timezoneId: config.stealth.timezoneId,
      userAgent: config.stealth.userAgent,
    });
  }

  const page = context.pages()[0] ?? (await context.newPage());
  console.log(`▶ Açılıyor: ${args.url}${sessionStore.exists() ? ' (session yüklendi)' : ' (SESSION YOK — public sayfa)'}`);
  await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

  const selectors = loadSelectors(true);
  const keys = args.keys ?? Object.keys(selectors).filter((k) => !k.startsWith('$'));

  console.log('\n=== SELECTOR RAPORU ===');
  for (const key of keys) {
    const strategies = selectors[key];
    if (!Array.isArray(strategies)) continue;
    const results = [];
    for (let i = 0; i < strategies.length; i++) {
      const s = strategies[i];
      try {
        const loc = strategyToLocator(page, s);
        const count = await loc.count();
        let visible = 0;
        for (let k = 0; k < Math.min(count, 5); k++) {
          if (await loc.nth(k).isVisible().catch(() => false)) visible++;
        }
        results.push({ i, by: s.by, value: s.value ?? s.role ?? '', count, visible });
      } catch (err) {
        results.push({ i, by: s.by, value: s.value ?? s.role ?? '', count: -1, error: err.message.split('\n')[0] });
      }
    }
    const best = results.find((r) => r.visible > 0) ?? results.find((r) => r.count > 0);
    const flag = best ? '✅' : '❌';
    console.log(`\n${flag} ${key}`);
    for (const r of results) {
      const mark = best && r.i === best.i ? ' ← ÖNERİLEN' : '';
      console.log(
        `   [${r.i}] ${r.by.padEnd(12)} ${String(r.value).slice(0, 44).padEnd(46)} eşleşme=${r.count} görünür=${r.visible}${r.error ? ` hata=${r.error}` : ''}${mark}`,
      );
    }
  }

  if (args.dump) {
    const out = path.join(ROOT_DIR, 'data', 'dom-dump.html');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, await page.content(), 'utf8');
    console.log(`\n💾 DOM dökümü: ${out}`);
  }

  const shots = path.join(config.target.screenshotDir, 'inspect.png');
  fs.mkdirSync(config.target.screenshotDir, { recursive: true });
  await page.screenshot({ path: shots, fullPage: false });
  console.log(`📸 Ekran görüntüsü: ${shots}`);

  await context.close();
  await browser.close().catch(() => {});
}

main().catch((err) => {
  console.error('inspect başarısız:', err.message);
  process.exit(1);
});
