/**
 * src/utils/resilientSelector.js
 * ---------------------------------------------------------------------------
 * Resilient selector mimarisi.
 *
 * Hedef platformun DOM'u her deploy'da değişebilir. Bu yüzden tek bir CSS
 * selector yerine **strateji zinciri** tanımlarız. Zincir sırayla denenir,
 * ilk çalışan kazanır ve hangi stratejinin tuttuğu metrik olarak kaydedilir
 * (self-healing: `GET {prefix}/debug/selectors` ile raporlanır, böylece
 * selector dosyasını gerçek DOM'a göre yeniden sıralayabilirsin).
 *
 * Desteklenen stratejiler:
 *   { by: "testid",  value: "prompt-input" }            → [data-testid="…"] + yaygın alternatifler
 *   { by: "css",     value: "textarea" }
 *   { by: "xpath",   value: "//textarea[1]" }
 *   { by: "text",    value: "Generate", exact: true }   → visible text
 *   { by: "role",    value: "button", name: "Generate" }
 *   { by: "label",   value: "Prompt" }
 *   { by: "placeholder", value: "Describe" }            → placeholder/aria-label içerir
 *   { by: "attr",    name: "aria-label", value: "Send" }
 *   { by: "id",      value: "prompt" }
 *   { by: "hasText", css: "button", value: "Generate" } → CSS + içerik filtresi
 *
 * Ek alanlar:
 *   optional: true     → bulunamazsa hata atma (null döner)
 *   nth: 0|1|-1        → kaçıncı eşleşme
 *   within: "parent"   → kapsam daraltma selectors anahtarı
 *   tag: "button"      → tıklama hedefini kapsayıcıdan yukarı taşıma (örn. span → button)
 */
import { logger } from './logger.js';
import { StepTimeoutError } from '../errors.js';

const log = logger.child({ mod: 'selectors' });

const HIT_STATS = new Map(); // key: "scraperName.selectorKey.strategyIndex" → count

function recordHit(key, by, index) {
  const id = `${key} ▸ [${index}] ${by}`;
  HIT_STATS.set(id, (HIT_STATS.get(id) ?? 0) + 1);
}

export function selectorReport() {
  return [...HIT_STATS.entries()]
    .map(([selector, hits]) => ({ selector, hits }))
    .sort((a, b) => b.hits - a.hits);
}

export function resetSelectorStats() {
  HIT_STATS.clear();
}

/** {value} / {name} gibi yer tutucuları doldur */
function interpolate(template, vars = {}) {
  if (!template) return template;
  return String(template).replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? '').toString());
}

/** Tek bir stratejiyi Playwright locator'ına çevir (senkron) */
export function strategyToLocator(scope, strategy, vars = {}) {
  const v = interpolate(strategy.value, vars);
  const name = interpolate(strategy.name, vars);
  const nth = strategy.nth ?? 0;

  switch (strategy.by) {
    case 'testid':
      return scope
        .locator(
          `[data-testid="${v}"], [data-test-id="${v}"], [data-test="${v}"], [data-cy="${v}"], [data-qa="${v}"]`,
        )
        .nth(nth);
    case 'css':
      return scope.locator(v).nth(nth);
    case 'xpath':
      return scope.locator(`xpath=${v}`).nth(nth);
    case 'id':
      return scope.locator(`#${v}`).nth(nth);
    case 'text':
      return scope.getByText(v, { exact: Boolean(strategy.exact) }).nth(nth);
    case 'role':
      return scope.getByRole(strategy.role || v || 'button', { name, exact: Boolean(strategy.exact) }).nth(nth);
    case 'label':
      return scope.getByLabel(v, { exact: Boolean(strategy.exact) }).nth(nth);
    case 'placeholder':
      return scope.getByPlaceholder(v, { exact: Boolean(strategy.exact) }).nth(nth);
    case 'alttext':
      return scope.getByAltText(v, { exact: Boolean(strategy.exact) }).nth(nth);
    case 'title':
      return scope.getByTitle(v, { exact: Boolean(strategy.exact) }).nth(nth);
    case 'attr':
      return scope.locator(`[${strategy.name || 'aria-label'}${strategy.contains ? '*' : ''}="${v}"]`).nth(nth);
    case 'hasText':
      return scope.locator(strategy.css || '*').filter({ hasText: v }).nth(nth);
    default:
      throw new Error(`Bilinmeyen selector stratejisi: ${strategy.by}`);
  }
}

/**
 * Strateji zincirini sırayla dener, ilk uygun olanı döner.
 * @returns {Promise<import('playwright').Locator|null>}
 */
export async function resolveSelector(
  scope,
  strategies,
  {
    key = 'unnamed',
    timeout = 10_000,
    perStrategyTimeout = null,
    state = 'visible',
    vars = {},
    optional = false,
    waitFor = true,
  } = {},
) {
  if (!Array.isArray(strategies) || strategies.length === 0) {
    if (optional) return null;
    throw new StepTimeoutError(`selector:${key}`, timeout, { reason: 'strateji listesi boş' });
  }

  const attempts = [];
  const start = Date.now();
  const perTry = perStrategyTimeout ?? Math.max(600, Math.floor(timeout / strategies.length));

  for (let i = 0; i < strategies.length; i++) {
    const strategy = strategies[i];
    const remaining = timeout - (Date.now() - start);
    if (remaining <= 0) break;
    try {
      const locator = strategyToLocator(scope, strategy, vars);

      if (waitFor) {
        await locator.waitFor({ state, timeout: Math.min(perTry, remaining) });
      } else {
        if ((await locator.count()) === 0) throw new Error('eşleşme yok');
        if (state === 'visible' && !(await locator.isVisible())) throw new Error('görünür değil');
      }

      if (strategy.tag) {
        // span/div tıklaması yerine kapsayıcı butona tıkla
        const tagged = locator.locator(`xpath=ancestor-or-self::${strategy.tag}[1]`);
        if ((await tagged.count()) > 0) {
          recordHit(key, strategy.by, i);
          return tagged.first();
        }
      }
      recordHit(key, strategy.by, i);
      log.debug({ key, by: strategy.by, index: i }, 'selector eşleşti');
      return locator;
    } catch (err) {
      attempts.push(`${i}:${strategy.by}=${strategy.value ?? strategy.role ?? ''} (${err.message.split('\n')[0].slice(0, 80)})`);
    }
  }

  if (optional) {
    log.debug({ key, attempts }, 'opsiyonel selector bulunamadı (sorun değil)');
    return null;
  }
  const err = new StepTimeoutError(`selector:${key}`, timeout, { attempts });
  log.warn({ key, strategyCount: strategies.length, attempts }, err.message);
  throw err;
}

/** Bir kapsayıcı içinde başka bir zinciri değerlendirir (within desteği) */
export async function resolveIn(scope, strategy, selectorMap, opts = {}) {
  if (!strategy) return scope;
  const parent = await resolveSelector(scope, selectorMap[strategy], { key: `${opts.key}:within`, ...opts });
  return parent ?? scope;
}

/** Görünür tüm eşleşmeleri say (fallback / sonuç listesi için) */
export async function countAll(scope, strategies, vars = {}) {
  let total = 0;
  for (const strategy of strategies ?? []) {
    try {
      total += await strategyToLocator(scope, strategy, vars).count();
    } catch {
      /* yut */
    }
  }
  return total;
}
