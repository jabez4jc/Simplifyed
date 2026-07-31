import assert from 'assert';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Folding streamed ticks into the live bar.
 *
 * The failure modes here are all silent. A wrong bucket opens a new candle mid-bar and the chart
 * grows a forest of one-tick bars; a missed high/low quietly understates the range; a late tick
 * accepted after the bar closed rewrites history with a stale price. None of these throw, and
 * all of them look plausible on screen - hence the tests.
 */
const dir = path.dirname(fileURLToPath(import.meta.url));
const load = (f) => fs.readFileSync(path.join(dir, '../../public/js', f), 'utf8');

const IST = 5.5 * 3600;

function app({ timeframe = '5m', candles = [], exchange = 'MCX', symbol = 'NATGASMINI28JUL26FUT' } = {}) {
  const updates = [];
  const sandbox = {
    DashboardApp: function DashboardApp() {},
    IST_OFFSET_SECONDS: IST,
    setInterval: () => 1,
    clearInterval: () => {},
    api: {},
  };
  const keys = Object.keys(sandbox);
  new Function(...keys, load('dashboard-chart-live.js'))(...keys.map((k) => sandbox[k]));

  const a = new sandbox.DashboardApp();
  a.chartState = { exchange, symbol, timeframe };
  a.chartCandles = candles;
  a.candleSeries = { update: (bar) => updates.push(bar) };
  // Matching goes through the watchlist key builder in the real app; this is the same shape.
  a.buildWatchlistSymbolKey = (ex, sym) =>
    (ex && sym ? `${String(ex).toUpperCase()}:${String(sym).toUpperCase()}` : null);
  a.noteStaleQuote = () => {};
  a.renderChartLegend = () => {};
  a.updateTicketPrices = () => {};
  // Lives on the prototype from dashboard-chart-panes.js; counted here so an accepted tick that
  // silently skips the indicators is caught.
  a.indicatorRefreshes = 0;
  a.refreshLiveIndicators = () => { a.indicatorRefreshes += 1; };
  return { a, updates };
}

const tick = (ltp, atSec, symbol = 'NATGASMINI28JUL26FUT') =>
  ({ ltp, ltpTs: atSec * 1000, exchange: 'MCX', symbol });

const volTick = (ltp, atSec, volume) => ({ ...tick(ltp, atSec), volume });

/** 09:15 IST on an arbitrary day, as a true UTC epoch. */
const BASE = Math.floor(Date.UTC(2026, 6, 24, 3, 45, 0) / 1000);
const bar = (ts, o, h, l, c) => ({ ts, open: o, high: h, low: l, close: c, volume: 10 });

test('a tick inside the current bar updates close and extends the range', () => {
  const { a, updates } = app({ candles: [bar(BASE, 100, 102, 99, 101)] });

  assert.strictEqual(a.applyChartQuote(tick(103, BASE + 60)), true);
  assert.strictEqual(a.chartCandles.length, 1, 'must not open a new bar mid-interval');
  assert.deepStrictEqual(
    [a.chartCandles[0].open, a.chartCandles[0].high, a.chartCandles[0].low, a.chartCandles[0].close],
    [100, 103, 99, 103]
  );

  a.applyChartQuote(tick(97, BASE + 120));
  assert.strictEqual(a.chartCandles[0].low, 97, 'a new low must extend the bar, not be dropped');
  assert.strictEqual(a.chartCandles[0].high, 103, 'the high must survive a later lower tick');
  assert.strictEqual(a.chartCandles[0].open, 100, 'the open is fixed once the bar exists');
  assert.strictEqual(a.chartLastPrice, 97);

  // The series is told about every tick, with the raw (unshifted) time - the chart engine
  // renders IST natively from raw UTC seconds, so no display shift is applied here.
  assert.strictEqual(updates.length, 2);
  assert.strictEqual(updates[1].time, BASE);

  // Every accepted tick must advance the indicators too - a moving price over frozen SMAs and a
  // stale RSI is worse than not updating at all, because it reads as a real divergence.
  assert.strictEqual(a.indicatorRefreshes, 2);
});

test('a tick past the interval opens exactly one new bar', () => {
  const { a } = app({ candles: [bar(BASE, 100, 102, 99, 101)] });

  a.applyChartQuote(tick(105, BASE + 300));
  assert.strictEqual(a.chartCandles.length, 2);
  const fresh = a.chartCandles[1];
  assert.strictEqual(fresh.ts, BASE + 300, 'the new bar starts on the interval boundary');
  assert.deepStrictEqual([fresh.open, fresh.high, fresh.low, fresh.close], [105, 105, 105, 105]);

  // Further ticks in the same interval must fold into it, not keep appending.
  a.applyChartQuote(tick(106, BASE + 400));
  a.applyChartQuote(tick(104, BASE + 500));
  assert.strictEqual(a.chartCandles.length, 2, 'one bar per interval');
  assert.deepStrictEqual([fresh.high, fresh.low, fresh.close], [106, 104, 104]);
});

