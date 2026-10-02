import assert from 'assert';
import test from 'node:test';

import { parseExpiry, toISO, toDisplay, toBroker, sameExpiry } from '../../src/utils/expiry.js';

// The one expiry module (P3-5): every format in, one format per output.
const SAME_DAY = ['2026-10-27', '27-OCT-26', '27OCT26', '27-oct-26'];

test('every format parses to the same day', () => {
  for (const raw of SAME_DAY) assert.strictEqual(parseExpiry(raw)?.toISOString(), '2026-10-27T00:00:00.000Z', raw);
});

test('toISO, toDisplay and toBroker each write exactly one format', () => {
  for (const raw of SAME_DAY) {
    assert.strictEqual(toISO(raw), '2026-10-27');
    assert.strictEqual(toDisplay(raw), '27-OCT-26');
    assert.strictEqual(toBroker(raw), '27OCT26');
  }
});

test('nonsense is rejected, never rolled over into a real-looking date', () => {
  for (const raw of ['32-JAN-26', '2026-13-01', '2026-02-30', '31FEB26', '27-XYZ-26', '27-OCT-2026', 'abc', '', null, undefined]) {
    assert.strictEqual(parseExpiry(raw), null, String(raw));
    assert.strictEqual(toISO(raw), null);
    assert.strictEqual(toDisplay(raw), null);
  }
});

test('toBroker passes through what it cannot read, for the broker to refuse', () => {
  assert.strictEqual(toBroker(' next friday '), 'NEXT FRIDAY');
  assert.strictEqual(toBroker(null), '');
});

test('sameExpiry compares days across formats', () => {
  assert.ok(sameExpiry('2026-10-27', '27OCT26'));
  assert.ok(!sameExpiry('2026-10-27', '28OCT26'));
  assert.ok(!sameExpiry('2026-10-27', null), 'an unreadable side is never equal');
  assert.ok(!sameExpiry(null, null));
});

test('callers that used their own parsers now agree', async () => {
  const { expiryMatchesSymbol, normalizeExpiryInput, parseFuturesSymbol, parseOptionSymbol } = await import('../../src/utils/symbol-parsing.util.js');
  assert.ok(expiryMatchesSymbol('2026-10-27', { symbol: 'NATGASMINI27OCT26FUT' }));
  assert.ok(expiryMatchesSymbol('27-OCT-26', { symbol: 'X', expiry: '2026-10-27' }));
  assert.ok(!expiryMatchesSymbol('28-OCT-26', { symbol: 'NATGASMINI27OCT26FUT' }));
  assert.strictEqual(normalizeExpiryInput('27-OCT-26'), '2026-10-27');
  assert.strictEqual(normalizeExpiryInput(' garbage '), 'GARBAGE');
  assert.deepStrictEqual(parseFuturesSymbol('MCX:NATGASMINI27OCT26FUT'), { underlying: 'NATGASMINI', expiry: '2026-10-27' });
  assert.strictEqual(parseOptionSymbol('NIFTY27OCT2622400CE').expiry, '2026-10-27');
  assert.strictEqual(parseOptionSymbol('NIFTY27XYZ2622400CE').expiry, null, 'an unknown month is no longer read as January');
});
