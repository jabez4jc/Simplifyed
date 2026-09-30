import { test, expect } from '@playwright/test';
import { login, switchView, collectPageErrors, assertNoPageErrors } from './helpers.js';
import { assertAnalyzer, instance, netPosition, waitForNet, flatten, webhookToken } from './broker.js';

/**
 * The watchlist workflow, on the operator's REAL brokers (analyzer mode), driven through the
 * dashboard the way the operator does it: create a watchlist, map instances to it, find and add
 * symbols, set targets and stop-losses, trade from the row, see the result on Positions and
 * Orders, and fire the same watchlist from a TradingView webhook.
 *
 * Only Jz Kotak, Jz Fyers and Jabez Crypto are used - Maha and Ana are kept for the live order
 * tests. Crypto trades 24x7, so its steps always run; Indian steps run only while their
 * exchange is open. Every symbol ordered is flattened in afterAll, and the run fails if anything
 * is left open at a broker.
 */

test.describe.configure({ mode: 'serial' });
test.setTimeout(180000);

const CRYPTO = 'Jabez Crypto';
const INDIAN = ['Jz Kotak', 'Jz Fyers'];
const STAMP = new Date().toISOString().slice(11, 19);
const ordered = []; // { name, symbol, exchange } - flattened in afterAll

let page;
let errors;

/** IST wall clock, for gating Indian-exchange steps on market hours. */
function ist() {
  const now = new Date(Date.now() + 5.5 * 3600 * 1000);
  return { day: now.getUTCDay(), minutes: now.getUTCHours() * 60 + now.getUTCMinutes() };
}
const weekday = () => ist().day >= 1 && ist().day <= 5;
const mcxOpen = () => weekday() && ist().minutes >= 9 * 60 + 5 && ist().minutes <= 23 * 60 + 20;
const nseOpen = () => weekday() && ist().minutes >= 9 * 60 + 20 && ist().minutes <= 15 * 60 + 10;

const card = (name) => page.locator('.watchlist-card-compact', { hasText: name });

async function createWatchlist(name, { type = 'standard', instances }) {
  await switchView(page, 'watchlists');
  await page.getByRole('button', { name: /add watchlist/i }).click();
  await page.fill('#add-watchlist-form [name="name"]', name);
  await page.check(`#add-watchlist-form [name="type"][value="${type}"]`);
  await page.locator('.modal-overlay .modal-footer .btn-buy').click();
  await expect(card(name)).toBeVisible({ timeout: 15000 });

  await card(name).locator('[title="Instances"]').click();
  for (const instName of instances) {
    const inst = await instance(instName);
    await page.locator(`.instance-checkbox[data-instance-id="${inst.id}"]`).check();
  }
  await page.getByRole('button', { name: 'Save Assignments' }).click();
  await expect(page.locator('.modal-overlay')).toHaveCount(0, { timeout: 10000 });
}

/** Search, pick the first result, and add it with the modal's defaults. Returns its symbol. */
async function addSymbol(watchlist, query) {
  await card(watchlist).locator('[title="Add Symbol"]').click();
  await page.fill('#symbol-search-input', query);
  const first = page.locator('#symbol-search-results [data-symbol]').first();
  await expect(first).toBeVisible({ timeout: 15000 });
  const symbol = JSON.parse(decodeURIComponent(await first.getAttribute('data-symbol'))).symbol;
  await first.click();
  await page.locator('.modal-overlay .modal-footer').getByRole('button', { name: 'Add Symbol' }).click();
  await expect(page.locator('#symbol-config-form')).toHaveCount(0, { timeout: 15000 });
  await expand(watchlist);
  await expect(card(watchlist).locator(`tr[data-symbol="${symbol}"]`)).toBeVisible({ timeout: 15000 });
  return symbol;
}

async function expand(watchlist) {
  const body = card(watchlist).locator('.watchlist-card-compact__body');
  if (!(await body.evaluate((el) => el.classList.contains('is-visible')))) {
    await card(watchlist).locator('.watchlist-card-compact__toggle').click();
  }
  await expect(body).toBeVisible();
}

