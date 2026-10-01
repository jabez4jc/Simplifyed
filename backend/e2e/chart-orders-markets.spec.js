import { test, expect } from '@playwright/test';
import { login, switchView, collectPageErrors } from './helpers.js';
import { instance, assertAnalyzer, brokerOrder, flatten } from './broker.js';

/**
 * Orders placed, moved and cancelled from the chart, checked against each BROKER's own order book
 * on every market the chart trades: crypto (Delta), an MCX future, an NFO future, the NIFTY index
 * chart (whose orders go to its future) and the CE/PE option charts.
 *
 * The app's own order table is not evidence: a modify the broker ignored would still read as moved
 * there. So every placement and every drag is read back from the broker. All instances are in
 * analyzer mode, confirmed at the broker first. afterAll cancels only the orders this suite placed
 * (an operator's own resting orders on the same contract are left alone), flattens only if one of
 * them filled, and fails if any of them is left open.
 */

test.describe.configure({ mode: 'serial' });

const KOTAK = 'Jz Kotak';
const FYERS = 'Jz Fyers';
const CRYPTO = 'Jabez Crypto';

const SCENARIOS = [
  {
    title: 'crypto future (Delta)',
    instances: [CRYPTO],
    row: { symbol: 'BTCUSDFUT', exchange: 'CRYPTO', symbol_type: 'FUTURES', underlying_symbol: 'BTC', tradable_futures: true },
    trade: { symbol: 'BTCUSDFUT', exchange: 'CRYPTO' },
    lot: 1,
  },
  {
    title: 'MCX future',
    instances: [KOTAK, FYERS],
    row: { symbol: 'CRUDEOILM19OCT26FUT', exchange: 'MCX', symbol_type: 'FUTURES', underlying_symbol: 'CRUDEOILM', tradable_futures: true },
    trade: { symbol: 'CRUDEOILM19OCT26FUT', exchange: 'MCX' },
    lot: 10,
  },
  {
    title: 'MCX future with broker lot units (GOLDM)',
    instances: [KOTAK, FYERS],
    row: { symbol: 'GOLDM05NOV26FUT', exchange: 'MCX', symbol_type: 'FUTURES', underlying_symbol: 'GOLDM', tradable_futures: true },
    trade: { symbol: 'GOLDM05NOV26FUT', exchange: 'MCX' },
    lot: 10,
  },
  {
    title: 'NFO future',
    instances: [KOTAK, FYERS],
    row: { symbol: 'NIFTY27OCT26FUT', exchange: 'NFO', symbol_type: 'FUTURES', underlying_symbol: 'NIFTY', tradable_futures: true },
    trade: { symbol: 'NIFTY27OCT26FUT', exchange: 'NFO' },
    lot: 65,
  },
  {
    title: 'NIFTY index chart, ordering its future',
    instances: [KOTAK, FYERS],
    row: { symbol: 'NIFTY', exchange: 'NSE_INDEX', symbol_type: 'INDEX', underlying_symbol: 'NIFTY', tradable_futures: true, tradable_options: true },
    trade: { symbol: 'NIFTY27OCT26FUT', exchange: 'NFO' },
    lot: 65,
    index: true,
  },
  {
    title: 'NIFTY option chart (PE)',
    instances: [KOTAK, FYERS],
    row: { symbol: 'NIFTY', exchange: 'NSE_INDEX', symbol_type: 'INDEX', underlying_symbol: 'NIFTY', tradable_futures: true, tradable_options: true },
    pane: 'pe',
    lot: 65,
  },
];

