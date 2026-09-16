/**
 * src/utils/humanize.js
 * ---------------------------------------------------------------------------
 * İnsan benzeri etkileşim yardımcıları. Bot skorlaması yapan platformlar
 * (Cloudflare/Turnstile, DataDome, PerimeterX) "mükemmel" mouse hareketini,
 * 0 gecikmeli yazmayı ve anlık tıklamayı işaretler.
 *
 * Buradaki gecikmeler kasten "yavaş ama doğal" aralıkta seçilmiştir.
 */
import { config } from '../config/index.js';
import { logger } from './logger.js';

const log = logger.child({ mod: 'humanize' });

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Kısa, insan benzeri duraklama (200-600ms) */
export async function microPause(factor = 1) {
  if (!config.stealth.humanize) return;
  await sleep(randomBetween(180, 520) * factor);
}

/** Fareyi hedefe birkaç adımda, hafif eğriyle taşıyıp tıkla */
export async function humanClick(locator, { timeout = config.target.stepTimeoutMs } = {}) {
  await locator.waitFor({ state: 'visible', timeout });
  await locator.scrollIntoViewIfNeeded().catch(() => {});

  if (!config.stealth.humanize) {
    await locator.click({ timeout, noWaitAfter: false });
    return;
  }

  const box = await locator.boundingBox();
  if (!box) {
    await locator.click({ timeout });
    return;
  }
  const page = locator.page();
  const targetX = box.x + box.width * (0.3 + Math.random() * 0.4);
  const targetY = box.y + box.height * (0.3 + Math.random() * 0.4);

  // Yaklaşım: ekranın farklı bir noktasından hedefe doğru 8-14 adımlık bezier benzeri hareket
  let x = targetX - randomBetween(120, 380);
  let y = targetY - randomBetween(60, 220);
  const steps = randomBetween(8, 14);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = t * t * (3 - 2 * t); // smoothstep
    const nx = x + (targetX - x) * ease + (Math.random() - 0.5) * 6;
    const ny = y + (targetY - y) * ease + (Math.random() - 0.5) * 6;
    await page.mouse.move(nx, ny);
    await sleep(randomBetween(8, 30));
    x = nx;
    y = ny;
  }
  await sleep(randomBetween(60, 180));
  // Gerçek kullanıcı buton merkezine tam oturmaz: hedef bölge içinde offset'li tıkla
  await page.mouse.click(targetX, targetY, { delay: randomBetween(20, 80) });
  log.trace({ targetX, targetY }, 'humanClick tamamlandı');
}

/** Metni karakter karakter, değişken gecikmelerle yaz; arada düşünme duraklamaları ekle */
export async function humanType(locator, text, { clear = true, timeout = config.target.stepTimeoutMs } = {}) {
  await locator.waitFor({ state: 'visible', timeout });
  await locator.click({ timeout, delay: randomBetween(20, 60) });

  if (clear) {
    await locator.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => {});
    await locator.press('Backspace').catch(() => {});
  }

  if (!config.stealth.humanize) {
    await locator.fill(text);
    return;
  }

  const chunks = chunkText(text);
  for (const chunk of chunks) {
    await locator.type(chunk, { delay: randomBetween(35, 110) });
    if (Math.random() < 0.25) await sleep(randomBetween(250, 900)); // düşünme payı
    if (Math.random() < 0.07) await locator.press('Backspace'); // nadir düzeltme davranışı
  }
  await microPause();
}

/** Uzun prompt'ları doğal parçalara böl */
function chunkText(text, { min = 12, max = 45 } = {}) {
  const words = String(text).split(/(\s+)/);
  const out = [];
  let buf = '';
  let limit = randomBetween(min, max);
  for (const w of words) {
    buf += w;
    if (buf.length >= limit) {
      out.push(buf);
      buf = '';
      limit = randomBetween(min, max);
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** Butona tıklamadan önce küçük bir tereddüt + tıklama sonrası bekleme */
export async function hesitantClick(locator, opts = {}) {
  await sleep(randomBetween(120, 420));
  await humanClick(locator, opts);
}

/** Sayfa kaydırma simülasyonu (bazı SPA'lar scroll olmadan render etmez) */
export async function humanScroll(page, { steps = 3 } = {}) {
  if (!config.stealth.humanize) return;
  for (let i = 0; i < steps; i++) {
    const delta = randomBetween(80, 320);
    await page.mouse.wheel(0, delta);
    await sleep(randomBetween(150, 480));
  }
}
