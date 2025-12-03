/**
 * Tradebook Utilities
 * Shared helpers for normalizing trade responses from OpenAlgo.
 */

import { toISTISOString } from './time.js';

export function parseTradeTimestamp(raw) {
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

  const quantity = Number(trade.quantity ?? trade.qty ?? 0) || 0;
  const priceValue = Number(trade.average_price ?? trade.price ?? trade.avg_price ?? 0) || 0;
  const timestampRaw = trade.timestamp || trade.trade_time || trade.placed_at || trade.executed_at;
  const parsedTimestamp = parseTradeTimestamp(timestampRaw);
  const timestampEpoch = parsedTimestamp ? parsedTimestamp.getTime() : null;

  const tradeValue = Number(trade.trade_value ?? trade.value ?? quantity * priceValue) || 0;

  return {
    symbol,
    exchange,
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