/** Click an action on a symbol's trading panel and accept the confirmation. */
async function trade(watchlist, symbol, action) {
  await expand(watchlist);
  const row = card(watchlist).locator(`tr[data-symbol="${symbol}"]`);
  const symbolId = await row.getAttribute('data-symbol-id');
  const panel = card(watchlist).locator(`#expansion-content-${symbolId}`);
  if (!(await panel.isVisible())) await row.locator('[data-toggle-symbol]').click();
  await expect(panel.getByRole('button', { name: action, exact: true })).toBeVisible({ timeout: 15000 });

  const response = page.waitForResponse((r) => r.url().includes('/api/v1/quickorders') && r.request().method() === 'POST', { timeout: 60000 });
  await panel.getByRole('button', { name: action, exact: true }).click();
  await expect(page.locator('.modal-overlay h3', { hasText: 'Confirm Order' })).toBeVisible();
  await page.locator('.modal-overlay button[data-action="confirm"]').click();
  const body = await (await response).json();
  expect(body.data?.summary?.failed, `${action} ${symbol}: ${JSON.stringify(body).slice(0, 600)}`).toBe(0);
  return body;
}

test.beforeAll(async ({ browser }) => {
  for (const name of [CRYPTO, ...INDIAN]) await assertAnalyzer(name);
  page = await browser.newPage();
  page.on('dialog', (d) => d.accept());
  errors = collectPageErrors(page);
  await login(page);
});

test.afterAll(async () => {
  const leftovers = await flatten(ordered);
  await page?.close();
  expect(leftovers, `left open at the broker:\n${leftovers.join('\n')}`).toEqual([]);
});

// ---------------------------------------------------------------------------
// Crypto - trades 24x7, so these always run
// ---------------------------------------------------------------------------

const CRYPTO_WL = `E2E Crypto ${STAMP}`;
let btc;

test('create a watchlist, map an instance to it and add a symbol found by search', async () => {
  await createWatchlist(CRYPTO_WL, { instances: [CRYPTO] });
  btc = await addSymbol(CRYPTO_WL, 'BTCUSD');
  expect(btc).toBe('BTCUSDFUT');

  await expand(CRYPTO_WL);
  // A fresh watchlist is live straight away - it used to be created inactive and never quoted.
  await expect(card(CRYPTO_WL).locator('.ltp-cell').first()).toHaveText(/\d/, { timeout: 60000 });
});

test('a target and stop-loss can be set in percent or in points, and they stick', async () => {
  const row = card(CRYPTO_WL).locator(`tr[data-symbol="${btc}"]`);
  const form = page.locator('#symbol-config-form');
  // Saving re-renders the list collapsed - and asynchronously, so an Edit click can land on the
  // row that is about to be replaced. Expand, wait for the row, and retry until the form opens.
  const openEdit = async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expand(CRYPTO_WL);
      await expect(row).toBeVisible({ timeout: 15000 });
      await row.getByRole('button', { name: 'Edit' }).click();
      if (await form.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false)) return;
    }
    await expect(form).toBeVisible();
  };
  const edit = async (fields) => {
    await openEdit();
    for (const [name, value] of Object.entries(fields)) {
      const el = form.locator(`[name="${name}"]`);
      if ((await el.evaluate((e) => e.tagName)) === 'SELECT') await el.selectOption(value);
      else await el.fill(value);
    }
    await page.locator('.modal-overlay .modal-footer .btn-buy').click();
    await expect(page.locator('#symbol-config-form')).toHaveCount(0, { timeout: 10000 });
  };
  const read = async (names) => {
    await openEdit();
    const values = {};
    for (const n of names) values[n] = await form.locator(`[name="${n}"]`).inputValue();
    await page.locator('.modal-overlay .modal-footer').getByRole('button', { name: 'Cancel' }).click();
    return values;
  };
  const names = ['exit_unit_futures', 'target_points_futures', 'stoploss_points_futures'];

  // Far away on purpose: the running auto-exit must not act on this test's position.
  await edit({ exit_unit_futures: 'PERCENT', target_points_futures: '40', stoploss_points_futures: '30' });
  expect(await read(names)).toEqual({ exit_unit_futures: 'PERCENT', target_points_futures: '40', stoploss_points_futures: '30' });

  await edit({ exit_unit_futures: 'POINTS', target_points_futures: '30000', stoploss_points_futures: '25000' });
  expect(await read(names)).toEqual({ exit_unit_futures: 'POINTS', target_points_futures: '30000', stoploss_points_futures: '25000' });
});