test('buckets align to the timeframe, not to the arrival time', () => {
  for (const [timeframe, seconds] of [['1m', 60], ['15m', 900], ['1h', 3600]]) {
    const { a } = app({ timeframe, candles: [bar(BASE, 100, 100, 100, 100)] });
    // Arrive at an awkward offset; the bar must still start on a boundary.
    a.applyChartQuote(tick(101, BASE + seconds + 37));
    const opened = a.chartCandles[a.chartCandles.length - 1].ts;
    assert.strictEqual((opened + IST) % seconds, 0, `${timeframe} bars must sit on IST boundaries`);
  }
});

test('daily bars roll at the IST session boundary, not at UTC midnight', () => {
  // A UTC-bucketed daily bar would roll over at 05:30 IST - mid-session for crypto.
  const { a } = app({ timeframe: 'D', candles: [] });
  a.applyChartQuote(tick(100, BASE));
  const opened = a.chartCandles[0].ts;
  assert.strictEqual((opened + IST) % 86400, 0);
  // 18:30 UTC is 00:00 IST the next day: the first bar of a new session.
  const nextSession = Math.floor(Date.UTC(2026, 6, 24, 18, 30, 0) / 1000);
  a.applyChartQuote(tick(101, nextSession));
  assert.strictEqual(a.chartCandles.length, 2, 'a new IST day opens a new daily bar');
});

test('a late or replayed tick never rewrites a closed bar', () => {
  const { a, updates } = app({ candles: [bar(BASE, 100, 102, 99, 101), bar(BASE + 300, 101, 104, 100, 103)] });
  assert.strictEqual(a.applyChartQuote(tick(50, BASE + 10)), false, 'a tick for the previous bar is dropped');
  assert.strictEqual(a.chartCandles.length, 2);
  assert.strictEqual(a.chartCandles[0].low, 99, 'the closed bar is untouched');
  assert.strictEqual(updates.length, 0, 'nothing is pushed to the series');
  assert.strictEqual(a.indicatorRefreshes, 0, 'a rejected tick must not recompute anything');
});

test('quotes for other symbols are ignored', () => {
  const { a, updates } = app({ candles: [bar(BASE, 100, 102, 99, 101)] });
  assert.strictEqual(a.applyChartQuote(tick(500, BASE + 60, 'NATURALGAS28JUL26FUT')), false);
  assert.strictEqual(a.applyChartQuote({ ...tick(500, BASE + 60), exchange: 'NSE' }), false);
  assert.strictEqual(a.chartCandles[0].close, 101);
  assert.strictEqual(updates.length, 0);
});

test('an unusable price is dropped rather than drawn', () => {
  const { a, updates } = app({ candles: [bar(BASE, 100, 102, 99, 101)] });
  // A zero LTP is what a broker returns for a contract it has no quote for. Charting it puts a
  // wick from the price down to zero and rescales the whole pane.
  for (const bad of [0, -5, null, undefined, NaN, 'abc']) {
    assert.strictEqual(a.applyChartQuote(tick(bad, BASE + 60)), false, `${bad} must be dropped`);
  }
  assert.strictEqual(a.applyChartQuote(null), false);
  assert.strictEqual(updates.length, 0);
  assert.strictEqual(a.chartCandles[0].close, 101);
});

test('the first tick on an empty chart opens a bar rather than throwing', () => {
  const { a, updates } = app({ candles: [] });
  assert.strictEqual(a.applyChartQuote(tick(100, BASE)), true);
  assert.strictEqual(a.chartCandles.length, 1);
  assert.strictEqual(updates.length, 1);
});

test('volume is the delta of the cumulative counter, not the running total', () => {
  // Broker quotes report session-cumulative volume. Assigning it straight to the bar makes the
  // live candle carry the whole day's volume and drags VWAP toward it.
  const { a } = app({ candles: [] });

  a.applyChartQuote(volTick(100, BASE, 5000));
  const live = a.chartCandles[0];
  assert.strictEqual(live.volume, 0, 'the opening reading is the baseline, not volume traded');

  a.applyChartQuote(volTick(101, BASE + 60, 5300));
  assert.strictEqual(live.volume, 300);
  a.applyChartQuote(volTick(102, BASE + 120, 5900));
  assert.strictEqual(live.volume, 900, 'volume accumulates within the bar');

  // A new bar restarts from its own baseline rather than inheriting the previous bar's.
  a.applyChartQuote(volTick(103, BASE + 300, 6100));
  const next = a.chartCandles[1];
  assert.strictEqual(next.volume, 0);
  a.applyChartQuote(volTick(104, BASE + 360, 6400));
  assert.strictEqual(next.volume, 300);
  assert.strictEqual(live.volume, 900, 'the closed bar keeps its own volume');
});

