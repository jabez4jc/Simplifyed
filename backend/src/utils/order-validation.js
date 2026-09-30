/**
 * Order Validation Utilities
 * Provides validation functions for order parameters to prevent trading errors
 *
 * CRITICAL: These validations prevent financial losses from invalid orders
 */

import { ValidationError } from '../core/errors.js';
import { log } from '../core/logger.js';

/**
 * Validate quantity for an order
 * @param {number|string} quantity - The quantity to validate
 * @param {string} action - The action (BUY/SELL)
 * @throws {ValidationError} if quantity is invalid
 */
export function validateQuantity(quantity, action = 'BUY') {
  const qty = typeof quantity === 'string' ? parseFloat(quantity) : quantity;

  if (isNaN(qty)) {
    throw new ValidationError('Quantity must be a valid number');
  }

  if (qty <= 0) {
    throw new ValidationError('Quantity must be greater than 0');
  }

  if (!Number.isFinite(qty)) {
    throw new ValidationError('Quantity must be a finite number');
  }

  // Check for unreasonably large quantities (potential typo)
  if (qty > 100000) {
    log.warn('⚠️  Very large quantity detected', { quantity: qty, action });
    throw new ValidationError(
      `Quantity ${qty} is unusually large. Please verify this is correct.`
    );
  }

  return Math.floor(qty); // Return integer quantity
}

/**
 * Validate price for an order
 * @param {number|string} price - The price to validate
 * @param {string} orderType - The order type (MARKET/LIMIT/SL/SL-M)
 * @throws {ValidationError} if price is invalid
 */
export function validatePrice(price, orderType) {
  // MARKET orders don't require price validation
  if (orderType === 'MARKET') {
    return 0;
  }

  const priceValue = typeof price === 'string' ? parseFloat(price) : price;

  // For LIMIT and SL orders, price is required
  if (orderType === 'LIMIT' || orderType === 'SL') {
    if (price === undefined || price === null || price === '') {
      throw new ValidationError(`Price is required for ${orderType} orders`);
    }

    if (isNaN(priceValue)) {
      throw new ValidationError('Price must be a valid number');
    }

    if (priceValue <= 0) {
      throw new ValidationError('Price must be greater than 0');
    }

    if (!Number.isFinite(priceValue)) {
      throw new ValidationError('Price must be a finite number');
    }
  }

  return priceValue;
}



/**
 * Validate exchange parameter
 * @param {string} exchange - The exchange name
 * @throws {ValidationError} if exchange is invalid
 */
export function validateExchange(exchange) {
  if (!exchange || typeof exchange !== 'string' || exchange.trim() === '') {
    throw new ValidationError('Exchange is required and must be a valid string');
  }

  const validExchanges = ['NSE', 'BSE', 'NFO', 'BFO', 'MCX', 'CDS', 'BCD', 'NCO', 'NSE_INDEX', 'BSE_INDEX', 'CRYPTO'];
  const normalizedExchange = exchange.toUpperCase().trim();

  if (!validExchanges.includes(normalizedExchange)) {
    log.warn('Unknown exchange specified', { exchange: normalizedExchange });
    // Don't block - broker might support other exchanges
  }

  return normalizedExchange;
}

/**
 * Validate symbol parameter
 * @param {string} symbol - The symbol name
 * @throws {ValidationError} if symbol is invalid
 */
export function validateSymbol(symbol) {
  if (!symbol || typeof symbol !== 'string' || symbol.trim() === '') {
    throw new ValidationError('Symbol is required and must be a valid string');
  }

  return symbol.trim().toUpperCase();
}

/**
 * Validate action parameter
 * @param {string} action - The action (BUY/SELL)
 * @throws {ValidationError} if action is invalid
 */
export function validateAction(action) {
  if (!action || typeof action !== 'string') {
    throw new ValidationError('Action is required and must be a valid string');
  }

  const normalizedAction = action.toUpperCase().trim();

  if (!['BUY', 'SELL'].includes(normalizedAction)) {
    throw new ValidationError(`Invalid action: ${action}. Must be BUY or SELL`);
  }

  return normalizedAction;
}
