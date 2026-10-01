import { test, expect } from '@playwright/test';
import { login, switchView, collectPageErrors, assertNoPageErrors } from './helpers.js';
import { instance, assertAnalyzer, netPosition, waitForNet, flatten } from './broker.js';

/**
 * Chart trading end to end on crypto, which trades 24x7: Jabez Crypto (Delta Exchange, analyzer
 * mode, confirmed at the broker first) on BTCUSDFUT. Real orders go to the broker's analyzer and
 * the books are read back from it. Everything ordered is flattened in afterAll, and the run fails
 * if anything is left open.
 */

test.describe.configure({ mode: 'serial' });
test.setTimeout(240000);

const CRYPTO = 'Jabez Crypto';
const SYMBOL = 'BTCUSDFUT';
const ordered = [{ name: CRYPTO, symbol: SYMBOL, exchange: 'CRYPTO' }];

let page;
let errors;
let base; // the net position before the spec started

const openOrders = () => page.evaluate(async (s) => (await api.request(`/orders?symbol=${s}&status=open,pending`)).data, SYMBOL);

test.beforeAll(async ({ browser }) => {
  await assertAnalyzer(CRYPTO);
  base = await netPosition(CRYPTO, SYMBOL);
  page = await browser.newPage();
  errors = collectPageErrors(page);
  await login(page);
  const crypto = await instance(CRYPTO);
  const symbolId = await page.evaluate(async (instanceId) => {
    const wl = (await api.createWatchlist({ name: `E2E Crypto Chart ${Date.now()}` })).data;
    await api.assignInstance(wl.id, instanceId);
    const row = (await api.addSymbol(wl.id, {
      symbol: 'BTCUSDFUT', exchange: 'CRYPTO', symbol_type: 'FUTURES', underlying_symbol: 'BTC',
      tradable_equity: false, tradable_futures: true, tradable_options: false,
    })).data;
    localStorage.setItem('chart-preference', JSON.stringify({ symbolId: row.id, timeframe: '1m', product: 'NRML', qty: 1 }));
    return row.id;
  }, crypto.id);
  await switchView(page, 'chart');
  await expect(page.locator('#chart-symbol')).toHaveValue(String(symbolId), { timeout: 20000 });
  await page.waitForFunction(() => Boolean(window.app?.chartLastPrice), null, { timeout: 60000 });
  await expect(page.locator('#chart-tickets')).toBeVisible({ timeout: 30000 });
});

test.afterAll(async () => {
  const leftovers = await flatten(ordered);
  await page?.close();
  expect(leftovers, `left open at the broker:\n${leftovers.join('\n')}`).toEqual([]);
});

const box = () => page.locator('#chart-container').boundingBox();
const confirmGo = async () => {
  const dialog = page.locator('.modal-overlay .chart-confirm');
  await expect(dialog).toBeVisible({ timeout: 10000 });
  await dialog.locator('[data-action="go"]').click();
  await expect(dialog).toHaveCount(0);
};
/** Pixel height of the price line, re-read every time: a missed drag pans the chart. */
const yOf = (price) => page.evaluate((p) => window.app.chart.priceToCoordinate(p, 0), price);
const plotRight = async () => (await box()).width - 60; // the price axis takes the last ~60px

/** Right-click `dy` pixels from the last price and pick the menu item matching `label`. */
async function menuOrder(dy, label) {
  const y = await yOf(await page.evaluate(() => window.app.chartLastPrice));
  const b = await box();
  await page.locator('#chart-container').click({ button: 'right', position: { x: 200, y: Math.max(20, Math.min(b.height - 60, y + dy)) } });
  const item = page.locator('#chart-ctx [data-trade-i]', { hasText: label });
  const text = await item.innerText();
  await item.click();
  await confirmGo();
  return text;
}

test('a market BUY from the chart ticket fills at the broker and shows as a position on the chart', async () => {
  await page.locator('.chart-ticket[data-side="BUY"]').click();
  await page.locator('.modal-overlay .chart-confirm').getByText('Market').first().waitFor();
  await confirmGo();
  await expect.poll(() => netPosition(CRYPTO, SYMBOL), { timeout: 40000, intervals: [1500] }).toBeGreaterThan(base);
  await page.waitForFunction(() => window.app.chartPositionData?.netQuantity > 0, null, { timeout: 40000 });
  expect(await page.evaluate(() => window.app.orderLinesState().controller._markers?.size ?? 0), 'the position is on the chart').toBe(1);
});

