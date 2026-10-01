import { test, expect } from '@playwright/test';
import { login, switchView, collectPageErrors, assertNoPageErrors } from './helpers.js';
import { instance } from './broker.js';

/**
 * What the chart's order buttons actually send, for a NIFTY index row with options and futures.
 *
 * On 30 Sep 2026: the chart showed the NIFTY 06-OCT weekly with Expiry = "Nearest", sent no
 * expiry, and the order traded 29-DEC; with Lots = 2 it traded 1 lot (stepLots was never sent);
 * and its futures tickets sent no expiry, which an index row's futures order is refused without.
 * Every order request is intercepted and answered here, so nothing reaches a broker.
 */

test.setTimeout(90000);

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const toIso = (d) => {
  const m = /^(\d{2})-([A-Z]{3})-(\d{2})$/.exec(String(d).toUpperCase());
  return m ? `20${m[3]}-${String(MONTHS.indexOf(m[2]) + 1).padStart(2, '0')}-${m[1]}` : d;
};

/** NIFTY index row on the chart with Lots = 2; every POST /quickorders captured and answered. */
async function openNiftyChart(page) {
  await login(page); // lands on the dashboard; reloading it here aborted its first request
  const kotak = await instance('Jz Kotak');
  const symbolId = await page.evaluate(async (instanceId) => {
    const wl = (await api.createWatchlist({ name: `E2E Chart Orders ${Date.now()}` })).data;
    await api.assignInstance(wl.id, instanceId);
    const row = (await api.addSymbol(wl.id, {
      symbol: 'NIFTY', exchange: 'NSE_INDEX', symbol_type: 'INDEX', underlying_symbol: 'NIFTY',
      tradable_equity: false, tradable_futures: true, tradable_options: true,
    })).data;
    localStorage.setItem('chart-preference', JSON.stringify({ symbolId: row.id, timeframe: '1m', product: 'NRML', qty: 2 }));
    return row.id;
  }, kotak.id);

  await switchView(page, 'chart');
  await expect(page.locator('#chart-symbol')).toHaveValue(String(symbolId), { timeout: 20000 });
  await page.waitForFunction(() => Boolean(window.app?.chartLastPrice), null, { timeout: 30000 });
  // The trade panel (targets, tradable modes, the futures contract) has to have loaded.
  await page.waitForFunction(() => window.app.optionsAvailable?.() && window.app.chartFuture, null, { timeout: 30000 });
  await expect(page.locator('#chart-send-count')).not.toHaveText('—', { timeout: 30000 });

  const sent = [];
  await page.route('**/api/v1/quickorders', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    sent.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, json: { status: 'success', data: { results: [{ success: true }] } } });
  });
  return sent;
}

/** Turn options on and close the popover again - it sits over the tickets. */
async function optionsOn(page) {
  await page.click('[data-pop="options"]');
  await page.check('#chart-opt-on');
  await page.click('[data-pop="options"]');
  await expect(page.locator('[data-pop-for="options"]')).toBeHidden();
}

async function confirm(page, button, expectText) {
  await page.click(button);
  const dialog = page.locator('.modal-overlay .chart-confirm');
  for (const text of expectText) await expect(dialog).toContainText(text, { timeout: 10000 });
  await dialog.locator('[data-action="go"]').click();
  await expect(dialog).toHaveCount(0);
}

async function nearestFuture() {
  const { default: roll } = await import('../src/services/futures-roll.service.js');
  return (await roll.listFutures('NFO', 'NIFTY'))[0];
}

test('BUY PE carries the expiry the panes show and the lots typed', async ({ page }) => {
  const errors = collectPageErrors(page);
  const sent = await openNiftyChart(page);
  await optionsOn(page);

  await expect(page.locator('#chart-opt-expiry')).toHaveValue(''); // "Nearest"
  await expect(page.locator('.chart-pane[data-pane="pe"] .chart-pane-sym')).toBeVisible({ timeout: 30000 });
  const shown = await page.evaluate(() => window.app.shownOptionExpiry);
  expect(shown, 'the panes resolved an expiry').toBeTruthy();
  await expect(page.locator('.chart-pane[data-pane="pe"] .chart-pane-meta')).toContainText(shown);

  // The chart's nearest and the server's nearest are the same date.
  const { default: expiryManagementService } = await import('../src/services/expiry-management.service.js');
  expect(toIso(shown)).toBe(await expiryManagementService.getNearestExpiry('NIFTY', 'NSE_INDEX', null));

  const peShown = await page.evaluate(() => window.app.paneContracts.pe.symbol);
  await confirm(page, '[data-option-action="BUY_PE"]', [peShown, '2 lots', 'Every instance trades this same contract']);
  await expect.poll(() => sent.length, { timeout: 10000 }).toBe(1);
  expect(sent[0]).toMatchObject({ action: 'BUY_PE', tradeMode: 'OPTIONS', expiry: shown, stepLots: 2 });
  // The contract on the PE chart, named outright - every instance trades it.
  const pe = await page.evaluate(() => window.app.paneContracts.pe);
  expect(sent[0].contract).toEqual({ exchange: pe.exchange, symbol: pe.symbol });
  assertNoPageErrors(errors);
});

