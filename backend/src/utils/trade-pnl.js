/**
 * Tradebook P&L helpers
 * Computes net P&L from trade values minus per-trade charges.
 */

import { parseFloatSafe } from './sanitizers.js';
import { normalizeTradebookEntry } from './tradebook-utils.js';

function resolveSide(normalized = {}) {
  const action = String(normalized.action || '').toUpperCase();
  if (action === 'BUY' || action === 'SELL') return action;
  return null;
}

function normalizeOrderId(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function isAppTrade(normalized = {}, { appOrderIds, strategyTag } = {}) {
  const orderId = normalizeOrderId(normalized.order_id || normalized?.metadata?.orderid || normalized?.metadata?.order_id);
  if (orderId && appOrderIds && appOrderIds.has(orderId)) return true;

  if (strategyTag) {
    const normalizedStrategy = String(strategyTag || '').trim().toUpperCase();
    const tradeStrategy = String(
      normalized.strategy || normalized?.metadata?.strategy || normalized?.metadata?.strategy_tag || ''
    )
      .trim()
      .toUpperCase();
    if (normalizedStrategy && tradeStrategy && tradeStrategy === normalizedStrategy) return true;
  }

  return false;
}

export function calculateTradeChargesOpenAlgo(
  tradeValue,
  {
    exchange = '',
    symbol = '',
    side = 'BUY',
    brokerage = 0,
  } = {}
) {
  const exchangeUpper = String(exchange || '').toUpperCase();
  const symbolUpper = String(symbol || '').toUpperCase();
  const sideUpper = String(side || '').toUpperCase();

  const isOption = /(CE|PE)$/.test(symbolUpper) || /(CE|PE)/.test(symbolUpper);
  const isFuture = symbolUpper.endsWith('FUT');

  let exchangeFeeRate = 0;
  let stampDutyRate = 0;

  if (exchangeUpper === 'NFO') {
    exchangeFeeRate = isOption ? 0.0005 : 0.00019;
    stampDutyRate = isOption ? 0.00003 : 0.00002;
  } else if (exchangeUpper === 'MCX') {
    exchangeFeeRate = isOption ? 0.00005 : 0.000026;
    stampDutyRate = isOption ? 0.00003 : 0.00002;
  } else if (exchangeUpper === 'CDS' || exchangeUpper === 'BCD') {
    exchangeFeeRate = 0.00002;
    stampDutyRate = 0.00003;
  }

  const tradeVal = parseFloatSafe(tradeValue, 0);
  const brokerageVal = parseFloatSafe(brokerage, 0);

  const exchangeFee = exchangeFeeRate * tradeVal;
  const sebiFee = 0.000001 * tradeVal;
  const stampDuty = sideUpper === 'BUY' ? stampDutyRate * tradeVal : 0;
  const gst = 0.18 * (brokerageVal + exchangeFee);
  const total = brokerageVal + exchangeFee + sebiFee + stampDuty + gst;

  return {
    instrument_type: isOption ? 'OPTION' : isFuture ? 'FUTURE' : 'UNKNOWN',
    brokerage: Number(brokerageVal.toFixed(2)),
    exchange_fee: Number(exchangeFee.toFixed(2)),
    sebi_fee: Number(sebiFee.toFixed(4)),
    stamp_duty: Number(stampDuty.toFixed(2)),
    gst: Number(gst.toFixed(2)),
    total_cost: Number(total.toFixed(2)),
  };
}

export function calculateTradebookPnL(trades = [], options = {}) {
  const {
    exchangeFallback = '',
    symbolFallback = '',
    brokerageValue = 0,
  } = options;

  let buyValue = 0;
  let sellValue = 0;
  let chargesTotal = 0;
  let buyCount = 0;
  let sellCount = 0;

  trades.forEach((trade) => {
    const normalized = normalizeTradebookEntry(trade);
    const side = resolveSide(normalized);
    if (!side) return;

    const tradeValue = Math.abs(parseFloatSafe(normalized.trade_value, 0));
    if (!tradeValue) return;

    if (side === 'BUY') {
      buyValue += tradeValue;
      buyCount += 1;
    } else {
      sellValue += tradeValue;
      sellCount += 1;
    }

    const exchange = normalized.exchange || trade.exchange || exchangeFallback;
    const symbol = normalized.symbol || trade.symbol || symbolFallback;
    const charges = calculateTradeChargesOpenAlgo(tradeValue, {
      exchange,
      symbol,
      side,
      brokerage: brokerageValue,
    });
    chargesTotal += charges.total_cost;
  });

  const grossPnl = sellValue - buyValue;
  const netPnl = grossPnl - chargesTotal;

  return {
    buy_count: buyCount,
    sell_count: sellCount,
    buy_value: buyValue,
    sell_value: sellValue,
    gross_pnl: grossPnl,
    charges_total: chargesTotal,
    net_pnl: netPnl,
  };
}

export function calculateTradebookPnLForAppExits(trades = [], options = {}) {
  const {
    exchangeFallback = '',
    symbolFallback = '',
    brokerageValue = 0,
    appOrderIds = null,
    strategyTag = null,
  } = options;

  if (!Array.isArray(trades) || trades.length === 0) {
    return {
      buy_count: 0,
      sell_count: 0,
      buy_value: 0,
      sell_value: 0,
      gross_pnl: 0,
      charges_total: 0,
      net_pnl: 0,
    };
  }

  const normalizedTrades = trades
    .map((trade) => normalizeTradebookEntry(trade))
    .filter((trade) => resolveSide(trade));

  // Sort trades by time to preserve FIFO matching
  normalizedTrades.sort((a, b) => {
    const timeA = Number.isFinite(a.timestamp_epoch) ? a.timestamp_epoch : 0;
    const timeB = Number.isFinite(b.timestamp_epoch) ? b.timestamp_epoch : 0;
    return timeA - timeB;
  });

  // FIFO matching must happen per instrument - a BUY of one symbol can never close a SELL of a
  // different one. Queues keyed by exchange+symbol; previously these were two flat arrays shared
  // across every symbol in the tradebook, so unrelated instruments got matched against each other
  // (e.g. a NIFTY option buy "closing" a NATGAS option sell), producing meaningless P&L.
  const queuesBySymbol = new Map();
  const getQueues = (exchange, symbol) => {
    const key = `${(exchange || '').toUpperCase()}|${(symbol || '').toUpperCase()}`;
    if (!queuesBySymbol.has(key)) {
      queuesBySymbol.set(key, { buyQueue: [], sellQueue: [] });
    }
    return queuesBySymbol.get(key);
  };

  let buyValue = 0;
  let sellValue = 0;
  let chargesTotal = 0;
  let buyCount = 0;
  let sellCount = 0;

  for (const trade of normalizedTrades) {
    const side = resolveSide(trade);
    let remainingQty = Math.abs(parseFloatSafe(trade.quantity, 0));
    const price = parseFloatSafe(trade.average_price, 0);
    if (!side || remainingQty <= 0 || price <= 0) continue;

    const { buyQueue, sellQueue } = getQueues(trade.exchange || exchangeFallback, trade.symbol || symbolFallback);
    const isAppExit = isAppTrade(trade, { appOrderIds, strategyTag });
    let closeCounted = false;

    if (side === 'BUY') {
      while (remainingQty > 0 && sellQueue.length > 0) {
        const open = sellQueue[0];
        const matchQty = Math.min(remainingQty, open.quantity);
        remainingQty -= matchQty;
        open.quantity -= matchQty;

        if (isAppExit) {
          const buyTradeValue = matchQty * price;
          const sellTradeValue = matchQty * open.price;
          buyValue += buyTradeValue;
          sellValue += sellTradeValue;

          const buyCharges = calculateTradeChargesOpenAlgo(buyTradeValue, {
            exchange: trade.exchange || exchangeFallback,
            symbol: trade.symbol || symbolFallback,
            side: 'BUY',
            brokerage: brokerageValue,
          });
          const sellCharges = calculateTradeChargesOpenAlgo(sellTradeValue, {
            exchange: open.exchange || exchangeFallback,
            symbol: open.symbol || symbolFallback,
            side: 'SELL',
            brokerage: brokerageValue,
          });
          chargesTotal += buyCharges.total_cost + sellCharges.total_cost;

          if (!closeCounted) {
            buyCount += 1;
            closeCounted = true;
          }
          if (!open.counted) {
            sellCount += 1;
            open.counted = true;
          }
        }

        if (open.quantity <= 0) {
          sellQueue.shift();
        }
      }

      if (remainingQty > 0) {
        buyQueue.push({
          quantity: remainingQty,
          price,
          exchange: trade.exchange || exchangeFallback,
          symbol: trade.symbol || symbolFallback,
          counted: false,
        });
      }
    } else {
      while (remainingQty > 0 && buyQueue.length > 0) {
        const open = buyQueue[0];
        const matchQty = Math.min(remainingQty, open.quantity);
        remainingQty -= matchQty;
        open.quantity -= matchQty;

        if (isAppExit) {
          const buyTradeValue = matchQty * open.price;
          const sellTradeValue = matchQty * price;
          buyValue += buyTradeValue;
          sellValue += sellTradeValue;

          const buyCharges = calculateTradeChargesOpenAlgo(buyTradeValue, {
            exchange: open.exchange || exchangeFallback,
            symbol: open.symbol || symbolFallback,
            side: 'BUY',
            brokerage: brokerageValue,
          });
          const sellCharges = calculateTradeChargesOpenAlgo(sellTradeValue, {
            exchange: trade.exchange || exchangeFallback,
            symbol: trade.symbol || symbolFallback,
            side: 'SELL',
            brokerage: brokerageValue,
          });
          chargesTotal += buyCharges.total_cost + sellCharges.total_cost;

          if (!closeCounted) {
            sellCount += 1;
            closeCounted = true;
          }
          if (!open.counted) {
            buyCount += 1;
            open.counted = true;
          }
        }

        if (open.quantity <= 0) {
          buyQueue.shift();
        }
      }

      if (remainingQty > 0) {
        sellQueue.push({
          quantity: remainingQty,
          price,
          exchange: trade.exchange || exchangeFallback,
          symbol: trade.symbol || symbolFallback,
          counted: false,
        });
      }
    }
  }

  const grossPnl = sellValue - buyValue;
  const netPnl = grossPnl - chargesTotal;

  return {
    buy_count: buyCount,
    sell_count: sellCount,
    buy_value: buyValue,
    sell_value: sellValue,
    gross_pnl: grossPnl,
    charges_total: chargesTotal,
    net_pnl: netPnl,
  };
}

export function calculateTradebookPnLClosedOnly(trades = [], options = {}) {
  const {
    exchangeFallback = '',
    symbolFallback = '',
    brokerageValue = 0,
  } = options;

  if (!Array.isArray(trades) || trades.length === 0) {
    return {
      buy_count: 0,
      sell_count: 0,
      buy_value: 0,
      sell_value: 0,
      gross_pnl: 0,
      charges_total: 0,
      net_pnl: 0,
    };
  }

  const normalizedTrades = trades
    .map((trade) => normalizeTradebookEntry(trade))
    .filter((trade) => resolveSide(trade));

  normalizedTrades.sort((a, b) => {
    const timeA = Number.isFinite(a.timestamp_epoch) ? a.timestamp_epoch : 0;
    const timeB = Number.isFinite(b.timestamp_epoch) ? b.timestamp_epoch : 0;
    return timeA - timeB;
  });

  // Same fix as calculateTradebookPnLForAppExits - FIFO queues must be scoped per instrument, not
  // shared globally across every symbol in the tradebook.
  const queuesBySymbol = new Map();
  const getQueues = (exchange, symbol) => {
    const key = `${(exchange || '').toUpperCase()}|${(symbol || '').toUpperCase()}`;
    if (!queuesBySymbol.has(key)) {
      queuesBySymbol.set(key, { buyQueue: [], sellQueue: [] });
    }
    return queuesBySymbol.get(key);
  };

  let buyValue = 0;
  let sellValue = 0;
  let chargesTotal = 0;
  let buyCount = 0;
  let sellCount = 0;

  for (const trade of normalizedTrades) {
    const side = resolveSide(trade);
    let remainingQty = Math.abs(parseFloatSafe(trade.quantity, 0));
    const price = parseFloatSafe(trade.average_price, 0);
    if (!side || remainingQty <= 0 || price <= 0) continue;

    const { buyQueue, sellQueue } = getQueues(trade.exchange || exchangeFallback, trade.symbol || symbolFallback);
    let closeCounted = false;

    if (side === 'BUY') {
      while (remainingQty > 0 && sellQueue.length > 0) {
        const open = sellQueue[0];
        const matchQty = Math.min(remainingQty, open.quantity);
        remainingQty -= matchQty;
        open.quantity -= matchQty;

        const buyTradeValue = matchQty * price;
        const sellTradeValue = matchQty * open.price;
        buyValue += buyTradeValue;
        sellValue += sellTradeValue;

        const buyCharges = calculateTradeChargesOpenAlgo(buyTradeValue, {
          exchange: trade.exchange || exchangeFallback,
          symbol: trade.symbol || symbolFallback,
          side: 'BUY',
          brokerage: brokerageValue,
        });
        const sellCharges = calculateTradeChargesOpenAlgo(sellTradeValue, {
          exchange: open.exchange || exchangeFallback,
          symbol: open.symbol || symbolFallback,
          side: 'SELL',
          brokerage: brokerageValue,
        });
        chargesTotal += buyCharges.total_cost + sellCharges.total_cost;

        if (!closeCounted) {
          buyCount += 1;
          closeCounted = true;
        }
        if (!open.counted) {
          sellCount += 1;
          open.counted = true;
        }

        if (open.quantity <= 0) {
          sellQueue.shift();
        }
      }

      if (remainingQty > 0) {
        buyQueue.push({
          quantity: remainingQty,
          price,
          exchange: trade.exchange || exchangeFallback,
          symbol: trade.symbol || symbolFallback,
          counted: false,
        });
      }
    } else {
      while (remainingQty > 0 && buyQueue.length > 0) {
        const open = buyQueue[0];
        const matchQty = Math.min(remainingQty, open.quantity);
        remainingQty -= matchQty;
        open.quantity -= matchQty;

        const buyTradeValue = matchQty * open.price;
        const sellTradeValue = matchQty * price;
        buyValue += buyTradeValue;
        sellValue += sellTradeValue;

        const buyCharges = calculateTradeChargesOpenAlgo(buyTradeValue, {
          exchange: open.exchange || exchangeFallback,
          symbol: open.symbol || symbolFallback,
          side: 'BUY',
          brokerage: brokerageValue,
        });
        const sellCharges = calculateTradeChargesOpenAlgo(sellTradeValue, {
          exchange: trade.exchange || exchangeFallback,
          symbol: trade.symbol || symbolFallback,
          side: 'SELL',
          brokerage: brokerageValue,
        });
        chargesTotal += buyCharges.total_cost + sellCharges.total_cost;

        if (!closeCounted) {
          sellCount += 1;
          closeCounted = true;
        }
        if (!open.counted) {
          buyCount += 1;
          open.counted = true;
        }

        if (open.quantity <= 0) {
          buyQueue.shift();
        }
      }

      if (remainingQty > 0) {
        sellQueue.push({
          quantity: remainingQty,
          price,
          exchange: trade.exchange || exchangeFallback,
          symbol: trade.symbol || symbolFallback,
          counted: false,
        });
      }
    }
  }

  const grossPnl = sellValue - buyValue;
  const netPnl = grossPnl - chargesTotal;

  return {
    buy_count: buyCount,
    sell_count: sellCount,
    buy_value: buyValue,
    sell_value: sellValue,
    gross_pnl: grossPnl,
    charges_total: chargesTotal,
    net_pnl: netPnl,
  };
}
