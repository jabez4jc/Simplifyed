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
