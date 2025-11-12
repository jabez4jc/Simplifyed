/**
 * OpenAlgo API Endpoint Definitions
 * Complete reference for all OpenAlgo v1 API endpoints
 */

/**
 * OpenAlgo API Endpoints (Complete List - 40+ endpoints)
 */
export const ENDPOINTS = {
  // Account Management (7 endpoints)
  PING: 'ping',
  ANALYZER: 'analyzer',
  ANALYZER_TOGGLE: 'analyzer/toggle',
  FUNDS: 'funds',
  HOLDINGS: 'holdings',
  PROFILE: 'profile',
  LIMITS: 'limits',

  // Order Management (9 endpoints)
  ORDERBOOK: 'orderbook',
  PLACEORDER: 'placeorder',
  PLACESMARTORDER: 'placesmartorder',
  SPLITORDER: 'splitorder',
  BASKETORDER: 'basketorder',
  CANCELORDER: 'cancelorder',
  CANCELALLORDER: 'cancelallorder',
  MODIFYORDER: 'modifyorder',

  // Position Management (3 endpoints)
  POSITIONBOOK: 'positionbook',
  OPENPOSITION: 'openposition',
  CLOSEPOSITION: 'closeposition',

  // Trade Management (1 endpoint)
  TRADEBOOK: 'tradebook',

  // Market Data (3 endpoints)
  QUOTES: 'quotes',
  DEPTH: 'depth',
  SEARCHSCRIP: 'searchscrip',

  // Options & Derivatives (3 endpoints)
  EXPIRY: 'expiry',
  STRIKES: 'strikes',
  OPTIONCHAIN: 'optionchain',

  // Historical Data (2 endpoints)
  INTERVALS: 'intervals',
  HISTORY: 'history',

  // Margin Calculator (2 endpoints)
  MARGIN: 'margin',
  BASKETMARGIN: 'basketmargin',

  // Contract & Symbol Info (4 endpoints)
  CONTRACTINFO: 'contractinfo',
  SYMBOLMASTER: 'symbolmaster',
  INDEXLIST: 'indexlist',
  INDEXCONSTITUENTS: 'indexconstituents',

  // GTT - Good Till Triggered (3 endpoints)
  PLACEGTT: 'placegtt',
  GTTORDERS: 'gttorders',
  CANCELGTT: 'cancelgtt',

  // SIP - Systematic Investment Plan (3 endpoints)
  PLACESIP: 'placesip',
  SIPORDERS: 'siporders',
  CANCELSIP: 'cancelsip',
};

/**
 * Request schemas for validation
 */
export const REQUEST_SCHEMAS = {
  placeorder: {
    required: ['apikey', 'strategy', 'exchange', 'symbol', 'action', 'quantity'],
    optional: ['product', 'pricetype', 'price', 'trigger_price', 'disclosed_quantity'],
    defaults: {
      product: 'MIS',
      pricetype: 'MARKET',
      price: '0',
      trigger_price: '0',
      disclosed_quantity: '0',
    },
  },

  placesmartorder: {
    required: ['apikey', 'strategy', 'exchange', 'symbol', 'action', 'quantity', 'position_size'],
    optional: ['product', 'pricetype', 'price', 'trigger_price', 'disclosed_quantity'],
    defaults: {
      product: 'MIS',
      pricetype: 'MARKET',
      price: '0',
      trigger_price: '0',
      disclosed_quantity: '0',
    },
  },

  cancelorder: {
    required: ['apikey', 'strategy', 'orderid'],
    optional: [],
  },

  cancelallorder: {
    required: ['apikey', 'strategy'],
    optional: [],
  },

  closeposition: {
    required: ['apikey', 'strategy'],
    optional: [],
  },

  openposition: {
    required: ['apikey', 'strategy', 'symbol', 'exchange', 'product'],
    optional: [],
  },
};

/**
 * Response schemas for validation
 */
export const RESPONSE_SCHEMAS = {
  ping: {
    status: 'string',
    data: {
      broker: 'string',
      message: 'string',
    },
  },

  analyzer: {
    status: 'string',
    data: {
      mode: 'string',
      analyze_mode: 'boolean',
      total_logs: 'number',
    },
  },

  funds: {
    status: 'string',
    data: {
      availablecash: 'string',
      collateral: 'string',
      m2mrealized: 'string',
      m2munrealized: 'string',
      utiliseddebits: 'string',
    },
  },

  orderbook: {
    status: 'string',
    data: {
      orders: 'array',
      statistics: 'object',
    },
  },

  positionbook: {
    status: 'string',
    data: 'array', // Array of positions
  },

  tradebook: {
    status: 'string',
    data: 'array', // Array of trades
  },

  placeorder: {
    status: 'string',
    orderid: 'string',
  },

  placesmartorder: {
    status: 'string',
    orderid: 'string',
  },
};

/**
 * Valid values for order parameters
 */
export const ORDER_PARAMS = {
  exchanges: ['NSE', 'BSE', 'NFO', 'BFO', 'CDS', 'MCX'],

  products: ['CNC', 'MIS', 'NRML'],

  pricetypes: ['MARKET', 'LIMIT', 'SL', 'SL-M'],

  actions: ['BUY', 'SELL'],

  ordertypes: ['MARKET', 'LIMIT', 'SL', 'SL-M'],
};

/**
 * Error codes and messages
 */
export const ERROR_CODES = {
  INVALID_APIKEY: 'Invalid openalgo apikey',
  INVALID_SYMBOL: 'Invalid symbol',
  INVALID_EXCHANGE: 'Invalid exchange',
  INVALID_QUANTITY: 'Invalid quantity',
  INSUFFICIENT_FUNDS: 'Insufficient funds',
  ORDER_NOT_FOUND: 'Order not found',
  POSITION_NOT_FOUND: 'Position not found',
  RATE_LIMIT_EXCEEDED: 'Rate limit exceeded',
  ANALYZER_MODE_ACTIVE: 'Analyzer mode is active',
};

/**
 * Rate limits (per instance)
 */
export const RATE_LIMITS = {
  default: 50, // requests per second
  placeorder: 10,
  placesmartorder: 10,
  cancelorder: 10,
  quotes: 20,
};

export default {
  ENDPOINTS,
  REQUEST_SCHEMAS,
  RESPONSE_SCHEMAS,
  ORDER_PARAMS,
  ERROR_CODES,
  RATE_LIMITS,
};