test('in options mode the FUT buttons trade the named nearest future, in its lots', async ({ page }) => {
  const errors = collectPageErrors(page);
  const sent = await openNiftyChart(page);
  const future = await nearestFuture();
  await optionsOn(page);

  const fut = page.locator('.chart-ticket-col', { has: page.locator('[data-fut-side]') });
  for (const side of ['BUY', 'SELL', 'SHORT', 'COVER', 'EXIT']) {
    await expect(fut.locator(`[data-fut-side="${side}"]`)).toBeVisible();
  }
  await expect(fut.locator('.chart-ticket-col-label')).toHaveAttribute('title', future.symbol);

  await confirm(page, '[data-fut-side="BUY"]', [future.symbol, '2 lots', `× ${future.lotsize}`]);
  await expect.poll(() => sent.length, { timeout: 10000 }).toBe(1);
  expect(sent[0]).toMatchObject({ action: 'BUY', tradeMode: 'FUTURES', expiry: future.expiry, quantity: 2 });
  expect(sent[0].optionsLeg, 'a futures order carries no option fields').toBeUndefined();
  assertNoPageErrors(errors);
});

test('the main tickets offer COVER and EXIT, and they act on the named future', async ({ page }) => {
  const errors = collectPageErrors(page);
  const sent = await openNiftyChart(page);
  const future = await nearestFuture();

  await expect(page.locator('.chart-tickets [data-side="COVER"]')).toBeVisible();
  await confirm(page, '.chart-tickets [data-side="EXIT"]', [future.symbol, 'the whole open position']);
  await confirm(page, '.chart-tickets [data-side="COVER"]', [future.symbol, '2 lots']);
  await expect.poll(() => sent.length, { timeout: 10000 }).toBe(2);
  expect(sent[0]).toMatchObject({ action: 'EXIT', tradeMode: 'FUTURES', expiry: future.expiry });
  expect(sent[1]).toMatchObject({ action: 'COVER', tradeMode: 'FUTURES', expiry: future.expiry, quantity: 2 });
  assertNoPageErrors(errors);
});

/** Options on, panes built; returns the PE pane's contract. Captures POST /orders too. */
async function withPanes(page) {
  const orders = [];
  await page.route('**/api/v1/orders', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    orders.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, json: { status: 'success', data: { orderid: 'e2e' } } });
  });
  await optionsOn(page);
  await expect(page.locator('.chart-pane[data-pane="pe"] .chart-pane-sym')).toBeVisible({ timeout: 30000 });
  await page.waitForFunction(() => Boolean(window.app.optionPanes?.pe?.chart && window.app.optionPanes?.ce?.chart), null, { timeout: 30000 });
  const contract = await page.evaluate(() => window.app.optionPanes.pe.contract);
  return { orders, contract };
}

test('an option chart trades its own contract at market, from its header and its menu', async ({ page }) => {
  const errors = collectPageErrors(page);
  await openNiftyChart(page);
  const { orders, contract } = await withPanes(page);
  const pe = page.locator('.chart-pane[data-pane="pe"]');

  await confirm(page, '.chart-pane[data-pane="pe"] [data-pane-trade="BUY"]', [contract.symbol, 'Market', '2 lots']);
  await expect.poll(() => orders.length, { timeout: 10000 }).toBe(1);
  expect(orders[0]).toMatchObject({
    symbol: contract.symbol, exchange: contract.exchange, action: 'BUY', pricetype: 'MARKET',
    quantity: 2 * contract.lotsize,
  });

  // Right-click: Market is always offered; limit/stop keep their side-of-price rules.
  await pe.locator('.chart-pane-body').click({ button: 'right', position: { x: 120, y: 60 } });
  const menu = page.locator('#chart-ctx');
  await expect(menu.getByRole('button', { name: 'Buy Market' })).toBeEnabled();
  await expect(menu.getByRole('button', { name: 'Sell Market' })).toBeEnabled();
  await menu.getByRole('button', { name: 'Sell Market' }).click();
  await page.locator('.modal-overlay .chart-confirm [data-action="go"]').click();
  await expect.poll(() => orders.length, { timeout: 10000 }).toBe(2);
  expect(orders[1]).toMatchObject({ symbol: contract.symbol, action: 'SELL', pricetype: 'MARKET' });

  // EXIT with nothing open says so and sends nothing.
  await pe.locator('[data-pane-trade="EXIT"]').click();
  await expect(page.locator('.alert', { hasText: `No open position in ${contract.symbol}` })).toBeVisible();
  expect(orders.length).toBe(2);
  assertNoPageErrors(errors);
});