test('a cumulative counter that goes backwards rebaselines instead of going negative', () => {
  // A session rollover or a feed reset restarts the counter. Subtracting blindly would emit a
  // large negative volume and invert the bar.
  const { a } = app({ candles: [] });
  a.applyChartQuote(volTick(100, BASE, 9000));
  a.applyChartQuote(volTick(101, BASE + 60, 9500));
  assert.strictEqual(a.chartCandles[0].volume, 500);

  a.applyChartQuote(volTick(102, BASE + 120, 20));
  assert.strictEqual(a.chartCandles[0].volume, 0, 'never negative');
  a.applyChartQuote(volTick(103, BASE + 180, 120));
  assert.strictEqual(a.chartCandles[0].volume, 100, 'counts forward from the new baseline');
});

test('a quote with no volume field leaves the bar alone', () => {
  const { a } = app({ candles: [] });
  a.applyChartQuote(tick(100, BASE));
  a.applyChartQuote(tick(101, BASE + 60));
  assert.strictEqual(a.chartCandles[0].volume, 0);
  assert.strictEqual(a.chartCandles[0].close, 101, 'the price still updates');
});

test('a quote older than the age limit is refused', () => {
  // The failure this guards: a broker snapshot cached in January was still being served in
  // July. Charted, NIFTY jumped 23,955 -> 25,665 in one candle and then flat-lined, because
  // every later poll returned the same frozen value.
  const { a, updates } = app({ candles: [bar(BASE, 100, 102, 99, 101)] });
  a.staleNotes = 0;
  a.noteStaleQuote = () => { a.staleNotes += 1; };

  const sixMonths = Date.now() - 190 * 24 * 3600 * 1000;
  assert.strictEqual(a.applyChartQuote({ ...tick(25665.6, BASE + 60), timestamp: sixMonths }), false);
  assert.strictEqual(a.chartCandles[0].close, 101, 'the bar keeps the price it had');
  assert.strictEqual(updates.length, 0);
  assert.ok(a.staleNotes > 0, 'the operator is told, not left staring at a frozen chart');
});

test('a fresh timestamp is accepted, and a missing one is not held against the quote', () => {
  const { a } = app({ candles: [bar(BASE, 100, 102, 99, 101)] });
  a.noteStaleQuote = () => {};
  assert.strictEqual(a.applyChartQuote({ ...tick(103, BASE + 60), timestamp: Date.now() }), true);
  // Some feeds send no clock at all; that is not evidence of staleness.
  assert.strictEqual(a.applyChartQuote(tick(104, BASE + 120)), true);
});

test('timestamps in seconds are understood as well as milliseconds', () => {
  const { a } = app({ candles: [bar(BASE, 100, 102, 99, 101)] });
  a.noteStaleQuote = () => {};
  assert.strictEqual(a.applyChartQuote({ ...tick(103, BASE + 60), timestamp: Math.floor(Date.now() / 1000) }), true);
  const oldSeconds = Math.floor((Date.now() - 190 * 24 * 3600 * 1000) / 1000);
  assert.strictEqual(a.applyChartQuote({ ...tick(999, BASE + 120), timestamp: oldSeconds }), false);
});

test('INT32 sentinel values are never charted', () => {
  // 2^31, and 2^31/100 for prices, are what the feed sends for a field it has no value for.
  const { a, updates } = app({ candles: [bar(BASE, 100, 102, 99, 101)] });
  a.noteStaleQuote = () => {};
  assert.strictEqual(a.applyChartQuote(tick(2 ** 31 / 100, BASE + 60)), false, 'sentinel LTP');
  assert.strictEqual(updates.length, 0);

  // A sentinel volume must not become the cumulative baseline: the bar keeps the volume it
  // already had rather than adopting 2^31 as its starting point.
  const before = a.chartCandles[0].volume;
  a.applyChartQuote({ ...tick(103, BASE + 60), volume: 2 ** 31 });
  assert.strictEqual(a.chartCandles[0].volume, before, 'sentinel volume ignored');
  assert.strictEqual(a.chartCandles[0]._volBase, undefined, 'no baseline taken from a sentinel');
  assert.strictEqual(a.chartCandles[0].close, 103, 'the price still updates');
});

test('nothing is applied before the chart exists', () => {
  const { a } = app({ candles: [] });
  a.candleSeries = null;
  assert.strictEqual(a.applyChartQuote(tick(100, BASE)), false);
  a.candleSeries = { update: () => {} };
  a.chartState = null;
  assert.strictEqual(a.applyChartQuote(tick(100, BASE)), false);
});
