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

/**
 * SEBI requires retail algo orders on Indian exchanges (NSE, BSE, NFO, BFO, MCX, CDS, ...) to be
 * LIMIT orders. Crypto is outside that rule and Delta Exchange accepts MARKET orders. An empty
 * exchange counts as Indian: when in doubt, refuse MARKET.
 */
export function requiresLimitOrders(exchange) {
  return !isCryptoExchange(exchange);
}

/** Can this broker take a MARKET order on this exchange? Broker support alone is not enough. */
/** Indian futures & options segments - they take MIS or NRML, never CNC (delivery). */
const DERIVATIVE_EXCHANGES = new Set(['NFO', 'BFO', 'MCX', 'CDS', 'BCD', 'NCO']);

export function isDerivativeExchange(exchange) {
  return DERIVATIVE_EXCHANGES.has(String(exchange || '').toUpperCase());
}

export function marketOrderAllowed(brokerSupportsMarket, exchange) {
  return Boolean(brokerSupportsMarket) && !requiresLimitOrders(exchange);
}