test('the main chart\'s indicators, settings included, copy onto the option charts', async ({ page }) => {
  const errors = collectPageErrors(page);
  await openNiftyChart(page);
  await withPanes(page);

  // Two indicators on the main chart, one with a non-default setting; a different one on CE.
  const want = await page.evaluate(() => {
    const app = window.app;
    for (const [id, v] of Object.entries(app.indicatorConfig())) if (v.on) app.toggleIndicator(id);
    const ids = ['rsi', 'macd'].filter((id) => app.indicatorConfig()[id]);
    ids.forEach((id) => app.toggleIndicator(id));
    app.setIndicatorParam('rsi', 'length', 9);
    const other = Object.keys(app.indicatorConfig('ce')).find((id) => !ids.includes(id));
    if (!app.indicatorConfig('ce')[other].on) app.toggleIndicator(other, 'ce');
    return { ids: ids.sort(), rsiLength: app.indicatorConfig().rsi.settings.length };
  });
  expect(want.ids).toEqual(['macd', 'rsi']);

  await page.click('[data-pop="indicators"]');
  await page.click('#chart-indicators-bar [data-action="copy-panes"]');
  await page.click('[data-pop="indicators"]');

  const got = await page.evaluate(() => {
    const app = window.app;
    const on = (scope) => app.activeIndicatorDefs(scope).map((d) => d.id).sort();
    return {
      ce: on('ce'), pe: on('pe'),
      ceRsi: app.indicatorConfig('ce').rsi.settings.length,
      ceLive: app.optionPanes.ce.liveIndicators?.size ?? 0,
      peLive: app.optionPanes.pe.liveIndicators?.size ?? 0,
    };
  });
  expect(got).toEqual({ ce: want.ids, pe: want.ids, ceRsi: 9, ceLive: 2, peLive: 2 });
  assertNoPageErrors(errors);
});

test('an option chart put off its data by a new bar is brought back to its candles', async ({ page }) => {
  test.setTimeout(180000);
  const errors = collectPageErrors(page);
  await openNiftyChart(page);
  await withPanes(page);

  // The charting library, on some appends, moves a pane's view ~1000 bars past its data (captured
  // 30 Sep 2026: 1067-1126 -> 2070-2129 on 1123 bars) and the pane shows an empty grid. It is
  // intermittent, so it is reproduced here exactly as captured, on the pane's next real append.
  await page.evaluate(() => {
    const p = window.app.optionPanes.pe;
    const update = p.series.update;
    let lastTime = p.candles[p.candles.length - 1].ts;
    p.series.update = function (bar) {
      const res = update.call(this, bar);
      if (bar.time > lastTime && !window.__appended) {
        window.__appended = true;
        const r = p.chart.getVisibleLogicalRange();
        p.chart.setVisibleLogicalRange({ from: r.from + 1003, to: r.to + 1003 });
      }
      lastTime = Math.max(lastTime, bar.time);
      return res;
    };
  });
  // Outside market hours no new minute arrives by itself - start one with the pane's own price.
  await page.evaluate(() => {
    const p = window.app.optionPanes.pe;
    const bucket = Math.floor((Date.now() / 1000 + 19800) / 60) * 60 - 19800;
    if (p.candles[p.candles.length - 1].ts < bucket) {
      window.app.applyPaneQuote('pe', { ltp: p.candles[p.candles.length - 1].close });
    }
  });
  await page.waitForFunction(() => window.__appended, null, { timeout: 90000 });
  await page.waitForTimeout(500);

  const view = await page.evaluate(() => {
    const p = window.app.optionPanes.pe;
    const r = p.chart.getVisibleLogicalRange();
    return { from: r.from, to: r.to, bars: p.candles.length };
  });
  expect(view.to, JSON.stringify(view)).toBeLessThanOrEqual(view.bars + 50);
  expect(view.from, JSON.stringify(view)).toBeLessThan(view.bars);
  assertNoPageErrors(errors);
});

test('the size hint and its tooltip follow the Lots box', async ({ page }) => {
  const errors = collectPageErrors(page);
  await openNiftyChart(page); // Lots 2, Jz Kotak (x1)
  const kotak = await instance('Jz Kotak');
  const mult = Math.max(1, Number(kotak.multiplier) || 1);
  const future = await (async () => {
    const { default: roll } = await import('../src/services/futures-roll.service.js');
    return (await roll.listFutures('NFO', 'NIFTY'))[0];
  })();
  const hint = page.locator('#chart-size-hint');

  const check = async (lotSize) => {
    for (const lots of [3, 5, 1]) {
      await page.fill('#chart-qty', String(lots));
      const units = lots * lotSize;
      await expect(hint).toHaveText(`→ ${(units * mult).toLocaleString('en-IN')} units`);
      await expect(hint).toHaveAttribute('title', new RegExp(`^${lots} lots? = ${units.toLocaleString('en-IN')} units`));
    }
  };
  await check(future.lotsize); // main tickets trade the NIFTY future
  await optionsOn(page);
  await check(await page.evaluate(() => window.app.chartTradeInfo.symbol.optionLotSize)); // NIFTY options
  assertNoPageErrors(errors);
});

