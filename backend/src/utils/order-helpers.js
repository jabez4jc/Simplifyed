/**
 * Shared order helpers (P3-6 will grow this file; today it holds the live-position read that
 * order.service and order-retry.service each used to carry a copy of).
 */
import { log } from '../core/logger.js';
import openalgoClient from '../integrations/openalgo/client.js';
import { normalizeSymbolKey, normalizeExchange, normalizeProduct } from './symbol-parsing.util.js';

export function extractPositionQty(position) {
  const candidates = [position.quantity, position.netqty, position.net_quantity, position.net, position.netQty];
  for (const value of candidates) {
    const num = typeof value === 'string' ? parseFloat(value) : value;
    if (Number.isFinite(num)) return num;
  }
  return 0;
}

/**
 * Net quantity this instance holds in params' symbol/exchange(/product).
 * An empty positionbook is a valid FLAT account -> 0. Returns null only when the read failed
 * (or the arguments are unusable), so callers can refuse to size an order off an unknown position.
 */
export async function getLivePosition(instance, params) {
  if (!instance?.id || !params?.symbol || !params?.exchange) return null;
  let positions;
  try {
    positions = await openalgoClient.getPositionBook(instance);
  } catch (error) {
    log.warn('Live positionbook fetch failed', { instance_id: instance.id, error: error.message });
    return null;
  }
  if (!Array.isArray(positions)) return null;

  const targetSymbol = normalizeSymbolKey(params.symbol);
  const targetExchange = normalizeExchange(params.exchange);
  const targetProduct = normalizeProduct(params.product);

  for (const position of positions) {
    const symbol = normalizeSymbolKey(position.symbol || position.tradingsymbol || position.trading_symbol);
    const exchange = normalizeExchange(position.exchange || position.exch || position.brexchange);
    const product = normalizeProduct(position.product || position.producttype);
    if (symbol !== targetSymbol || exchange !== targetExchange) continue;
    if (targetProduct && product && product !== targetProduct) continue;
    return extractPositionQty(position);
  }
  return 0;
}