test('BUY from the watchlist fills at the broker and shows on Positions; EXIT closes it', async () => {
  ordered.push({ name: CRYPTO, symbol: btc, exchange: 'CRYPTO' });
  const before = await netPosition(CRYPTO, btc);

  await trade(CRYPTO_WL, btc, 'BUY');
  expect(await waitForNet(CRYPTO, btc, before + 1)).toBe(before + 1);

  await switchView(page, 'positions');
  const crypto = page.locator('details[data-instance-id]', { hasText: CRYPTO });
  await expect(crypto).toBeVisible({ timeout: 20000 });
  if (!(await crypto.evaluate((d) => d.open))) await crypto.locator('summary').click();
  await expect(crypto).toContainText(btc, { timeout: 20000 });

  await switchView(page, 'watchlists');
  await expand(CRYPTO_WL);
  await trade(CRYPTO_WL, btc, 'EXIT');
  expect(await waitForNet(CRYPTO, btc, 0)).toBe(0);
});

test('the Orders page history lists the orders the watchlist sent', async () => {
  await switchView(page, 'orders');
  const history = page.locator('#order-history-panel');
  await expect(history).toContainText(btc, { timeout: 20000 });
  await expect(history).toContainText('Watchlist');

  // Filtering by instance is a dropdown of names, not a typed-in id.
  const inst = await instance(CRYPTO);
  await page.selectOption('#order-history-instance', String(inst.id));
  await expect(history).toContainText(btc, { timeout: 15000 });
});

// ---------------------------------------------------------------------------
// TradingView webhook into a broadcast watchlist
// ---------------------------------------------------------------------------

const BROADCAST_WL = `E2E Broadcast ${STAMP}`;

test('a TradingView alert to a broadcast watchlist trades its instances; a wrong token trades nothing', async ({ request }) => {
  await createWatchlist(BROADCAST_WL, { type: 'broadcast', instances: [CRYPTO] });
  await expand(BROADCAST_WL);
  // The slug is read off the page, where the operator copies it from.
  // The displayed URL carries the token, so only the slug is kept, and never in a message.
  await expect(card(BROADCAST_WL).locator('code.code-inline').first()).toBeVisible({ timeout: 15000 });
  const shown = await card(BROADCAST_WL).locator('code.code-inline').allInnerTexts();
  const slug = shown.map((t) => (t.match(/broadcast\/([A-Za-z0-9_-]+)/) || [])[1] || (/^[A-Za-z0-9_-]{6,}$/.test(t.trim()) ? t.trim() : null)).find(Boolean);
  expect(Boolean(slug), 'the watchlist shows its webhook slug').toBe(true);

  ordered.push({ name: CRYPTO, symbol: 'BTCUSDFUT', exchange: 'CRYPTO' });
  const before = await netPosition(CRYPTO, 'BTCUSDFUT');
  const realToken = await webhookToken();
  const alert = (body, token = realToken) => request.post(`/webhook/tradingview/broadcast/${slug}`, {
    headers: { 'Content-Type': 'text/plain', 'X-Webhook-Token': token },
    data: JSON.stringify(body),
  });

  const refused = await alert({ strategy: 'e2e', symbol: 'BTCUSDFUT', exchange: 'CRYPTO', action: 'BUY', quantity: 1, position_size: before + 1 }, 'not-the-token');
  expect(refused.status()).toBe(401);

  const entry = await alert({ strategy: 'e2e', symbol: 'BTCUSDFUT', exchange: 'CRYPTO', action: 'BUY', quantity: 1, position_size: before + 1, product: 'NRML', pricetype: 'MARKET' });
  expect(entry.status(), await entry.text()).toBe(200);
  expect(await waitForNet(CRYPTO, 'BTCUSDFUT', before + 1)).toBe(before + 1);

  const exit = await alert({ strategy: 'e2e', symbol: 'BTCUSDFUT', exchange: 'CRYPTO', action: 'SELL', quantity: 1, position_size: before, product: 'NRML', pricetype: 'MARKET' });
  expect(exit.status(), await exit.text()).toBe(200);
  expect(await waitForNet(CRYPTO, 'BTCUSDFUT', before)).toBe(before);
});