test('a buy limit above the price (or sell limit below) is offered as "fills now", on the call chart too', async ({ page }) => {
  const errors = collectPageErrors(page);
  await openNiftyChart(page);
  const { orders } = await withPanes(page);
  const body = page.locator('.chart-pane[data-pane="ce"] .chart-pane-body');
  const menu = page.locator('#chart-ctx');

  /**
   * Right-click the middle of the CE pane with the price under the cursor pinned to `factor` x
   * its last price - live prices and ATM rebuilds would otherwise move the target between reading
   * it and clicking. Returns the last price the menu judged against and the contract it named.
   */
  const rightClickAt = async (factor) => {
    let out;
    await expect(async () => {
      await page.keyboard.press('Escape');
      await page.mouse.click(5, 5);
      await expect(menu).toBeHidden({ timeout: 2000 });
      out = await page.evaluate((f) => {
        const p = window.app.optionPanes.ce;
        const last = p.candles[p.candles.length - 1].close;
        const target = Number((last * f).toFixed(2));
        p.chart.coordinateToPrice = () => target;
        return { last, target, symbol: p.contract.symbol };
      }, factor);
      await body.click({ button: 'right', timeout: 3000 });
      await expect(menu.locator('.chart-ctx-head')).toContainText(out.symbol, { timeout: 2000 });
    }).toPass({ timeout: 30000 });
    return out;
  };

  // Above the last price: buy now with a cap. Sell stop still invalid.
  const { last, symbol } = await rightClickAt(1.05);
  const buyLimit = menu.getByRole('button', { name: /^Buy Limit @ .* \(fills now\)$/ });
  await expect(buyLimit).toBeEnabled();
  await expect(menu.getByRole('button', { name: /^Buy Stop @/ })).toBeEnabled();
  await expect(menu.getByRole('button', { name: /^Sell Stop @/ })).toBeDisabled();
  await buyLimit.click();
  const dialog = page.locator('.modal-overlay .chart-confirm');
  await expect(dialog).toContainText('fills now');
  await expect(dialog).toContainText(`the last price (${await page.evaluate((v) => Utils.formatNumber(v), last)})`);
  await dialog.locator('[data-action="go"]').click();
  await expect.poll(() => orders.length, { timeout: 10000 }).toBe(1);
  expect(orders[0]).toMatchObject({ symbol, action: 'BUY', pricetype: 'LIMIT' });
  expect(orders[0].price).toBeGreaterThan(last);

  // Below the last price: sell now with a floor. Buy stop still invalid.
  await rightClickAt(0.95);
  await expect(menu.getByRole('button', { name: /^Sell Limit @ .* \(fills now\)$/ })).toBeEnabled();
  await expect(menu.getByRole('button', { name: /^Buy Limit @ [\d.,]+$/ })).toBeEnabled();
  await expect(menu.getByRole('button', { name: /^Buy Stop @/ })).toBeDisabled();
  assertNoPageErrors(errors);
});


test('the option charts stay on their contracts when NIFTY moves; ATM is offered, never forced', async ({ page }) => {
  const errors = collectPageErrors(page);
  await openNiftyChart(page);
  await withPanes(page);
  const before = await page.evaluate(() => ({ ce: window.app.paneContracts.ce.symbol, pe: window.app.paneContracts.pe.symbol }));

  // NIFTY 400 points higher, then a rebuild (what a timeframe or indicator change does). With the
  // market open a live tick would put the real price straight back, so the feed is silenced.
  await page.evaluate(async () => {
    window.app.stopChartLiveUpdates();
    window.app.applyChartQuote = () => false;
    window.app.chartLastPrice += 400;
    await window.app.refreshOptionPanes();
  });
  const after = await page.evaluate(() => ({ ce: window.app.paneContracts.ce.symbol, pe: window.app.paneContracts.pe.symbol }));
  expect(after, 'a rebuild keeps the contracts on screen').toEqual(before);

  const atm = page.locator('#chart-pane-bar [data-action="to-atm"]');
  await expect(atm, 'the new ATM is offered').toBeVisible();
  await expect(atm).toContainText('ATM is now');
  await atm.click();
  await page.waitForFunction((b) => window.app.paneContracts?.ce && window.app.paneContracts.ce.symbol !== b.ce, before, { timeout: 30000 });
  await expect(atm).toHaveCount(0);
  assertNoPageErrors(errors);
});