let resting;
test('a limit below the market rests, and shows as an order line', async () => {
  const label = await menuOrder(70, /Buy .* Limit @/);
  expect(label).not.toContain('fills now');
  await expect.poll(async () => (await openOrders()).length, { timeout: 30000 }).toBe(1);
  resting = (await openOrders())[0];
  expect(resting).toMatchObject({ side: 'BUY', order_type: 'LIMIT', symbol: SYMBOL });
  expect(resting.price).toBeLessThan(await page.evaluate(() => window.app.chartLastPrice));
  await page.waitForFunction(() => window.app.orderLinesState().lastOrders?.length === 1, null, { timeout: 40000 });
});

test('dragging the order line with the mouse moves the resting order at the broker', async () => {
  const b = await box();
  const right = await plotRight();
  let moved = null;
  for (const dx of [150, 170, 130, 190, 110]) {
    const now = (await openOrders())[0];
    const y = await yOf(Number(now.price));
    await page.mouse.move(b.x + right - dx, b.y + y);
    await page.mouse.down();
    await page.mouse.move(b.x + right - dx, b.y + y + 12, { steps: 4 });
    await page.mouse.move(b.x + right - dx, b.y + y + 24, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(1500);
    const after = (await openOrders())[0];
    if (after && Number(after.price) !== Number(now.price)) { moved = { from: Number(now.price), to: Number(after.price) }; break; }
  }
  expect(moved, 'some grab point on the line moves the order').not.toBeNull();
  expect(moved.to, 'dragged down, so the buy price fell').toBeLessThan(moved.from);
  resting = (await openOrders())[0];
});

/**
 * Slide the pointer along the line until the engine reports hovering `id`; returns the x (or null).
 * `yAt` is read again at every step: a live tick rescales the chart and moves the line while the
 * pointer is still searching for it.
 */
async function hoverUntil(yAt, pattern) {
  const b = await box();
  let y = await yAt();
  await page.evaluate(() => {
    window.__hover = null;
    if (!window.__hoverBound) { window.__hoverBound = true; window.app.chart.on('hover', (e) => { window.__hover = e?.id || null; }); }
  });
  const seen = new Set();
  for (let x = b.width - 4; x > b.width - 320; x -= 3) {
    y = await yAt();
    await page.mouse.move(b.x + x, b.y + y);
    const id = (await page.evaluate(() => window.__hover)) || '';
    seen.add(id);
    if (pattern.test(id)) return b.x + x;
  }
  console.log('PROBE no hover match at y', y, 'box', JSON.stringify(b), 'seen', [...seen].join(','), 'orders', JSON.stringify(await page.evaluate(() => [window.app.orderLinesState().lastOrders, window.app.chart.priceToCoordinate(window.app.orderLinesState().lastOrders?.[0]?.price, 0)])));
  return null;
}

test('the ✕ on the order line cancels it at the broker', async () => {
  const b = await box();
  const price = Number((await openOrders())[0].price);
  const x = await hoverUntil(() => yOf(price), /^order:\d+::close$/);
  expect(x, 'the ✕ of the order line is under the pointer somewhere').not.toBeNull();
  await page.mouse.click(x, b.y + await yOf(price));
  await expect.poll(async () => (await openOrders()).length, { timeout: 30000 }).toBe(0);
  await page.waitForFunction(() => window.app.orderLinesState().lastOrders?.length === 0, null, { timeout: 40000 });
});

test('a sell limit below the market is offered as "fills now" and closes the position', async () => {
  const label = await menuOrder(70, /Sell .* Limit @/);
  expect(label).toContain('fills now');
  expect(await waitForNet(CRYPTO, SYMBOL, base, 40000)).toBe(base);
  await page.waitForFunction(() => !window.app.chartPositionData?.netQuantity, null, { timeout: 40000 });
  // The filled order must not linger as a working order line.
  await expect.poll(async () => (await openOrders()).length, { timeout: 30000, intervals: [1000] }).toBe(0);
  await page.waitForFunction(() => window.app.orderLinesState().lastOrders?.length === 0, null, { timeout: 40000 });
});

test('the ✕ on the position marker squares it off', async () => {
  await page.locator('.chart-ticket[data-side="BUY"]').click();
  await confirmGo();
  await expect.poll(() => netPosition(CRYPTO, SYMBOL), { timeout: 40000, intervals: [1500] }).toBeGreaterThan(base);
  await page.waitForFunction(() => window.app.chartPositionData?.netQuantity > 0, null, { timeout: 40000 });
  const b = await box();
  const entry = await page.evaluate(() => window.app.chartPositionData.avgEntryPrice);
  const yAt = async () => Math.max(12, Math.min(b.height - 12, await yOf(entry)));
  const x = await hoverUntil(yAt, /^position:.+::close$/);
  expect(x, 'the ✕ of the position marker is under the pointer somewhere').not.toBeNull();
  await page.mouse.click(x, b.y + await yAt());
  await confirmGo();
  expect(await waitForNet(CRYPTO, SYMBOL, base, 40000)).toBe(base);
});
