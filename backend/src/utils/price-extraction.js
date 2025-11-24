/**
 * Price Extraction Utilities
 * Centralized logic for extracting prices from broker API responses
 * Handles various field name variations across different brokers
 */

import { log } from '../core/logger.js';

/**
 * Extract LTP (Last Traded Price) from quote/position data
 * Tries multiple field names in order of reliability
 * @param {Object} data - Quote or position data from broker
 * @returns {number|null} - LTP value or null if not found
 */
export function extractLtp(data) {
  if (!data) return null;

  // Primary candidates: various LTP field names (most reliable)
  const primaryCandidates = [
    data.ltp,
    data.LTP,
    data.last_price,
    data.lastPrice,
    data.last_traded_price,
    data.lastTradedPrice,
    data.ltp_value,
    data.ltpValue,
  ];

  for (const value of primaryCandidates) {
    const parsed = parseFloat(value);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }

  // Fallback 1: use mid-price (bid + ask) / 2 if both are valid and non-zero
  const bid = parseFloat(data.bid);
  const ask = parseFloat(data.ask);

  if (!isNaN(bid) && bid > 0 && !isNaN(ask) && ask > 0) {
    const midPrice = (bid + ask) / 2;
    log.debug('Using bid/ask mid-price fallback for LTP', {
      bid,
      ask,
      midPrice,
      reason: 'LTP unavailable',
    });
    return midPrice;
  }

  // Fallback 2: use bid or ask alone
  if (!isNaN(bid) && bid > 0) {
    log.debug('Using bid as LTP fallback', { bid, reason: 'LTP and ask unavailable' });
    return bid;
  }
  if (!isNaN(ask) && ask > 0) {
    log.debug('Using ask as LTP fallback', { ask, reason: 'LTP and bid unavailable' });
    return ask;
  }

  // Fallback 3: use close, prev_close, open, high, low (for indices that might not have bid/ask)
  const secondaryCandidates = [
    data.close,
    data.prev_close,
    data.prevClose,
    data.previous_close,
    data.previousClose,
    data.open,
    data.high,
    data.low,
    data.price, // Generic price field
  ];

  for (const value of secondaryCandidates) {
    const parsed = parseFloat(value);
    if (!isNaN(parsed) && parsed > 0) {
      log.debug('Using secondary price fallback for LTP', {
        value: parsed,
        reason: 'LTP and bid/ask unavailable',
      });
      return parsed;
    }
  }

  return null;
}

/**
 * Extract average/entry price from position data
 * @param {Object} position - Position data from broker
 * @returns {number|null} - Average price or null if not found
 */
export function extractAveragePrice(position) {
  if (!position) return null;

  const candidates = [
    position.average_price,
    position.averagePrice,
    position.avg_price,
    position.avgPrice,
    position.avgprice,
    position.open_price,
    position.openPrice,
    position.entry_price,
    position.entryPrice,
  ];

  for (const value of candidates) {
    const parsed = parseFloat(value);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

/**
 * Extract price from data with custom field preferences
 * More flexible than extractLtp - allows caller to specify field priority
 * @param {Object} data - Data object containing price fields
 * @param {string[]} fieldNames - Array of field names to try in order
 * @returns {number|null} - Price value or null if not found
 */
export function extractPrice(data, fieldNames = []) {
  if (!data) return null;

  for (const fieldName of fieldNames) {
    const value = data[fieldName];
    if (typeof value === 'number' && value > 0) {
      return value;
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = parseFloat(value);
      if (!isNaN(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }

  return null;
}

/**
 * Calculate mid-price from bid and ask
 * @param {number|string} bid - Bid price
 * @param {number|string} ask - Ask price
 * @returns {number|null} - Mid-price or null if invalid
 */
export function calculateMidPrice(bid, ask) {
  const bidValue = typeof bid === 'string' ? parseFloat(bid) : bid;
  const askValue = typeof ask === 'string' ? parseFloat(ask) : ask;

  if (isNaN(bidValue) || bidValue <= 0 || isNaN(askValue) || askValue <= 0) {
    return null;
  }

  return (bidValue + askValue) / 2;
}

export default {
  extractLtp,
  extractAveragePrice,
  extractPrice,
  calculateMidPrice,
};
