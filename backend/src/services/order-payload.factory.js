/**
 * Order Payload Factory
 * Builds normalized payloads for OpenAlgo placesmartorder calls.
 */

function basePayload({ strategy = 'default', exchange, symbol, action, quantity, position_size, product, pricetype = 'MARKET', price = 0, trigger_price = 0 }) {
  return {
    strategy,
    exchange,
    symbol,
    action,
    quantity,
    position_size,
    product,
    pricetype,
    price: price.toString(),
    trigger_price: trigger_price.toString(),
    disclosed_quantity: '0',
  };
}

export function buildEquityOrder(params) {
  return basePayload({ ...params });
}

export function buildFuturesOrder(params) {
  return basePayload({ ...params, product: params.product || 'NRML' });
}

export function buildOptionsOrder(params) {
  return basePayload({ ...params, product: params.product || 'NRML' });
}

export function buildExitOrder(params) {
  // position_size dictates the final open position; default to 0 only when not provided
  const resolvedPositionSize = params.position_size !== undefined ? params.position_size : 0;
  return basePayload({
    ...params,
    position_size: resolvedPositionSize,
    pricetype: params.pricetype || 'MARKET',
    price: params.price ?? 0,
  });
}

export default {
  buildEquityOrder,
  buildFuturesOrder,
  buildOptionsOrder,
  buildExitOrder,
};
