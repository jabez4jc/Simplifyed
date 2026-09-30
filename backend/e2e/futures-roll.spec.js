import { test, expect } from '@playwright/test';
import { login, switchView, collectPageErrors, assertNoPageErrors } from './helpers.js';
import { instance } from './broker.js';

/**
 * Futures auto-roll, driven through the dashboard: add an MCX future that follows the NEXT
 * expiry, switch it to the nearest, watch it quote, roll it the way the overnight purge does and
 * see an open dashboard follow, and check the chart - candles for the live contract, and drawings
 * that stay with the series across the roll.
 *
 * No orders are placed. The roll itself runs in this process against the e2e database
 * (futures-roll.service rollRow, which never messages anyone); the app under test picks the
 * change up exactly as it would from its own cron.
 */

test.describe.configure({ mode: 'serial' });
test.setTimeout(120000);

const WATCHLIST = `E2E Roll ${new Date().toISOString().slice(11, 19)}`;
const card = (page, name) => page.locator('.watchlist-card-compact', { hasText: name });

let page;
let errors;
let db;
let roll;
let near;
let next;

function ist() {
  const now = new Date(Date.now() + 5.5 * 3600 * 1000);
  return { day: now.getUTCDay(), minutes: now.getUTCHours() * 60 + now.getUTCMinutes() };
}
const mcxOpen = () => ist().day >= 1 && ist().day <= 5 && ist().minutes >= 9 * 60 + 5 && ist().minutes <= 23 * 60 + 20;

/** Open the card. Retried: right after a view switch the list is still re-rendering, and a toggle
 * clicked on the outgoing DOM is lost. */
async function expand() {
  const body = card(page, WATCHLIST).locator('.watchlist-card-compact__body');
  await expect(async () => {
    if (!(await body.isVisible())) {
      await card(page, WATCHLIST).locator('.watchlist-card-compact__toggle').click();
    }
    await expect(body).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 15000 });
}

const row = () => card(page, WATCHLIST).locator('tr[data-symbol-id]').first();

test.beforeAll(async ({ browser }) => {
  await instance('Jz Kotak'); // connects the e2e database in this process
  ({ default: db } = await import('../src/core/database.js'));
  ({ default: roll } = await import('../src/services/futures-roll.service.js'));
  const futures = await roll.listFutures('MCX', 'CRUDEOIL');
  [near, next] = futures.map((f) => f.symbol);
  expect(next, 'the e2e instruments copy holds at least two live CRUDEOIL futures').toBeTruthy();

  page = await browser.newPage();
  page.on('dialog', (d) => d.accept());
  errors = collectPageErrors(page);
  await login(page);
});

test.afterAll(async () => {
  await page?.close();
});

test('an MCX future added with "next expiry" lands on the next contract', async () => {
  await switchView(page, 'watchlists');
  await page.getByRole('button', { name: /add watchlist/i }).click();
  await page.fill('#add-watchlist-form [name="name"]', WATCHLIST);
  await page.check('#add-watchlist-form [name="type"][value="standard"]');
  await page.locator('.modal-overlay .modal-footer .btn-buy').click();
  await expect(card(page, WATCHLIST)).toBeVisible({ timeout: 15000 });

  await card(page, WATCHLIST).locator('[title="Instances"]').click();
  for (const name of ['Jz Kotak', 'Jz Fyers']) {
    await page.locator(`.instance-checkbox[data-instance-id="${(await instance(name)).id}"]`).check();
  }
  await page.getByRole('button', { name: 'Save Assignments' }).click();
  await expect(page.locator('.modal-overlay')).toHaveCount(0, { timeout: 10000 });

  // Pick the NEAREST contract in search - the series choice is what moves it on.
  await card(page, WATCHLIST).locator('[title="Add Symbol"]').click();
  await page.fill('#symbol-search-input', 'CRUDEOIL');
  const results = page.locator('#symbol-search-results [data-symbol]');
  await expect(results.first()).toBeVisible({ timeout: 15000 });
  const index = await results.evaluateAll((els, want) => els.findIndex((el) => {
    const s = JSON.parse(decodeURIComponent(el.dataset.symbol));
    return s.symbol === want && s.exchange === 'MCX';
  }), near);
  expect(index, `${near} is offered by search`).toBeGreaterThanOrEqual(0);
  await results.nth(index).click();

  const contract = page.locator('#symbol-auto-roll');
  await expect(contract, 'a dated future offers the Contract choice').toBeVisible();
  await expect(contract).toHaveValue('0');
  await contract.selectOption('2');
  await page.locator('.modal-overlay .modal-footer').getByRole('button', { name: 'Add Symbol' }).click();
  await expect(page.locator('#symbol-config-form')).toHaveCount(0, { timeout: 15000 });

  await expand();
  await expect(row()).toHaveAttribute('data-symbol', next, { timeout: 15000 });
  await expect(row().locator('.col-expiry')).toContainText('⟳ 2!');
});

test('switching the row to "nearest expiry" moves it back to the nearest contract', async () => {
  await row().locator('[title="Edit"]').click();
  const contract = page.locator('#symbol-auto-roll');
  await expect(contract).toHaveValue('2');
  await contract.selectOption('1');
  await page.locator('.modal-overlay .modal-footer').getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.locator('#symbol-config-form')).toHaveCount(0, { timeout: 15000 });

  await expand();
  await expect(row()).toHaveAttribute('data-symbol', near, { timeout: 15000 });
  await expect(row().locator('.col-expiry')).toContainText('⟳ 1!');
});