test('a contract with a position shows as a chip and goes onto its chart in one click', async ({ page }) => {
  const errors = collectPageErrors(page);
  await openNiftyChart(page);
  await withPanes(page);
  const shown = await page.evaluate(() => window.app.paneContracts);

  // A PE two strikes away with a position - what /history/exposure reports after a fill.
  const { default: db } = await import('../src/core/database.js');
  const held = await db.get(
    `SELECT symbol, exchange, instrumenttype AS type, strike, expiry, lotsize FROM instruments
      WHERE underlying_key = 'NIFTY' AND instrumenttype = 'PE' AND expiry = ? AND strike < ?
      ORDER BY strike DESC LIMIT 1 OFFSET 1`,
    [shown.pe.expiry, shown.pe.strike]
  );
  await page.route('**/api/v1/history/exposure**', (route) => route.fulfill({
    status: 200, json: { status: 'success', data: [{ ...held, netQty: 130, orders: 1 }] },
  }));
  await page.evaluate(() => window.app.refreshExposure());

  const chip = page.locator(`#chart-pane-bar [data-pin="${held.symbol}"]`);
  await expect(chip).toContainText(`${held.strike} PE · +130 · 1 order`);
  await chip.click();
  await page.waitForFunction((sym) => window.app.paneContracts?.pe?.symbol === sym, held.symbol, { timeout: 30000 });
  await expect(page.locator('.chart-pane[data-pane="pe"] .chart-pane-sym')).toHaveText(held.symbol);
  expect(await page.evaluate(() => window.app.paneContracts.ce.symbol), 'the CE chart is left alone').toBe(shown.ce.symbol);
  await expect(chip).toHaveClass(/is-shown/);
  assertNoPageErrors(errors);
});

/**
 * Phase 2 - the trade layer. The order and position books are supplied here (a fan-out of one
 * chart order across two accounts, and a position on the PE contract), and every modify, cancel
 * and close is intercepted: nothing reaches a broker.
 */
async function withTradeBook(page, { analyzer, atMarket = false }) {
  const { contract } = await withPanes(page);
  const pe = await page.evaluate(() => window.app.paneContracts.pe);
  // The order sits at 50 unless asked to sit at the pane's price: with the market open a put can
  // trade far from 50, and a line off the scale cannot be grabbed.
  const px = atMarket
    ? await page.evaluate(() => Math.round(window.app.optionPanes.pe.candles.at(-1).close))
    : 50;
  const stamp = 'chart-9-BUY-LIMIT-1790000000000';
  const rows = [1, 2].map((inst, i) => ({
    id: 900 + i, instance_id: inst, instance_name: inst === 1 ? 'Acct A' : 'Acct B', instance_analyzer: analyzer ? 1 : (inst === 1 ? 1 : 0),
    exchange: pe.exchange, symbol: pe.symbol, side: 'BUY', order_type: 'LIMIT', quantity: 65, price: px, trigger_price: 0,
    status: 'open', request_id: `${stamp}-${inst}`,
  }));
  const calls = [];
  await page.route('**/api/v1/orders?*', (route) => route.fulfill({ status: 200, json: { status: 'success', data: rows.filter((r) => route.request().url().includes(encodeURIComponent(r.symbol))) } }));
  await page.route(/\/api\/v1\/orders\/\d+\/(modify|cancel)$/, (route) => {
    calls.push({ url: route.request().url(), body: route.request().postDataJSON() });
    return route.fulfill({ status: 200, json: { status: 'success', data: { order_type: 'LIMIT', price: route.request().postDataJSON()?.price } } });
  });
  await page.route('**/api/v1/positions/symbol?*', (route) => {
    const hit = route.request().url().includes(encodeURIComponent(pe.symbol));
    return route.fulfill({ status: 200, json: { status: 'success', data: hit
      ? { exchange: pe.exchange, symbol: pe.symbol, netQuantity: 130, avgEntryPrice: 100, totalPnl: 0, instanceCount: 2,
        legs: [{ instanceId: 1, instanceName: 'Acct A', quantity: 65, entryPrice: 100 }, { instanceId: 2, instanceName: 'Acct B', quantity: 65, entryPrice: 100 }] }
      : { netQuantity: 0, legs: [] } } });
  });
  await page.route(/\/api\/v1\/positions\/\d+\/close\/position$/, (route) => {
    calls.push({ url: route.request().url(), body: route.request().postDataJSON() });
    return route.fulfill({ status: 200, json: { status: 'success', data: {} } });
  });
  await page.evaluate(async () => { await window.app.refreshPaneOrderLines('pe'); await window.app.loadPanePosition('pe'); });
  return { pe, calls, contract, px };
}

