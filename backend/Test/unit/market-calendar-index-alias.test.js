import assert from 'assert';
import test from 'node:test';
import { mock } from 'node:test';

/**
 * Index segments trade under a real exchange's session, but OpenAlgo's market/timings and
 * market/holidays endpoints have never heard of NSE_INDEX or BSE_INDEX - they answer for NSE,
 * BSE, NFO, BFO, MCX, BCD, CDS, NCO, CRYPTO only.
 *
 * Before this fix, `isExchangeOpen('NSE_INDEX')` did an exact string match against the timings
 * table, never found an entry, and returned false UNCONDITIONALLY - at any time of day, on any
 * instance. `filterOpenSymbols` used that to build the WebSocket subscription list, so NIFTY
 * and BANKNIFTY were silently dropped from every subscription forever. Their quote snapshots
 * only ever got older, which is what a chart eventually renders as a gap-up followed by a flat
 * line: the last real price it ever received, held indefinitely.
 */

const NSE_WINDOW = { start_time: 1785123900000, end_time: 1785146400000, exchange: 'NSE' };
const MCX_WINDOW = { start_time: 1785123000000, end_time: 1785176700000, exchange: 'MCX' };

async function loadServiceWithTimings(timings, now) {
  mock.timers.enable({ apis: ['Date'], now });
  const mod = await import(`../../src/services/market-calendar.service.js?t=${Date.now()}_${Math.random()}`);
  const svc = mod.default;
  svc.getMarketTimings = async () => timings;
  svc.getMarketHolidays = async () => new Map();
  return svc;
}

test('NSE_INDEX resolves against the NSE session, not its own (nonexistent) entry', async () => {
  const svc = await loadServiceWithTimings([NSE_WINDOW, MCX_WINDOW], 1785130000000); // inside NSE window
  assert.strictEqual(await svc.isExchangeOpen('NSE'), true);
  assert.strictEqual(await svc.isExchangeOpen('NSE_INDEX'), true, 'NIFTY/BANKNIFTY must follow NSE hours');
  mock.timers.reset();
});

test('BSE_INDEX resolves against the BSE session', async () => {
  const svc = await loadServiceWithTimings(
    [{ start_time: 1785123900000, end_time: 1785146400000, exchange: 'BSE' }],
    1785130000000
  );
  assert.strictEqual(await svc.isExchangeOpen('BSE_INDEX'), true, 'SENSEX/BANKEX must follow BSE hours');
  mock.timers.reset();
});

test('an index segment closes when its underlying exchange closes', async () => {
  const svc = await loadServiceWithTimings([NSE_WINDOW], 1785150000000); // after NSE end_time
  assert.strictEqual(await svc.isExchangeOpen('NSE'), false);
  assert.strictEqual(await svc.isExchangeOpen('NSE_INDEX'), false);
  mock.timers.reset();
});

test('filterOpenSymbols keeps an index symbol under its OWN exchange label', async () => {
  const svc = await loadServiceWithTimings([NSE_WINDOW, MCX_WINDOW], 1785130000000);
  const out = await svc.filterOpenSymbols([
    { exchange: 'NSE_INDEX', symbol: 'NIFTY' },
    { exchange: 'MCX', symbol: 'NATGASMINI28JUL26FUT' },
    { exchange: 'BSE_INDEX', symbol: 'SENSEX' }, // no BSE entry in these timings - stays closed
  ]);
  const symbols = out.map((s) => s.symbol);
  assert.ok(symbols.includes('NIFTY'), 'NIFTY must survive the filter now that NSE is open');
  assert.ok(symbols.includes('NATGASMINI28JUL26FUT'));
  assert.ok(!symbols.includes('SENSEX'), 'an exchange with no session data must still be excluded');
  // The symbol keeps its real exchange label - only the OPEN CHECK is aliased.
  const nifty = out.find((s) => s.symbol === 'NIFTY');
  assert.strictEqual(nifty.exchange, 'NSE_INDEX');
  mock.timers.reset();
});

test('an exchange with no alias is unaffected', async () => {
  const svc = await loadServiceWithTimings([MCX_WINDOW], 1785130000000);
  assert.strictEqual(await svc.isExchangeOpen('MCX'), true);
  assert.strictEqual(await svc.isExchangeOpen('CRYPTO'), false, 'no CRYPTO entry in this fixture');
  mock.timers.reset();
});
