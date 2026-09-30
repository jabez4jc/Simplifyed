/**
 * Timezone helpers standardized to Asia/Kolkata (IST).
 */

const IST_TIMEZONE = 'Asia/Kolkata';

/**
 * Convert a Date (or now) to a Date object representing IST local time.
 */
export function toISTDate(date = new Date()) {
  const istString = new Date(date).toLocaleString('en-US', { timeZone: IST_TIMEZONE });
  return new Date(istString);
}

/**
 * Return an ISO string adjusted to IST (useful for API payloads).
 */
export function toISTISOString(date = new Date()) {
  const d = toISTDate(date);
  const pad = (n) => String(n).padStart(2, '0');
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = pad(d.getSeconds());
  // IST offset is always +05:30 (no DST)
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}+05:30`;
}
