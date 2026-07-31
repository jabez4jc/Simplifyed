/**
 * Resolving a tradeable symbol to the key its OPTIONS are filed under, across NFO, BFO, MCX and
 * CRYPTO - and parsing the expiry formats those exchanges use.
 *
 * No single source is right for every segment, which is why this validates candidates instead
 * of picking one rule:
 *
 *   index     BANKNIFTY            instruments.underlying_key = BANKNIFTY   options: BANKNIFTY
 *   MCX fut   NATGASMINI28JUL26FUT instruments.underlying_key = NATGASMINI  options: NATGASMINI
 *   crypto    BTCUSDFUT            instruments.underlying_key = BTCUSDFUT   options: BTC
 *
 * The crypto perpetual is its own underlying_key, so following that column lands on a key with
 * no options at all. The watchlist row's `underlying_symbol` holds 'BTC' there - but on MCX the
 * same column holds a display name with spaces ("NATGASMINI 28 Jul 26 FUT"). Each candidate is
 * therefore checked against the instruments master, and the first one that actually has CE/PE
 * rows wins. Guessing silently returns an empty option chain, which looks like "no contracts"
 * rather than like a bug.
 */

import db from '../core/database.js';
import { toISTDate } from './time.js';

const MONTHS = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

/**
 * Parse an expiry into a UTC Date, or null.
 *
 * Two formats are in use and both must be handled:
 *   DD-MMM-YY    '23-OCT-26'   NFO, BFO, MCX, CDS
 *   YYYY-MM-DD   '2026-08-14'  CRYPTO
 * Perpetual crypto futures carry no expiry at all, which is correct and yields null.
 */
