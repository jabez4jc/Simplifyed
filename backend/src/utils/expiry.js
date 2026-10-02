/**
 * The one place expiry strings are parsed and formatted (audit P3-5).
 *
 * Formats in play:
 *   YYYY-MM-DD  '2026-10-27'  instruments.expiry (stored), CRYPTO feeds
 *   DD-MMM-YY   '27-OCT-26'   watchlist rows and the UI
 *   DDMMMYY     '27OCT26'     what OpenAlgo's /optionchain accepts, and what contract symbols embed
 * Everything is parsed from any of the three; each toX() writes exactly one.
 */

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/**
 * Parse an expiry into a UTC Date, or null. Perpetual crypto futures carry no expiry, which is
 * correct and yields null. An out-of-range day or month is rejected rather than rolled over.
 */
export function parseExpiry(raw) {
  const value = String(raw || '').trim().toUpperCase();
  if (!value) return null;

  let y;
  let m;
  let day;
  const dmy = /^(\d{2})-?([A-Z]{3})-?(\d{2})$/.exec(value);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dmy && MONTHS.includes(dmy[2])) {
    [day, m, y] = [Number(dmy[1]), MONTHS.indexOf(dmy[2]), 2000 + Number(dmy[3])];
  } else if (iso) {
    [y, m, day] = [Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])];
  } else {
    return null;
  }

  // Date.UTC ROLLS OVER out-of-range parts rather than failing: (2026, 12, 40) silently becomes
  // 2027-02-09, and '32-JAN-26' becomes 1 February. A malformed feed value would then resolve to
  // a real-looking expiry and select the wrong contracts. Round-trip the parts to reject it.
  const d = new Date(Date.UTC(y, m, day));
  return d.getUTCFullYear() === y && d.getUTCMonth() === m && d.getUTCDate() === day ? d : null;
}

/** 'YYYY-MM-DD', or null when it does not parse. */
export function toISO(raw) {
  const d = parseExpiry(raw);
  return d ? d.toISOString().slice(0, 10) : null;
}

const dayMonthYear = (d, sep) => (
  `${String(d.getUTCDate()).padStart(2, '0')}${sep}${MONTHS[d.getUTCMonth()]}${sep}${String(d.getUTCFullYear()).slice(-2)}`
);

/** 'DD-MMM-YY', or null when it does not parse. */
export function toDisplay(raw) {
  const d = parseExpiry(raw);
  return d ? dayMonthYear(d, '-') : null;
}

/**
 * 'DDMMMYY' - OpenAlgo's /optionchain matches `expiry_date` only in this form (verified live on
 * 30 Sep 2026: '2026-09-30' and '30-SEP-26' both answer "No strikes found"). Something that does
 * not parse is passed through upper-cased, for the broker to refuse.
 */
export function toBroker(raw) {
  const d = parseExpiry(raw);
  return d ? dayMonthYear(d, '') : String(raw || '').trim().toUpperCase();
}

/** Do two expiries, in any formats, name the same day? */
export function sameExpiry(a, b) {
  const x = parseExpiry(a);
  const y = parseExpiry(b);
  return Boolean(x && y && x.getTime() === y.getTime());
}