// ---------------------------------------------------------------------------
// Indian F&O and equity - only while the exchange is open
// ---------------------------------------------------------------------------

const INDIAN_WL = `E2E Indian ${STAMP}`;

test('MCX futures from a watchlist fan out to every mapped broker, in each broker\'s lot units', async () => {
  test.skip(!mcxOpen(), 'MCX is closed');
  await createWatchlist(INDIAN_WL, { instances: INDIAN });
  const crude = await addSymbol(INDIAN_WL, 'CRUDEOIL');
  expect(crude).toMatch(/^CRUDEOIL\d{2}[A-Z]{3}\d{2}FUT$/);
  await expand(INDIAN_WL);

  const lot = Number(await card(INDIAN_WL).locator(`tr[data-symbol="${crude}"] .col-lot`).innerText());
  const want = {};
  for (const name of INDIAN) {
    ordered.push({ name, symbol: crude, exchange: 'MCX' });
    const inst = await instance(name);
    want[name] = (await netPosition(name, crude)) + lot * Math.max(1, Number(inst.multiplier) || 1);
  }

  await trade(INDIAN_WL, crude, 'BUY');
  for (const name of INDIAN) expect(await waitForNet(name, crude, want[name]), name).toBe(want[name]);

  await trade(INDIAN_WL, crude, 'EXIT');
  for (const name of INDIAN) expect(await waitForNet(name, crude, 0), name).toBe(0);
});

test('an NSE stock trades from the watchlist as a limit order and exits', async () => {
  test.skip(!nseOpen(), 'NSE is closed');
  if (!(await card(INDIAN_WL).count())) await createWatchlist(INDIAN_WL, { instances: INDIAN });
  const sbin = await addSymbol(INDIAN_WL, 'SBIN');
  expect(sbin).toBe('SBIN');
  await expand(INDIAN_WL);

  for (const name of INDIAN) ordered.push({ name, symbol: sbin, exchange: 'NSE' });
  const body = await trade(INDIAN_WL, sbin, 'BUY');
  expect(body.data.summary.successful).toBe(INDIAN.length);
  for (const name of INDIAN) expect(await waitForNet(name, sbin, 1 * Math.max(1, Number((await instance(name)).multiplier) || 1)), name).toBeGreaterThan(0);

  await trade(INDIAN_WL, sbin, 'EXIT');
  for (const name of INDIAN) expect(await waitForNet(name, sbin, 0), name).toBe(0);
});

// ---------------------------------------------------------------------------
// Tidy up through the UI - deleting is a workflow too
// ---------------------------------------------------------------------------

test('a watchlist can be deleted, and nothing on the page broke along the way', async () => {
  await switchView(page, 'watchlists');
  for (const name of [CRYPTO_WL, BROADCAST_WL, INDIAN_WL]) {
    if (!(await card(name).count())) continue;
    await card(name).locator('[title="Delete"]').click();
    await page.locator('.modal-overlay button[data-action="confirm"]').click();
    await expect(card(name)).toHaveCount(0, { timeout: 15000 });
  }
  assertNoPageErrors(errors);
});