test('the row quotes its contract and opens its trading panel', async () => {
  test.skip(!mcxOpen(), 'MCX is closed');
  const ltp = row().locator('.ltp-cell');
  await expect(ltp).toHaveText(/\d/, { timeout: 45000 });

  await row().locator('[data-toggle-symbol]').click();
  const symbolId = await row().getAttribute('data-symbol-id');
  const panel = card(page, WATCHLIST).locator(`#expansion-content-${symbolId}`);
  await expect(panel.getByRole('button', { name: 'BUY', exact: true })).toBeVisible({ timeout: 15000 });
});

test('an overnight roll reaches an open dashboard', async () => {
  const symbolId = Number(await row().getAttribute('data-symbol-id'));

  // What the dashboard shows the evening before: the row still on a contract that has expired.
  await db.run(
    "UPDATE watchlist_symbols SET symbol = 'CRUDEOIL19AUG26FUT', expiry = '19-AUG-26' WHERE id = ?",
    [symbolId]
  );
  await switchView(page, 'dashboard');
  await switchView(page, 'watchlists');
  await expand();
  await expect(row()).toHaveAttribute('data-symbol', 'CRUDEOIL19AUG26FUT', { timeout: 15000 });
  await expect(row().locator('.col-expiry')).toContainText('Expired');

  // The purge's roll, then the event the server pushes after it.
  const result = await roll.rollRow(await db.get('SELECT * FROM watchlist_symbols WHERE id = ?', [symbolId]));
  expect(result.status).toBe('rolled');
  await page.evaluate(() => window.app.handleWsMessage({
    topic: 'watchlists:update', seq: (window.app.wsLastSeq || 0) + 1, payload: { reason: 'futures_roll' },
  }));

  await expand();
  await expect(row()).toHaveAttribute('data-symbol', near, { timeout: 15000 });
  await expect(row().locator('.col-expiry')).not.toContainText('Expired');
});

test('the chart follows the row, and its drawings follow the series across a roll', async () => {
  const symbolId = Number(await row().getAttribute('data-symbol-id'));

  // A trend line drawn on the nearest contract BEFORE the row was set to auto-roll, stored the
  // way saveDrawings stores it - per contract.
  await page.evaluate(({ key }) => {
    const host = document.createElement('div');
    host.style.cssText = 'width:600px;height:300px';
    document.body.appendChild(host);
    const chart = window.OAC.createChart(host, { timezone: 'Asia/Kolkata' });
    const t = Math.floor(Date.now() / 1000);
    chart.addSeries('candlestick').setData([
      { time: t - 7200, open: 100, high: 101, low: 99, close: 100 },
      { time: t - 3600, open: 100, high: 102, low: 99, close: 101 },
    ]);
    const c = new window.OAC.DrawingController(chart, { magnet: 'weak' });
    c.add({ tool: 'trend-line', paneIndex: 0, points: [{ time: t - 7200, price: 100 }, { time: t - 3600, price: 101 }] });
    localStorage.setItem(key, JSON.stringify(c.toJSON()));
    c.destroy(); chart.destroy(); host.remove();
  }, { key: `chart-draw:MCX:${near}` });
  await page.evaluate((id) => {
    localStorage.setItem('chart-preference', JSON.stringify({ symbolId: id, timeframe: '5m', product: 'NRML', qty: 1 }));
  }, symbolId);

  const openChart = async (contract) => {
    const history = page.waitForResponse(
      (r) => r.url().includes('/api/v1/history?') && r.url().includes(`symbol=${contract}`),
      { timeout: 30000 }
    );
    await switchView(page, 'chart');
    const body = await (await history).json();
    await expect(page.locator('#chart-symbol')).toHaveValue(String(symbolId));
    await page.waitForFunction(() => Boolean(window.app?.drawState?.().controller), null, { timeout: 15000 });
    return body;
  };

  const before = await openChart(near);
  expect(before.data.symbol).toBe(near);
  if (mcxOpen()) expect(before.data.count, 'candles for the live contract').toBeGreaterThan(0);
  expect(await page.evaluate(() => window.app.drawState().controller.drawings().length),
    'the per-contract drawing is adopted by the series').toBe(1);
  await page.evaluate(() => window.app.saveDrawings());
  expect(await page.evaluate(() => Boolean(localStorage.getItem('chart-draw:MCX:CRUDEOIL1!')))).toBe(true);

  // Expire the nearest contract the way the purge does, and roll the row onto the next.
  await db.run('DELETE FROM instruments WHERE exchange = ? AND symbol = ?', ['MCX', near]);
  const result = await roll.rollRow(
    await db.get('SELECT * FROM watchlist_symbols WHERE id = ?', [symbolId]),
    { checkPositions: false }
  );
  expect(result).toMatchObject({ status: 'rolled', to: next });

  await switchView(page, 'watchlists');
  const after = await openChart(next);
  expect(after.data.symbol, 'the chart opens the row on its new contract').toBe(next);
  if (mcxOpen()) expect(after.data.count, 'candles for the new contract').toBeGreaterThan(0);
  expect(await page.evaluate(() => window.app.drawState().controller.drawings().length),
    'the drawing followed the series onto the new contract').toBe(1);

  assertNoPageErrors(errors);
});
