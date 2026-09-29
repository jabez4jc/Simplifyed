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

test('isInstanceMarketOpen gates background polling: closed after MCX, crypto always open, unknown calendar fails open', async () => {
  const svc = await loadServiceWithTimings([NSE_WINDOW, MCX_WINDOW], 1785180000000); // after MCX end_time
  const indian = { broker: 'fyers' };
  assert.strictEqual(await svc.isInstanceMarketOpen(indian), true, 'no timings loaded yet - fail open');
  svc.timingsCache.set(svc._formatDate(), { data: [], fetchedAt: Date.now() });
  assert.strictEqual(await svc.isInstanceMarketOpen(indian), false, 'every Indian exchange closed');
  assert.strictEqual(await svc.isInstanceMarketOpen({ broker: 'deltaexchange' }), true);
  mock.timers.reset();
});

/**
 * A trading holiday where MCX runs only its evening session (e.g. Dussehra, 20 Oct 2026): NSE,
 * BSE, NFO and BFO are shut all day, MCX opens at 17:00. Index F&O must read closed all day,
 * MCX F&O closed in the morning and open in the evening, and crypto open throughout.
 */
test('MCX evening session on a trading holiday: index F&O closed, MCX F&O evening only, crypto open', async () => {
  const at = (hhmm) => new Date(`2026-10-20T${hhmm}:00+05:30`).getTime();
  const svc = await loadServiceWithTimings([], at('11:00'));
  svc.getMarketHolidays = async () => new Map([['2026-10-20', {
    date: '2026-10-20',
    holiday_type: 'TRADING_HOLIDAY',
    closedExchanges: new Set(['NSE', 'BSE', 'NFO', 'BFO', 'CDS']),
    openExchanges: new Map([['MCX', { start: at('17:00'), end: at('23:55') }]]),
  }]]);
  svc.timingsCache.set('2026-10-20', { data: [], fetchedAt: Date.now() });
  const indian = { broker: 'kotak' };
  const crypto = { broker: 'deltaexchange' };

  for (const ex of ['NFO', 'BFO', 'NSE_INDEX', 'BSE_INDEX', 'MCX']) {
    assert.strictEqual(await svc.isExchangeOpen(ex), false, `${ex} is shut at 11:00 on the holiday`);
  }
  assert.strictEqual(await svc.isInstanceMarketOpen(indian), false, 'no Indian session at 11:00 - no polling');
  assert.strictEqual(await svc.isInstanceMarketOpen(crypto), true);

  mock.timers.setTime(at('18:30'));
  assert.strictEqual(await svc.isExchangeOpen('MCX'), true, 'MCX evening session');
  assert.strictEqual(await svc.isExchangeOpen('NFO'), false, 'index F&O stays shut in the evening');
  assert.strictEqual(await svc.isInstanceMarketOpen(indian), true, 'MCX positions need polling in the evening');
  mock.timers.reset();
});

test('an ordinary day: NFO/BFO close with the equity session, MCX runs to 23:55', async () => {
  const at = (hhmm) => new Date(`2026-10-21T${hhmm}:00+05:30`).getTime();
  const window = (exchange, from, to) => ({ exchange, start_time: at(from), end_time: at(to) });
  const svc = await loadServiceWithTimings(
    [window('NFO', '09:15', '15:30'), window('BFO', '09:15', '15:30'), window('MCX', '09:00', '23:55')],
    at('15:45')
  );
  assert.strictEqual(await svc.isExchangeOpen('NFO'), false);
  assert.strictEqual(await svc.isExchangeOpen('BFO'), false);
  assert.strictEqual(await svc.isExchangeOpen('MCX'), true);
  mock.timers.setTime(at('23:56'));
  assert.strictEqual(await svc.isExchangeOpen('MCX'), false, 'MCX closes at 23:55');
  mock.timers.reset();
});
