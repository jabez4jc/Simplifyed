/**
 * Tradebook Utilities
 * Shared helpers for normalizing trade responses from OpenAlgo.
 */

import { toISTISOString } from './time.js';
import { normalizeSymbolKey, normalizeExchange } from './symbol-parsing.util.js';

function parseTradeTimestamp(raw) {
  if (!raw) return null;
  const value = String(raw).trim();

  // Format: HH:MM:SS DD-MM-YYYY or HH:MM:SS DD/MM/YYYY
  const timeFirstMatch = value.match(
    /^(\d{2}):(\d{2}):(\d{2})\s+(\d{2})[-/](\d{2})[-/](\d{4})$/
  );
  if (timeFirstMatch) {
    const [, hh, mm, ss, dd, month, yyyy] = timeFirstMatch;
    const date = new Date(
      Number(yyyy),
      Number(month) - 1,
      Number(dd),
      Number(hh),
      Number(mm),
      Number(ss)
    );
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }

  const fallback = new Date(value);
  if (!Number.isNaN(fallback.getTime())) {
    return fallback;
  }

  return null;
}

export function normalizeTradebookEntry(trade = {}) {
  const actionSource = trade.action || trade.side || '';
  const action = String(actionSource || '').trim().toUpperCase();

  const symbol = trade.symbol || trade.tradingsymbol || trade.trading_symbol;
  const exchange = trade.exchange || trade.exch || trade.exchange_name;
  const orderId = trade.orderid || trade.order_id || trade.orderId || null;
  const strategy = trade.strategy || trade.strategy_tag || trade.algo_strategy || null;

  const quantity = Number(trade.quantity ?? trade.qty ?? 0) || 0;
  const priceValue = Number(trade.average_price ?? trade.price ?? trade.avg_price ?? 0) || 0;
  const timestampRaw = trade.timestamp || trade.trade_time || trade.placed_at || trade.executed_at;
  const parsedTimestamp = parseTradeTimestamp(timestampRaw);
  const timestampEpoch = parsedTimestamp ? parsedTimestamp.getTime() : null;

  const tradeValue = Number(trade.trade_value ?? trade.value ?? quantity * priceValue) || 0;

  return {
    symbol,
    exchange,
    order_id: orderId,
    strategy,
    action,
    quantity,
    average_price: priceValue,
    trade_value: tradeValue,
    timestamp: timestampRaw,
    timestamp_iso: parsedTimestamp ? toISTISOString(parsedTimestamp) : null,
    timestamp_epoch: timestampEpoch,
    metadata: trade,
  };
}

/** Normalised tradebook rows that can price an entry (symbol, exchange, qty and a BUY/SELL side). */
export function prepareTradebook(trades = []) {
  if (!Array.isArray(trades) || trades.length === 0) return [];
  return trades
    .map(normalizeTradebookEntry)
    .filter((trade) => trade.symbol && trade.exchange && trade.quantity > 0
      && (trade.action === 'BUY' || trade.action === 'SELL'));
}

/**
 * Entry price of an open position from the tradebook: the FIFO average of the entry-side trades
 * (BUY for LONG, SELL for SHORT) not yet closed by opposite trades. The ONE definition - auto-exit
 * acts on it and the chart draws its levels from it, so they cannot disagree. `trades` comes from
 * prepareTradebook. Null when the tradebook has no valid entry-side trade (a 0 price is never real).
 */
export function entryPriceFromTrades(trades, symbol, exchange, side, positionQuantity) {
  if (!Array.isArray(trades) || trades.length === 0) return null;
  const targetSymbol = normalizeSymbolKey(symbol);
  const targetExchange = normalizeExchange(exchange);
  if (!targetSymbol || !targetExchange || Math.abs(positionQuantity) <= 0) return null;

  const relevant = trades.filter((t) => normalizeSymbolKey(t.symbol) === targetSymbol
    && normalizeExchange(t.exchange) === targetExchange);
  if (!relevant.length) return null;

  const sorted = [...relevant].sort((a, b) => (a.timestamp_epoch ?? 0) - (b.timestamp_epoch ?? 0));
  const openAction = side === 'LONG' ? 'BUY' : 'SELL';
  const closeAction = side === 'LONG' ? 'SELL' : 'BUY';
  const openTrades = sorted.filter((t) => t.action === openAction).map((t) => ({ ...t, remaining: t.quantity }));

  let closeIndex = 0;
  for (const closeTrade of sorted.filter((t) => t.action === closeAction)) {
    let remainingClose = closeTrade.quantity;
    while (remainingClose > 0 && closeIndex < openTrades.length) {
      const open = openTrades[closeIndex];
      if (open.remaining <= 0) { closeIndex += 1; continue; }
      const deduction = Math.min(open.remaining, remainingClose);
      open.remaining -= deduction;
      remainingClose -= deduction;
      if (open.remaining <= 0) closeIndex += 1;
    }
    if (remainingClose > 0) break;
  }

  let qty = 0;
  let cost = 0;
  for (const open of openTrades) {
    if (open.remaining <= 0 || !(open.average_price > 0)) continue;
    qty += open.remaining;
    cost += open.remaining * open.average_price;
  }
  if (qty > 0) return cost / qty;

  const lastValid = [...openTrades].reverse().find((t) => t.average_price > 0);
  return lastValid ? lastValid.average_price : null;
}
