/**
 * Shared order helpers: status normalisation, tick rounding, the live-position read and the
 * symbol-scoped cancel that order.service, order-placement, order-retry, the feed and the
 * quick-order history each used to carry their own copy of.
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

/** Broker status text -> one of complete | cancelled | rejected | trigger_pending | partial | open | pending | unknown. */
export function normalizeOrderStatus(status) {
  const value = (status ?? '').toString().trim().toLowerCase();
  if (['complete', 'completed', 'filled'].includes(value)) return 'complete';
  if (['cancelled', 'canceled'].includes(value)) return 'cancelled';
  if (value === 'rejected') return 'rejected';
  if (['trigger_pending', 'trigger pending'].includes(value)) return 'trigger_pending';
  if (['partial', 'partially_filled', 'partiallyfilled'].includes(value)) return 'partial';
  return value || 'unknown';
}

export const OPEN_ORDER_STATUSES = new Set(['open', 'pending', 'trigger_pending', 'partial']);

export function countDecimals(value) {
  const text = value.toString();
  const idx = text.indexOf('.');
  return idx === -1 ? 0 : Math.min(6, text.length - idx - 1);
}

/** Round onto the tick grid: BUY rounds up, anything else down. Two decimals when the tick is unknown. */
export function roundToTick(price, tickSize, side) {
  const tick = typeof tickSize === 'string' ? parseFloat(tickSize) : tickSize;
  if (!Number.isFinite(tick) || tick <= 0) return Number(price.toFixed(2));
  const ticks = price / tick;
  const roundedTicks = String(side || '').toUpperCase() === 'BUY' ? Math.ceil(ticks - 1e-9) : Math.floor(ticks + 1e-9);
  return Number((roundedTicks * tick).toFixed(countDecimals(tick)));
}

/** Nearest whole tick; 0 stays 0 (no price / no trigger). Two decimals when the tick is unknown. */
export function roundToNearestTick(value, tick) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return n;
  if (!Number.isFinite(tick) || tick <= 0) return Number(n.toFixed(2));
  return Number((Math.round(n / tick) * tick).toFixed(countDecimals(tick)));
}

/** Base price +/- (points, else pct of base) buffer for the side, rounded onto the tick grid. */
export function applyBufferAndTick({ ltp, basePrice = null, side, bufferPoints, bufferPct, tickSize }) {
  const priceBase = Number.isFinite(basePrice) && basePrice > 0 ? basePrice : ltp;
  let buffer = Number(bufferPoints) || 0;
  if ((!buffer || buffer <= 0) && Number.isFinite(bufferPct) && bufferPct > 0) {
    buffer = priceBase * (bufferPct / 100);
  }
  let price = String(side || '').toUpperCase() === 'BUY' ? priceBase + buffer : priceBase - buffer;
  if (!Number.isFinite(price) || price <= 0) price = priceBase;
  return roundToTick(price, tickSize, side);
}

/**
 * Cancel this instance's OPEN orders for ONE symbol/exchange(/product) out of `orders` (an
 * orderbook). Never an account-wide cancel (C3). Each failure is logged and skipped.
 */
export async function cancelOpenOrdersForSymbol(instance, orders, payload, strategy) {
  if (!instance?.id || !Array.isArray(orders) || !payload?.symbol || !payload?.exchange) return;

  const targetSymbol = normalizeSymbolKey(payload.symbol);
  const targetExchange = normalizeExchange(payload.exchange);
  const targetProduct = normalizeProduct(payload.product);

  const toCancel = [];
  for (const order of orders) {
    const symbol = normalizeSymbolKey(order.symbol || order.tradingsymbol || order.trading_symbol);
    const exchange = normalizeExchange(order.exchange || order.exch || order.brexchange);
    const product = normalizeProduct(order.product || order.producttype);
    if (symbol !== targetSymbol || exchange !== targetExchange) continue;
    if (targetProduct && product && product !== targetProduct) continue;
    if (!OPEN_ORDER_STATUSES.has(normalizeOrderStatus(order.order_status || order.status))) continue;
    const id = order.orderid || order.order_id || order.id;
    if (id) toCancel.push(id);
  }

  const strategyTag = strategy || payload.strategy || 'default';
  for (const orderId of toCancel) {
    try {
      await openalgoClient.cancelOrder(instance, orderId, strategyTag);
    } catch (error) {
      log.warn('Failed to cancel open order', { instance_id: instance.id, order_id: orderId, error: error.message });
    }
  }
}
