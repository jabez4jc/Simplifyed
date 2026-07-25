/**
 * Brokers that trade crypto 24/7 rather than on Indian exchange hours.
 * Add new crypto broker slugs here as they're integrated.
 */
const CRYPTO_BROKERS = new Set(['deltaexchange']);

export function isCryptoBroker(broker) {
  return CRYPTO_BROKERS.has((broker || '').toLowerCase());
}

/** True for the crypto exchange segment itself (trades 24/7, no Indian market hours). */
export function isCryptoExchange(exchange) {
  return (exchange || '').toUpperCase() === 'CRYPTO';
}

export { CRYPTO_BROKERS };