for (const sc of SCENARIOS) {
  test.describe(sc.title, () => {
    test.setTimeout(240000);
    let page;
    let errors;
    let trade; // { symbol, exchange } the orders go to
    const placed = []; // app order rows this suite created
    const multiplier = {};

    const chartExpr = sc.pane ? `window.app.optionPanes.${sc.pane}.chart` : 'window.app.chart';
    const hostSel = sc.pane ? `.chart-pane[data-pane="${sc.pane}"] .chart-pane-body` : '#chart-container';
    const lastPrice = () => page.evaluate((pane) => (pane
      ? window.app.optionPanes[pane].candles.at(-1).close
      : window.app.chartLastPrice), sc.pane || null);
    const yOf = (price) => page.evaluate(([expr, p]) => eval(expr).priceToCoordinate(p, 0), [chartExpr, price]);
    const box = () => page.locator(hostSel).boundingBox();
    const appOrders = () => page.evaluate(async (s) => (await api.request(`/orders?symbol=${encodeURIComponent(s)}&status=open,pending`)).data, trade.symbol);

    test.beforeAll(async ({ browser }) => {
      for (const name of sc.instances) {
        await assertAnalyzer(name);
        multiplier[(await instance(name)).id] = Number((await instance(name)).multiplier) || 1;
      }
      page = await browser.newPage();
      errors = collectPageErrors(page);
      // Market orders are not part of this suite; nothing here should ever send one.
      await page.route('**/api/v1/quickorders', (route) => (route.request().method() === 'POST'
        ? route.fulfill({ status: 500, json: { status: 'error', message: 'quick orders are blocked in this suite' } })
        : route.continue()));
      await login(page);
      const ids = [];
      for (const name of sc.instances) ids.push((await instance(name)).id);
      const symbolId = await page.evaluate(async ({ ids, row }) => {
        const wl = (await api.createWatchlist({ name: `E2E Chart Markets ${Date.now()}` })).data;
        for (const id of ids) await api.assignInstance(wl.id, id);
        const added = (await api.addSymbol(wl.id, { tradable_equity: false, tradable_options: false, ...row })).data;
        localStorage.setItem('chart-preference', JSON.stringify({ symbolId: added.id, timeframe: '5m', product: 'NRML', qty: 1 }));
        localStorage.setItem('chart-sync', JSON.stringify({ interval: true, crosshair: false, viewport: false }));
        return added.id;
      }, { ids, row: sc.row });
      await switchView(page, 'chart');
      await expect(page.locator('#chart-symbol')).toHaveValue(String(symbolId), { timeout: 20000 });
      await page.waitForFunction(() => Boolean(window.app?.chartLastPrice && window.app.chartTradeInfo), null, { timeout: 60000 });
      if (sc.pane) {
        await page.waitForFunction(() => window.app.optionsAvailable?.(), null, { timeout: 30000 });
        await page.click('[data-pop="options"]');
        await page.check('#chart-opt-on');
        await page.click('[data-pop="options"]');
        await page.waitForFunction((k) => window.app.optionPanes?.[k]?.chart && window.app.optionPanes[k].candles?.length, sc.pane, { timeout: 60000 });
        trade = await page.evaluate((k) => ({ ...window.app.optionPanes[k].contract }), sc.pane);
      } else if (sc.index) {
        await page.waitForFunction(() => window.app.chartFuture, null, { timeout: 30000 });
        trade = sc.trade;
      } else {
        trade = sc.trade;
      }
      // A view that sits on the latest bars, so a line near the last price is on screen.
      await page.evaluate((expr) => window.app.frameLatestBars(eval(expr)), chartExpr);
      await page.waitForTimeout(800);
    });

    test.afterAll(async () => {
      // Only what this suite placed is touched: an operator's own resting orders on the same
      // contract stay where they are. A row still resting is cancelled; one that filled means a
      // position this suite opened, which is flattened.
      if (page) {
        await page.evaluate(async (rows) => {
          for (const r of rows) { try { await api.request(`/orders/${r.id}/cancel`, { method: 'POST' }); } catch (_) { /* gone */ } }
        }, placed).catch(() => {});
      }
      const leftovers = [];
      let filled = false;
      for (const r of placed) {
        const owner = await ownerOf(r);
        const status = String((await brokerOrder(owner, r.order_id))?.order_status || '').toLowerCase();
        if (/complete|fill/.test(status)) filled = true;
        else if (!/cancel|reject/.test(status)) leftovers.push(`${owner}: order ${r.order_id} ${trade.symbol} ${status}`);
      }
      if (filled) leftovers.push(...await flatten(sc.instances.map((name) => ({ name, ...trade }))));
      await page?.close();
      expect(leftovers, `left open at the broker:\n${leftovers.join('\n')}`).toEqual([]);
    });

    /** Right-click `dy` px from the last price, pick the item matching `label`, confirm. Returns the price picked. */
    async function menuOrder(dy, label) {
      const before = new Set((await appOrders()).map((o) => o.id));
      const b = await box();
      const y = Math.max(30, Math.min(b.height - 60, (await yOf(await lastPrice())) + dy));
      await page.locator(hostSel).click({ button: 'right', position: { x: Math.round(b.width / 2), y: Math.round(y) } });
      const item = page.locator(sc.pane ? '#chart-ctx .chart-ctx-item[data-i]' : '#chart-ctx [data-trade-i]', { hasText: label });
      await expect(item).toBeEnabled();
      const text = await item.innerText();
      await item.click();
      const dialog = page.locator('.modal-overlay .chart-confirm');
      await expect(dialog).toBeVisible({ timeout: 10000 });
      await dialog.locator('[data-action="go"]').click();
      await expect(dialog).toHaveCount(0);
      await expect.poll(async () => (await appOrders()).filter((o) => !before.has(o.id)).length, { timeout: 40000 }).toBe(sc.instances.length);
      const rows = (await appOrders()).filter((o) => !before.has(o.id));
      placed.push(...rows);
      const num = (re) => { const m = text.match(re); return m ? Number(m[1].replace(/,/g, '')) : null; };
      // An index chart names the index level picked and the future's price it was sent at.
      return { picked: num(/@ ([\d,.]+)/), sent: num(/FUT ([\d,.]+)/) ?? num(/@ ([\d,.]+)/), rows };
    }

    /** The instance name an app order row belongs to. */
    async function ownerOf(row) {
      return (await Promise.all(sc.instances.map(instance))).find((i) => i.id === row.instance_id).name;
    }

    /** Every row's broker order: symbol, side, type, size and price as asked. */
    async function expectAtBroker(rows, { side, stop, price }) {
      for (const r of rows) {
        const owner = await ownerOf(r);
        let b = null;
        await expect.poll(async () => { b = await brokerOrder(owner, r.order_id); return Boolean(b); }, { timeout: 30000 }).toBe(true);
        expect(b.symbol, owner).toBe(trade.symbol);
        expect(String(b.action).toUpperCase(), owner).toBe(side);
        expect(Number(b.quantity), `${owner} size`).toBe(sc.lot * multiplier[r.instance_id]);
        expect(String(b.order_status || b.status).toLowerCase(), `${owner} rests`).toMatch(/open|trigger|pending/);
        const at = stop ? Number(b.trigger_price) : Number(b.price);
        expect(at, `${owner} ${stop ? 'trigger' : 'price'} at the broker`).toBeCloseTo(price, 1);
        expect(String(b.pricetype).toUpperCase(), owner).toMatch(stop ? /SL/ : /LIMIT/);
      }
    }

    /** Find a point on the line that the engine reports as the order's own drag target. */
    async function grabPoint(price) {
      const b = await box();
      await page.evaluate((expr) => {
        window.__hover = null;
        const c = eval(expr);
        if (c.__hoverBound) return;
        c.__hoverBound = true;
        c.on('hover', (e) => { window.__hover = e?.id || null; });
      }, chartExpr);
      const seen = new Set();
      for (let x = b.width - 70; x > 20; x -= 6) {
        const y = await yOf(price);
        await page.mouse.move(b.x + x, b.y + y);
        const id = (await page.evaluate(() => window.__hover)) || '';
        seen.add(id);
        if (/^order:\d+$/.test(id)) return { x: b.x + x, y: b.y + y };
      }
      // What was there instead, for the report.
      console.log('GRAB-MISS', JSON.stringify({ price, y: await yOf(price), height: b.height, seen: [...seen],
        layer: await page.evaluate((pane) => {
          const s = pane ? window.app.optionPanes[pane].orderLines : window.app.orderLinesState();
          return { orders: (s?.lastOrders || []).map((o) => [o.id, o.type, o.price, o.triggerPrice]), dragging: Boolean(window.app.chart?._lineDragging) };
        }, sc.pane || null) }));
      await page.screenshot({ path: `test-results/grab-miss-${Date.now()}.png` });
      return null;
    }

    /** Drag the line at `price` by `dy` pixels; returns the price the app moved the rows to. */
    async function dragLine(rows, price, dy, stop, from = price) {
      const at = await grabPoint(price);
      expect(at, `the ${stop ? 'stop' : 'limit'} line at ${price} can be grabbed`).not.toBeNull();
      await page.mouse.down();
      await page.mouse.move(at.x, at.y + dy / 2, { steps: 4 });
      await page.mouse.move(at.x, at.y + dy, { steps: 4 });
      await page.mouse.up();
      const field = stop ? 'trigger_price' : 'price';
      await expect.poll(async () => {
        const now = (await appOrders()).filter((o) => rows.some((r) => r.id === o.id));
        return now.length === rows.length && now.every((o) => Number(o[field]) !== from);
      }, { timeout: 30000, message: 'every order of the line moved' }).toBe(true);
      const now = (await appOrders()).filter((o) => rows.some((r) => r.id === o.id));
      const moved = Number(now[0][field]);
      expect(new Set(now.map((o) => Number(o[field]))).size, 'all accounts moved to one price').toBe(1);
      return { rows: now, moved };
    }

    async function cancelLine(rows, price) {
      const b = await box();
      await page.evaluate(() => { window.__hover = null; });
      let hit = null;
      for (let x = b.width - 70; x > 20 && !hit; x -= 4) {
        const y = await yOf(price);
        await page.mouse.move(b.x + x, b.y + y);
        if (/^order:\d+::close$/.test((await page.evaluate(() => window.__hover)) || '')) hit = { x: b.x + x, y: b.y + y };
      }
      expect(hit, 'the ✕ on the line').not.toBeNull();
      await page.mouse.click(hit.x, hit.y);
      await expect.poll(async () => (await appOrders()).filter((o) => rows.some((r) => r.id === o.id)).length, { timeout: 30000 }).toBe(0);
      for (const r of rows) {
        const owner = await ownerOf(r);
        await expect.poll(async () => String((await brokerOrder(owner, r.order_id))?.order_status || '').toLowerCase(), { timeout: 30000 }).toMatch(/cancel/);
      }
    }

    test('a buy limit below the market rests at the broker at the price picked, then drags and cancels', async () => {
      const ltp = await lastPrice();
      const { picked, sent, rows } = await menuOrder(60, /^\s*Buy .*Limit @ [\d,.]+( → FUT [\d,.]+)?\s*$/);
      expect(picked).toBeLessThan(ltp);
      if (sc.index) {
        // The index level, carried to the future at the same distance below ITS market.
        const fut = await page.evaluate(() => window.app.chartFutureLtp);
        expect(fut - sent, 'as far below the future as the level is below the index').toBeCloseTo(ltp - picked, 0);
      }
      await expectAtBroker(rows, { side: 'BUY', stop: false, price: sent });
      const drawnAt = Number(rows[0].price);
      const lineAt = sc.index ? await page.evaluate((p) => window.app.futureToIndexPrice(p), drawnAt) : drawnAt;
      const { rows: moved, moved: to } = await dragLine(rows, lineAt, 30, false, drawnAt);
      expect(to, 'dragged down, so the buy price fell').toBeLessThan(drawnAt);
      await expectAtBroker(moved, { side: 'BUY', stop: false, price: to });
      const nowAt = sc.index ? await page.evaluate((p) => window.app.futureToIndexPrice(p), to) : to;
      await cancelLine(moved, nowAt);
    });

    test('a sell stop below the market rests at its trigger, then drags and cancels', async () => {
      const ltp = await lastPrice();
      const { picked, sent, rows } = await menuOrder(60, /^\s*Sell .*Stop @ [\d,.]+( → FUT [\d,.]+)?\s*$/);
      expect(picked).toBeLessThan(ltp);
      await expectAtBroker(rows, { side: 'SELL', stop: true, price: sent });
      const trig = Number(rows[0].trigger_price);
      const lineAt = sc.index ? await page.evaluate((p) => window.app.futureToIndexPrice(p), trig) : trig;
      const { rows: moved, moved: to } = await dragLine(rows, lineAt, 30, true, trig);
      expect(to, 'dragged down, so the trigger fell').toBeLessThan(trig);
      await expectAtBroker(moved, { side: 'SELL', stop: true, price: to });
      const nowAt = sc.index ? await page.evaluate((p) => window.app.futureToIndexPrice(p), to) : to;
      await cancelLine(moved, nowAt);
      expect(errors.filter((e) => !/Failed to load dashboard view/.test(e)), 'no page errors').toEqual([]);
    });
  });
}