test('one chart order on two accounts is one line; analyzer-only moves straight away', async ({ page }) => {
  const errors = collectPageErrors(page);
  await openNiftyChart(page);
  const { calls } = await withTradeBook(page, { analyzer: true });

  const layer = await page.evaluate(() => {
    const ol = window.app.optionPanes.pe.orderLines;
    return { lines: ol.lastOrders.length, qty: ol.lastOrders[0]?.qty, group: ol.groups.get('900')?.ids };
  });
  expect(layer).toEqual({ lines: 1, qty: 130, group: [900, 901] });

  await page.evaluate(() => window.app.moveChartOrder(900, 48.5, () => {}, 'pe'));
  await expect(page.locator('.modal-overlay [data-action="confirm"]')).toHaveCount(0);
  await expect.poll(() => calls.length).toBe(2);
  expect(calls.map((c) => c.url.match(/orders\/(\d+)\/modify/)[1]).sort()).toEqual(['900', '901']);
  expect(calls.every((c) => c.body.price === 48.5)).toBe(true);
  assertNoPageErrors(errors);
});

test('a move touching a live account asks first; the position ✕ squares off every account', async ({ page }) => {
  const errors = collectPageErrors(page);
  await openNiftyChart(page);
  const { pe, calls } = await withTradeBook(page, { analyzer: false });

  // Live account in the group: nothing is sent until confirmed.
  const moving = page.evaluate(() => window.app.moveChartOrder(900, 49, () => {}, 'pe'));
  const dialog = page.locator('.modal-overlay', { hasText: 'Move these 2 orders' });
  await expect(dialog).toContainText('Acct B');
  expect(calls.length).toBe(0);
  await dialog.locator('[data-action="confirm"]').click();
  await moving;
  await expect.poll(() => calls.length).toBe(2);

  // The position is the library marker (not a plain line), and its ✕ closes it per account.
  expect(await page.evaluate(() => window.app.optionPanes.pe.orderLines.controller._markers?.size ?? -1)).toBe(1);
  calls.length = 0;
  await page.evaluate(() => window.app.closeChartPosition('pe'));
  await page.locator('.modal-overlay .chart-confirm [data-action="go"]').click();
  await expect.poll(() => calls.length).toBe(2);
  for (const c of calls) expect(c.body).toMatchObject({ symbol: pe.symbol, exchange: pe.exchange, tradeMode: 'OPTIONS' });
  expect(calls.map((c) => c.url.match(/positions\/(\d+)\//)[1]).sort()).toEqual(['1', '2']);
  assertNoPageErrors(errors);
});

/**
 * Phase 3 - exit levels on the underlying, placed and dragged on the NIFTY chart, estimated on the
 * option charts, plus a rupee max-loss. Real server and database (e2e copy); nothing is ordered -
 * a level only acts when NIFTY reaches it, and these are removed before the test ends.
 */
test('an exit level placed on the index chart shows, drags, estimates on the option charts, and is removed', async ({ page }) => {
  test.setTimeout(150000);
  const errors = collectPageErrors(page);
  page.on('dialog', (d) => d.accept('1500'));
  await openNiftyChart(page);
  await page.waitForFunction(() => typeof window.app.openExitLevelDialog === 'function');

  // Right-click the chart with the price under the cursor pinned 1% below the last price.
  // The server's price is the reference a level is judged against - take it from there. After
  // hours the cached candles can sit far from the last quote; one live tick at that price puts a
  // bar there, as any tick in a session would, and the view is reset onto it.
  await page.evaluate(async () => {
    const ref = (await api.request(`/exit-levels/preview?symbolId=${window.app.chartState.symbolId}&price=1`)).data.ltp;
    window.__ref = ref;
    window.app.applyChartQuote({ symbol: 'NIFTY', exchange: 'NSE_INDEX', ltp: ref });
    window.app.resetChartToLastBars(window.app.chart, window.app.chartCandles);
  });
  // Let the chart lay out the new range before measuring against it.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(300);
  const target = await page.evaluate(() => {
    // A little below the price line, inside the visible range, so the line can be dragged.
    const chart = window.app.chart;
    const h = document.getElementById('chart-container').clientHeight;
    const ltpY = chart.priceToCoordinate(window.__ref, 0);
    const t = Number(chart.coordinateToPrice(Math.min(ltpY + 60, h - 80), 0).toFixed(2));
    window.__realCtp = window.app.chart.coordinateToPrice;
    window.app.chart.coordinateToPrice = () => t;
    return t;
  });
  expect(target, 'the test level sits below the reference price').toBeLessThan(await page.evaluate(() => window.__ref));
  await page.locator('#chart-container').click({ button: 'right', position: { x: 200, y: 200 } });
  await page.locator('#chart-ctx [data-action="exit-level"]').click();

  const dialog = page.locator('.modal-overlay .chart-confirm', { hasText: 'Exit level @' });
  await expect(dialog).toContainText('Below the current price');
  await expect(dialog).toContainText('a stop for bullish ones and a target for bearish ones');
  await dialog.locator('[name="sizeMode"]').selectOption('LOTS');
  await dialog.locator('[name="sizeValue"]').fill('1');
  await dialog.locator('[data-action="go"]').click();
  await expect(dialog).toHaveCount(0);

  await page.waitForFunction(() => window.app.activeExitLevels?.().length === 1, null, { timeout: 15000 });
  const level = await page.evaluate(() => window.app.activeExitLevels()[0]);
  expect(level).toMatchObject({ side: 'BELOW', kind: 'LEVEL', size_mode: 'LOTS', size_value: 1, coverage: 'ALL' });
  expect(Number(level.trigger_price)).toBeCloseTo(target, 1);
  expect(await page.evaluate(() => window.app.exitLevelLines.length)).toBe(1);
  await expect(page.locator('#chart-exit-levels')).toContainText('1 lot');

  // Drag the line down 30px: it moves on the server too.
  const y = await page.evaluate((p) => window.app.chart.priceToCoordinate(p, 0), Number(level.trigger_price));
  const box = await page.locator('#chart-container').boundingBox();
  await page.evaluate(() => { window.app.chart.coordinateToPrice = window.__realCtp; });
  await page.mouse.move(box.x + 300, box.y + y);
  await page.mouse.down();
  await page.mouse.move(box.x + 300, box.y + y + 15);
  await page.mouse.move(box.x + 300, box.y + y + 30);
  await page.mouse.up();
  await page.waitForFunction((old) => Number(window.app.activeExitLevels()[0]?.trigger_price) < old, Number(level.trigger_price), { timeout: 15000 });

  // Option charts: an estimated premium for each pane at the level.
  await withPanes(page);
  await page.waitForFunction(() => (window.app.levelProjections || []).length >= 1, null, { timeout: 30000 });
  const proj = await page.evaluate(() => window.app.levelProjections);
  const shown = await page.evaluate(() => [window.app.paneContracts.ce.symbol, window.app.paneContracts.pe.symbol]);
  expect(proj.every((p) => shown.includes(p.symbol) && p.estimate > 0)).toBe(true);

  // Max loss from the PE chart's own menu (the prompt answers 1500).
  await page.evaluate(() => { const p = window.app.optionPanes.pe; p.chart.coordinateToPrice = () => 50; });
  await page.locator('.chart-pane[data-pane="pe"] .chart-pane-body').click({ button: 'right', position: { x: 80, y: 60 } });
  await page.locator('#chart-ctx [data-action="max-loss"]').click();
  await expect(page.locator('#chart-exit-levels')).toContainText('Max loss ₹1,500', { timeout: 15000 });

  // Remove both from the panel.
  await page.locator('#chart-exit-levels [data-remove-level]').click();
  await page.locator('#chart-exit-levels [data-remove-cap]').click();
  await page.waitForFunction(() => !window.app.activeExitLevels().length && !(window.app.exitCaps || []).length, null, { timeout: 15000 });
  assertNoPageErrors(errors);
});

/** The points-from-entry target/stop line drags by the pointer, not by a chart pan under it. */
test('dragging the points target line moves it with the pointer instead of panning the chart', async ({ page }) => {
  test.setTimeout(120000);
  const errors = collectPageErrors(page);
  await openNiftyChart(page);
  const setup = await page.evaluate(async () => {
    const app = window.app;
    const ref = (await api.request(`/exit-levels/preview?symbolId=${app.chartState.symbolId}&price=1`)).data.ltp;
    app.applyChartQuote({ symbol: 'NIFTY', exchange: 'NSE_INDEX', ltp: ref });
    // With the market open a live tick rescales the chart between measuring the line and grabbing it.
    app.stopChartLiveUpdates();
    app.applyChartQuote = () => false;
    app.resetChartToLastBars(app.chart, app.chartCandles);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const ltpY = app.chart.priceToCoordinate(ref, 0);
    const price = app.chart.coordinateToPrice(ltpY - 60, 0);
    const entry = ref - 50;
    app.chartPositionData = { netQuantity: 1, avgEntryPrice: entry, legs: [{}] };
    app.chartLevels = { mode: 'PER_POSITION', points: { target: Number((price - entry).toFixed(2)), stoploss: null } };
    app.redrawChartLines();
    // The panel input is not rendered for this stubbed position; record what the drag previews.
    const preview = app.previewLevelFromInput.bind(app);
    app.previewLevelFromInput = (kind, raw) => { window.__dragPts = Number(raw); preview(kind, raw); };
    const y = app.chart.priceToCoordinate(price, 0);
    // Where 30px lower is, on the scale as it stands before anything is dragged.
    return { y, expectedPts: Number((app.chart.coordinateToPrice(y + 30, 0) - entry).toFixed(2)) };
  });
  const box = await page.locator('#chart-container').boundingBox();
  await page.mouse.move(box.x + 300, box.y + setup.y);
  await page.mouse.down();
  await page.mouse.move(box.x + 300, box.y + setup.y + 15);
  await page.mouse.move(box.x + 300, box.y + setup.y + 30);
  await page.mouse.up();
  // A chart panning under the pointer keeps the price under it almost where it started, so the
  // level would land near its old points instead of 30px down the scale.
  const pts = await page.evaluate(() => window.__dragPts);
  expect(Math.abs(pts - setup.expectedPts), `level previewed at ${pts} pts, expected ${setup.expectedPts}`).toBeLessThan(2);
  assertNoPageErrors(errors);
});

/**
 * A right-click Limit on an index chart used to post the INDEX itself (NSE_INDEX:NIFTY), which the
 * server refuses ("Index symbols cannot be traded directly"), so the order never reached a broker.
 * It now names the index's future. The request is intercepted: nothing is sent anywhere.
 */
test('a limit from the index chart menu orders the index future, not the index', async ({ page }) => {
  test.setTimeout(120000);
  const errors = collectPageErrors(page);
  await openNiftyChart(page);
  const posted = [];
  await page.route('**/api/v1/orders', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    posted.push(route.request().postDataJSON());
    return route.fulfill({ status: 201, json: { status: 'success', data: { id: 1 } } });
  });
  const ref = await page.evaluate(() => window.app.chartLastPrice);
  await page.evaluate((p) => { window.app.chart.coordinateToPrice = () => p - 50; }, ref);
  await page.locator('#chart-container').click({ button: 'right', position: { x: 200, y: 200 } });
  await page.locator('#chart-ctx [data-trade-i]', { hasText: /Buy .* Limit @/ }).click();
  const dialog = page.locator('.modal-overlay .chart-confirm');
  await expect(dialog).toContainText(/FUT/);
  await dialog.locator('[data-action="go"]').click();
  await expect.poll(() => posted.length, { timeout: 10000 }).toBeGreaterThan(0);
  for (const body of posted) {
    expect(body.symbol, 'the future, not the index').toMatch(/FUT$/);
    expect(body.exchange).toBe('NFO');
    expect(body.pricetype).toBe('LIMIT');
    expect(body.symbolId, 'the future is not a watchlist row').toBeUndefined();
  }
  assertNoPageErrors(errors);
});

/**
 * The real gesture. The engine starts dragging an order line only once something subscribes to
 * drags, which the app did not do, so the lines showed a resize cursor and never moved. The other
 * tests call moveChartOrder directly and could not see it.
 */
test('dragging a working order line with the mouse moves the order', async ({ page }) => {
  test.setTimeout(150000);
  const errors = collectPageErrors(page);
  await openNiftyChart(page);
  const { calls, px } = await withTradeBook(page, { analyzer: true, atMarket: true });
  // The pane can still be rebuilding when the book lands; grab the line only once it is settled.
  await page.waitForFunction(() => window.app.optionPanes.pe.orderLines?.groups?.has('900'));
  await page.waitForTimeout(1000);
  await page.waitForFunction((p) => Number.isFinite(window.app.optionPanes.pe.chart.priceToCoordinate(p, 0)), px, { timeout: 15000 });
  const at = await page.evaluate((px) => {
    const r = document.querySelector('.chart-pane[data-pane="pe"] .chart-pane-body').getBoundingClientRect();
    return { x: r.x, top: r.y, y: window.app.optionPanes.pe.chart.priceToCoordinate(px, 0) };
  }, px);
  // The BUY tag of the line at px - the part of the line that takes the grab.
  await page.mouse.move(at.x + 200, at.top + at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 200, at.top + at.y + 12, { steps: 4 });
  await page.mouse.move(at.x + 200, at.top + at.y + 24, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => calls.length, { timeout: 10000 }).toBe(2);
  expect(calls.every((c) => /orders\/90[01]\/modify$/.test(c.url) && c.body.price < px)).toBe(true);
  assertNoPageErrors(errors);
});

/**
 * An order placed from the index chart is held on the index's future (NIFTY27OCT26FUT), so the
 * chart used to look for it under NIFTY, find nothing, and show no line to modify or cancel.
 */
test('an order sent from the index chart shows as a line on it, though it is held on the future', async ({ page }) => {
  test.setTimeout(120000);
  const errors = collectPageErrors(page);
  await openNiftyChart(page);
  const future = await page.evaluate(() => window.app.chartFuture);
  const ref = await page.evaluate(() => Math.round(window.app.chartLastPrice));
  await page.route('**/api/v1/orders?*', (route) => route.fulfill({ status: 200, json: { status: 'success', data: [{
    id: 777, instance_id: 1, instance_name: 'Acct A', instance_analyzer: 1, exchange: future.exchange, symbol: future.symbol,
    side: 'BUY', order_type: 'LIMIT', quantity: 975, price: ref - 40, trigger_price: 0, status: 'open', request_id: 'chart-1-BUY-LIMIT-1790000000000-1',
  }] } }));
  await page.evaluate(() => window.app.refreshOrderLines());
  await page.waitForFunction(() => window.app.orderLinesState().groups?.has('777'), null, { timeout: 15000 });
  expect(await page.evaluate(() => window.app.orderLinesState().lastOrders.length)).toBe(1);
  assertNoPageErrors(errors);
});
