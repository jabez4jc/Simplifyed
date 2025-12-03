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

/**
 * Return a display-friendly date-time string in IST.
 */
export function formatIST(date = new Date(), options = {}) {
  const base = {
    timeZone: IST_TIMEZONE,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    ...options,
  };
  return new Date(date).toLocaleString('en-US', base);
}

export const IST = IST_TIMEZONE;
