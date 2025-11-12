/**
 * OpenAlgo Request/Response Validators
 * Validates data before sending to OpenAlgo and after receiving responses
 */

import { REQUEST_SCHEMAS, ORDER_PARAMS } from './endpoints.js';
import { ValidationError } from '../../core/errors.js';

/**
 * Validate order request data
 * @param {Object} data - Order data to validate
 * @param {string} endpoint - Endpoint name (e.g., 'placeorder')
 * @returns {Object} - Validated and normalized data
 * @throws {ValidationError} - If validation fails
 */
export function validateOrderRequest(data, endpoint) {
  const schema = REQUEST_SCHEMAS[endpoint];

  if (!schema) {
    throw new ValidationError(`Unknown endpoint: ${endpoint}`);
  }

  const errors = [];
  const validated = { ...data };

  // Check required fields
  for (const field of schema.required) {
    if (field === 'apikey') continue; // apikey is added by client

    if (!data[field] || data[field] === '') {
      errors.push({
        field,
        message: `${field} is required`,
      });
    }
  }

  // Validate exchange
  if (data.exchange) {
    const exchange = data.exchange.toUpperCase();
    if (!ORDER_PARAMS.exchanges.includes(exchange)) {
      errors.push({
        field: 'exchange',
        message: `Invalid exchange. Must be one of: ${ORDER_PARAMS.exchanges.join(', ')}`,
      });
    }
    validated.exchange = exchange;
  }

  // Validate product
  if (data.product) {
    const product = data.product.toUpperCase();
    if (!ORDER_PARAMS.products.includes(product)) {
      errors.push({
        field: 'product',
        message: `Invalid product. Must be one of: ${ORDER_PARAMS.products.join(', ')}`,
      });
    }
    validated.product = product;
  }

  // Validate pricetype
  if (data.pricetype) {
    const pricetype = data.pricetype.toUpperCase();
    if (!ORDER_PARAMS.pricetypes.includes(pricetype)) {
      errors.push({
        field: 'pricetype',
        message: `Invalid pricetype. Must be one of: ${ORDER_PARAMS.pricetypes.join(', ')}`,
      });
    }
    validated.pricetype = pricetype;
  }

  // Validate action
  if (data.action) {
    const action = data.action.toUpperCase();
    if (!ORDER_PARAMS.actions.includes(action)) {
      errors.push({
        field: 'action',
        message: `Invalid action. Must be one of: ${ORDER_PARAMS.actions.join(', ')}`,
      });
    }
    validated.action = action;
  }

  // Validate quantity
  if (data.quantity !== undefined) {
    const qty = parseInt(data.quantity, 10);
    if (isNaN(qty) || qty <= 0) {
      errors.push({
        field: 'quantity',
        message: 'Quantity must be a positive integer',
      });
    }
    validated.quantity = String(qty);
  }

  // Validate price (for LIMIT orders)
  if (validated.pricetype === 'LIMIT' && data.price) {
    const price = parseFloat(data.price);
    if (isNaN(price) || price <= 0) {
      errors.push({
        field: 'price',
        message: 'Price must be a positive number for LIMIT orders',
      });
    }
    validated.price = String(price);
  }

  // Validate trigger_price (for SL orders)
  if (['SL', 'SL-M'].includes(validated.pricetype) && data.trigger_price) {
    const triggerPrice = parseFloat(data.trigger_price);
    if (isNaN(triggerPrice) || triggerPrice <= 0) {
      errors.push({
        field: 'trigger_price',
        message: 'Trigger price must be a positive number for SL orders',
      });
    }
    validated.trigger_price = String(triggerPrice);
  }

  // Validate position_size (for placesmartorder)
  if (endpoint === 'placesmartorder' && data.position_size !== undefined) {
    const posSize = parseInt(data.position_size, 10);
    if (isNaN(posSize)) {
      errors.push({
        field: 'position_size',
        message: 'Position size must be an integer',
      });
    }
    validated.position_size = String(posSize);
  }

  // Apply defaults
  if (schema.defaults) {
    for (const [key, value] of Object.entries(schema.defaults)) {
      if (!validated[key]) {
        validated[key] = value;
      }
    }
  }

  // Throw validation error if there are errors
  if (errors.length > 0) {
    throw new ValidationError('Order validation failed', errors);
  }

  return validated;
}

/**
 * Validate OpenAlgo response
 * @param {Object} response - Response from OpenAlgo API
 * @param {string} endpoint - Endpoint name
 * @returns {boolean} - true if valid
 * @throws {ValidationError} - If validation fails
 */
export function validateResponse(response, endpoint) {
  if (!response) {
    throw new ValidationError('Empty response from OpenAlgo');
  }

  // Check status field
  if (!response.status) {
    throw new ValidationError('Response missing status field');
  }

  // Check if error status
  if (response.status === 'error') {
    throw new ValidationError(
      response.message || 'OpenAlgo returned error status'
    );
  }

  return true;
}

/**
 * Validate symbol format
 * @param {string} symbol - Trading symbol
 * @returns {boolean} - true if valid
 */
export function validateSymbol(symbol) {
  if (!symbol || typeof symbol !== 'string') {
    return false;
  }

  // Basic validation: alphanumeric only
  const symbolRegex = /^[A-Z0-9]+$/;
  return symbolRegex.test(symbol.toUpperCase());
}

/**
 * Validate exchange code
 * @param {string} exchange - Exchange code
 * @returns {boolean} - true if valid
 */
export function validateExchange(exchange) {
  if (!exchange || typeof exchange !== 'string') {
    return false;
  }

  return ORDER_PARAMS.exchanges.includes(exchange.toUpperCase());
}

/**
 * Validate instance configuration
 * @param {Object} instance - Instance object
 * @returns {boolean} - true if valid
 * @throws {ValidationError} - If validation fails
 */
export function validateInstance(instance) {
  const errors = [];

  if (!instance) {
    throw new ValidationError('Instance is required');
  }

  if (!instance.host_url || typeof instance.host_url !== 'string') {
    errors.push({
      field: 'host_url',
      message: 'Valid host_url is required',
    });
  }

  if (!instance.api_key || typeof instance.api_key !== 'string') {
    errors.push({
      field: 'api_key',
      message: 'Valid api_key is required',
    });
  }

  if (errors.length > 0) {
    throw new ValidationError('Instance validation failed', errors);
  }

  return true;
}

export default {
  validateOrderRequest,
  validateResponse,
  validateSymbol,
  validateExchange,
  validateInstance,
};
