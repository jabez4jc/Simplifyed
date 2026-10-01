import { test, expect } from '@playwright/test';
import { login, gotoDashboard, switchView } from './helpers.js';
import { instance } from './broker.js';

/**
 * The product picked on screen is the product sent, for calls and puts, from the chart and from
 * the watchlist. The chart used to send no product for option orders, so the server defaulted
 * to MIS whatever was selected.
 *
 * Every order request is answered here (page.route), so nothing reaches a broker - the server
 * side of the same orders runs on the real analyzer account in
 * Test/integration/options-orders.test.js.
 */

const WATCHLIST = 'E2E Options';
let optionSymbolId; // this spec's own BTCUSDFUT row - other specs add one without options

test.beforeEach(async ({ page }) => {
  await login(page);
  await gotoDashboard(page);
  const crypto = await instance('Jabez Crypto');
  optionSymbolId = await page.evaluate(async ({ instanceId, name }) => {
    const list = (await api.getWatchlists()).data || [];
    let wl = list.find((w) => w.name === name);
    if (!wl) {
      wl = (await api.createWatchlist({ name })).data;
      await api.assignInstance(wl.id, instanceId);
      await api.addSymbol(wl.id, {
        symbol: 'BTCUSDFUT', exchange: 'CRYPTO', symbol_type: 'FUTURES', underlying_symbol: 'BTC',
        tradable_futures: true, tradable_options: true,
      });
    }
    const symbols = (await api.request(`/watchlists/${wl.id}/symbols`)).data || [];
    return symbols.find((s) => s.symbol === 'BTCUSDFUT').id;
  }, { instanceId: crypto.id, name: WATCHLIST });
});

/** Answer every quick order in the browser and keep the bodies. */
async function captureQuickOrders(page) {
  const sent = [];
  await page.route('**/api/v1/quickorders', (route) => {
    sent.push(route.request().postDataJSON());
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'success', data: { results: [{ success: true }], summary: { failed: 0 } } }),
    });
  });
  return sent;
}

test('chart: BUY CE and BUY PE go out with the product selected (NRML), not MIS', async ({ page }) => {
  test.setTimeout(120000); // the CE/PE panes load real option history before they can be linked
  const sent = await captureQuickOrders(page);
  // A timeframe saved by an earlier spec (seconds, say) can have no option history at all.
  await page.evaluate((symbolId) => localStorage.setItem('chart-preference',
    JSON.stringify({ symbolId, timeframe: '5m', product: 'MIS', qty: 1 })), optionSymbolId);
  await switchView(page, 'chart');
  const select = page.locator('#chart-symbol');
  await expect(select).toBeVisible({ timeout: 15000 });
  await select.selectOption(String(optionSymbolId));

  await page.locator('.chart-prod-btn[data-product="NRML"]').click();
  // The options panel is drawn once the trade panel has loaded this symbol's option details -
  // wait for it before opening the menu, or the menu opens empty.
  const toggle = page.locator('#chart-opt-on');
  await expect(toggle).toBeAttached({ timeout: 20000 });
  const optionsBtn = page.locator('[data-pop="options"]');
  await optionsBtn.click();
  await expect(toggle).toBeVisible();
  if (!(await toggle.isChecked())) await toggle.check();
  await optionsBtn.click(); // close the popover

  // Underlying, CE and PE are linked (crosshair + time window) and their right edges sit at the
  // same instant - the panes used to keep their own scroll position and drift apart.
  await expect.poll(() => page.evaluate(() => window.app._linkGroup?.members().length || 0), { timeout: 30000 }).toBe(3);
  // The underlying settles on its live edge a moment after the layout does; the panes follow.
  await expect.poll(() => page.evaluate(() => {
    const edges = window.app.chartSyncTargets().map((c) => c.dataLayer.indexToTimeFloat(c.getVisibleLogicalRange().to));
    return Math.max(...edges.slice(1).map((e) => Math.abs(e - edges[0]))) <= timeframeSeconds(window.app.chartState.timeframe);
  }), { timeout: 10000 }).toBe(true);

  // Hovering the underlying marks the same moment on both panes (a vertical line on each).
  // Near the latest bars: an option's history is days shorter than its underlying's, and an
  // instant before a pane's first bar rightly marks nothing there.
  const box = await page.locator('#chart-container').boundingBox();
  let nudge = 0;
  await expect.poll(async () => {
    // The move is repeated: one that lands while the panes are still being laid out is lost.
    await page.mouse.move(box.x + box.width - 140 - (nudge++ % 2) * 6, box.y + box.height * 0.5);
    return page.evaluate(() => window.app.chartSyncTargets().slice(1)
      .map((c) => window.app._linkGroup.crosshairIndex(c)));
  }).toEqual([expect.any(Number), expect.any(Number)]);

  for (const type of ['CE', 'PE']) {
    await page.locator(`[data-option-action="BUY_${type}"]`).click();
    const dialog = page.locator('.modal-overlay');
    await expect(dialog).toContainText('NRML');
    await dialog.locator('[data-action="go"]').click();
    await expect.poll(() => sent.length).toBe(type === 'CE' ? 1 : 2);
  }

  expect(sent.map((b) => [b.action, b.tradeMode, b.product])).toEqual([
    ['BUY_CE', 'OPTIONS', 'NRML'],
    ['BUY_PE', 'OPTIONS', 'NRML'],
  ]);
});

test('watchlist: options offer MIS and NRML, and BUY CE / BUY PE send the one chosen', async ({ page }) => {
  const sent = await captureQuickOrders(page);
  page.on('dialog', (d) => d.accept());
  await switchView(page, 'watchlists');
  const card = page.locator('.watchlist-card-compact', { hasText: WATCHLIST });
  const body = card.locator('.watchlist-card-compact__body');
  if (!(await body.evaluate((el) => el.classList.contains('is-visible')))) {
    await card.locator('.watchlist-card-compact__toggle').click();
  }
  const row = card.locator('tr[data-symbol="BTCUSDFUT"]');
  await expect(row).toBeVisible({ timeout: 15000 });
  const symbolId = await row.getAttribute('data-symbol-id');
  const panel = card.locator(`#expansion-content-${symbolId}`);
  if (!(await panel.isVisible())) await row.locator('[data-toggle-symbol]').click();

  await panel.locator(`.btn-mode-compact[data-mode="OPTIONS"]`).click();
  const product = panel.locator(`select[onchange^="quickOrder.selectProduct"]`);
  await expect(product).toBeEnabled({ timeout: 15000 });
  expect(await product.locator('option').allTextContents()).toEqual(['MIS', 'NRML']);
  await product.selectOption('NRML');

  for (const type of ['CE', 'PE']) {
    await panel.locator(`.btn-buy-${type.toLowerCase()}`).first().click();
    const confirm = page.locator('.modal-overlay button[data-action="confirm"]');
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
    await expect.poll(() => sent.length).toBe(type === 'CE' ? 1 : 2);
  }

  expect(sent.map((b) => [b.action, b.tradeMode, b.product])).toEqual([
    ['BUY_CE', 'OPTIONS', 'NRML'],
    ['BUY_PE', 'OPTIONS', 'NRML'],
  ]);
});
