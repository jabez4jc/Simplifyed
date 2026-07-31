import assert from 'assert';
import test from 'node:test';
import { parseExpiry, upcomingExpiries } from '../../src/utils/underlying.util.js';

/**
 * Expiry parsing spans four exchanges with two formats. A parser that silently returns null for
 * a whole segment shows up as "no option contracts found", which reads like missing data rather
 * than a bug - so each format is pinned explicitly.
 */

test('DD-MMM-YY (NFO, BFO, MCX, CDS) parses', () => {
  assert.deepStrictEqual(parseExpiry('28-JUL-26'), new Date(Date.UTC(2026, 6, 28)));
  assert.deepStrictEqual(parseExpiry('23-OCT-26'), new Date(Date.UTC(2026, 9, 23)));
  assert.deepStrictEqual(parseExpiry('01-JAN-27'), new Date(Date.UTC(2027, 0, 1)));
  assert.deepStrictEqual(parseExpiry('31-dec-26'), new Date(Date.UTC(2026, 11, 31)), 'case-insensitive');
});

test('YYYY-MM-DD (CRYPTO) parses', () => {
  assert.deepStrictEqual(parseExpiry('2026-08-14'), new Date(Date.UTC(2026, 7, 14)));
  assert.deepStrictEqual(parseExpiry('2026-07-26'), new Date(Date.UTC(2026, 6, 26)));
});

test('absent or malformed expiries yield null, not a wrong date', () => {
  // Perpetual crypto futures legitimately have no expiry.
  for (const bad of ['', null, undefined, '  ', 'PERP', '28-XXX-26', '2026-13-40', '26-08-25']) {
    assert.strictEqual(parseExpiry(bad), null, `${JSON.stringify(bad)} must not parse`);
  }
});

test('upcomingExpiries sorts chronologically and drops the past', () => {
  const past = '01-JAN-20';
  const rows = [
    { expiry: '25-AUG-26' }, { expiry: past }, { expiry: '28-JUL-26' }, { expiry: '29-SEP-26' },
  ];
  const out = upcomingExpiries(rows);
  assert.ok(!out.includes(past), 'expired contracts must be dropped');
  // Lexical sorting would put 25-AUG before 28-JUL, which is wrong by date.
  assert.deepStrictEqual(out, ['28-JUL-26', '25-AUG-26', '29-SEP-26']);
});

test('mixed formats sort together correctly', () => {
  const out = upcomingExpiries([
    { expiry: '2026-09-01' }, { expiry: '28-JUL-26' }, { expiry: '2026-08-14' },
  ]);
  assert.deepStrictEqual(out, ['28-JUL-26', '2026-08-14', '2026-09-01']);
});

test('plain strings are accepted as well as rows', () => {
  assert.deepStrictEqual(upcomingExpiries(['29-SEP-26', '28-JUL-26']), ['28-JUL-26', '29-SEP-26']);
});

/**
 * Crypto expires daily at 5:30 PM IST, not at midnight - a same-day expiry has to stop being
 * offered mid-day, not run until the calendar date changes. A 15-minute buffer past 5:30 covers
 * the instrument sync job landing tomorrow's contract before today's is excluded, so the list is
 * never briefly empty at the exact moment of rollover.
 */
test('crypto\'s same-day expiry is dropped after 5:30 PM IST, not at midnight', () => {
  const rows = [{ expiry: '2026-07-27' }, { expiry: '2026-07-28' }];

  // 16:30 IST (11:00 UTC) - well before the cutoff, today's contract is still valid.
  const beforeCutoff = new Date(Date.UTC(2026, 6, 27, 11, 0, 0));
  assert.deepStrictEqual(upcomingExpiries(rows, beforeCutoff), ['2026-07-27', '2026-07-28']);

  // 17:35 IST (12:05 UTC) - past 5:30 but inside the 15-minute sync buffer, so today still holds.
  const insideBuffer = new Date(Date.UTC(2026, 6, 27, 12, 5, 0));
  assert.deepStrictEqual(upcomingExpiries(rows, insideBuffer), ['2026-07-27', '2026-07-28']);

  // 17:50 IST (12:20 UTC) - past 5:30 plus the buffer, today's contract rolls off.
  const pastBuffer = new Date(Date.UTC(2026, 6, 27, 12, 20, 0));
  assert.deepStrictEqual(upcomingExpiries(rows, pastBuffer), ['2026-07-28']);
});

test('a same-day NFO/MCX expiry stays valid all day - only crypto has an intraday cutoff', () => {
  const rows = [{ expiry: '27-JUL-26' }, { expiry: '28-JUL-26' }];
  const lateInTheDay = new Date(Date.UTC(2026, 6, 27, 18, 0, 0)); // 23:30 IST
  assert.deepStrictEqual(upcomingExpiries(rows, lateInTheDay), ['27-JUL-26', '28-JUL-26']);
});