export function parseExpiry(raw) {
  const value = String(raw || '').trim().toUpperCase();
  if (!value) return null;

  const dmy = /^(\d{2})-([A-Z]{3})-(\d{2})$/.exec(value);
  if (dmy && dmy[2] in MONTHS) {
    const [day, mon, yy] = [Number(dmy[1]), MONTHS[dmy[2]], 2000 + Number(dmy[3])];
    const d = new Date(Date.UTC(yy, mon, day));
    // Same rollover guard: '32-JAN-26' would otherwise become 1 February.
    return d.getUTCMonth() === mon && d.getUTCDate() === day ? d : null;
  }

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (iso) {
    const [y, m, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    const d = new Date(Date.UTC(y, m - 1, day));
    // Date.UTC ROLLS OVER out-of-range parts rather than failing: (2026, 12, 40) silently
    // becomes 2027-02-09. A malformed feed value would then resolve to a real-looking expiry
    // and select the wrong contracts. Round-trip the components to reject it.
    const ok = d.getUTCFullYear() === y && d.getUTCMonth() === m - 1 && d.getUTCDate() === day;
    return ok ? d : null;
  }

  return null;
}

/** Crypto's daily options actually lapse at 5:30 PM IST, not at UTC/IST midnight. */
const CRYPTO_EXPIRY_CUTOFF_IST_MINUTES = 17 * 60 + 30;

/**
 * Extra time held past the 5:30 PM cutoff before today's crypto expiry is actually dropped from
 * the list. The next day's contract has to already be in the `instruments` table for the roll
 * to be usable, and that depends on when the instrument sync job last ran - rolling over the
 * instant the clock hits 5:30 exactly risks a window where TODAY's expiry has just been excluded
 * but TOMORROW's hasn't synced in yet, which would show as "no option contracts found" rather
 * than a wrong-but-present chain. Holding the old expiry a little longer is the safer failure.
 */
const CRYPTO_EXPIRY_SYNC_BUFFER_MINUTES = 15;

/** True for the YYYY-MM-DD format CRYPTO expiries use - the only segment with an intraday cutoff. */
const isCryptoExpiryFormat = (raw) => /^\d{4}-\d{2}-\d{2}$/.test(String(raw || '').trim());

/**
 * Sort expiries chronologically and drop anything before today. For CRYPTO's daily expiries,
 * "before today" means before 5:30 PM IST (plus the sync buffer above) rather than before
 * midnight - the other segments (NFO/BFO/MCX/CDS) settle at end of day, so a same-day expiry
 * stays valid for the whole day there.
 */
export function upcomingExpiries(rows, now = new Date()) {
  const today = new Date(now);
  today.setUTCHours(0, 0, 0, 0);

  // toISTDate's result carries IST wall-clock numbers through the LOCAL getters (it round-trips
  // through a timezone-less locale string) - the same convention every other caller in this
  // codebase uses (market-calendar.service.js, quick-order.service.js, ...). Reading it with the
  // UTC getters instead would silently reflect the server's own timezone, not IST.
  const ist = toISTDate(now);
  const istMinutesNow = ist.getHours() * 60 + ist.getMinutes();
  const cryptoTodayExpired = istMinutesNow >= CRYPTO_EXPIRY_CUTOFF_IST_MINUTES + CRYPTO_EXPIRY_SYNC_BUFFER_MINUTES;

  return rows
    .map((r) => {
      const raw = typeof r === 'string' ? r : r.expiry;
      return { raw, at: parseExpiry(raw), crypto: isCryptoExpiryFormat(raw) };
    })
    .filter((r) => {
      if (!r.at || r.at < today) return false;
      if (r.crypto && r.at.getTime() === today.getTime() && cryptoTodayExpired) return false;
      return true;
    })
    .sort((a, b) => a.at - b.at)
    .map((r) => r.raw);
}

/** Does this key have any option contracts? */
async function hasOptions(key) {
  if (!key) return false;
  const row = await db.get(
    `SELECT 1 AS ok FROM instruments
      WHERE UPPER(underlying_key) = ? AND instrumenttype IN ('CE','PE') LIMIT 1`,
    [key]
  );
  return Boolean(row);
}

/**
 * The key this symbol's options are filed under, or null when it has none.
 * @param {Object} symbolRow a watchlist_symbols row (needs symbol, exchange, underlying_symbol)
 */
export async function resolveOptionsUnderlyingKey(symbolRow) {
  if (!symbolRow) return null;

  const candidates = [];
  const push = (v) => {
    const k = String(v || '').trim().toUpperCase();
    // First token only: MCX stores "NATGASMINI 28 Jul 26 FUT" in underlying_symbol.
    const head = k.split(/\s+/)[0];
    if (head && !candidates.includes(head)) candidates.push(head);
  };

  // Configured underlying first - it is the only source that maps BTCUSDFUT to BTC.
  push(symbolRow.underlying_symbol);

  // Then whatever the instruments master says this exact contract belongs to. Right for an
  // index and for MCX futures; on a crypto perpetual it points back at itself, which the
  // hasOptions check below rejects.
  const inst = await db.get(
    'SELECT underlying_key FROM instruments WHERE UPPER(symbol) = ? AND UPPER(exchange) = ? LIMIT 1',
    [String(symbolRow.symbol || '').toUpperCase(), String(symbolRow.exchange || '').toUpperCase()]
  );
  push(inst?.underlying_key);

  push(symbolRow.symbol);

  for (const key of candidates) {
    if (await hasOptions(key)) return key;
  }
  return null;
}

/**
 * The lot size shared by every option on this underlying, or null when it is not one consistent
 * value. Verified consistent across NFO, BFO, MCX and CRYPTO at the time of writing; returning
 * null on ambiguity keeps the UI from stating a size it cannot stand behind.
 */
export async function resolveOptionLotSize(key) {
  if (!key) return null;
  const rows = await db.all(
    `SELECT DISTINCT lotsize FROM instruments
      WHERE UPPER(underlying_key) = ? AND instrumenttype IN ('CE','PE') AND lotsize > 0`,
    [key]
  );
  return rows.length === 1 ? Number(rows[0].lotsize) : null;
}

export default { parseExpiry, upcomingExpiries, resolveOptionsUnderlyingKey, resolveOptionLotSize };
