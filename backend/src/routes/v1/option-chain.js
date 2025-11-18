/**
 * Option Chain Routes
 * HTTP endpoints for option chain operations
 */

import express from 'express';
import optionChainService from '../../services/option-chain.service.js';
import { log } from '../../core/logger.js';
import { ValidationError } from '../../core/errors.js';

const router = express.Router();

/**
 * GET /api/v1/option-chain/underlyings
 * Get all underlyings that have options
 */
router.get('/underlyings', async (req, res) => {
  try {
    const { type } = req.query;

    if (type && !['index', 'stock'].includes(type)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid type parameter. Must be "index" or "stock"'
      });
    }

    const result = await optionChainService.getUnderlyings(type);

    log.info('Option chain underlyings retrieved', {
      type: type || 'all',
      indices_count: result.indices.length,
      stocks_count: result.stocks.length
    });

    res.json({
      status: 'success',
      data: result
    });
  } catch (error) {
    log.error('Failed to get option chain underlyings', error);
    res.status(500).json({
      status: 'error',
      message: error.message || 'Internal server error'
    });
  }
});

/**
 * GET /api/v1/option-chain/expiries
 * Get available expiries for an underlying
 */
router.get('/expiries', async (req, res) => {
  try {
    const { underlying, type } = req.query;

    if (!underlying) {
      return res.status(400).json({
        status: 'error',
        message: 'underlying parameter is required'
      });
    }

    if (type && !['index', 'stock'].includes(type)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid type parameter. Must be "index" or "stock"'
      });
    }

    const result = await optionChainService.getExpiries(underlying, type);

    log.info('Option chain expiries retrieved', {
      underlying,
      type: type || 'auto-detect',
      expiries_count: result.expiries.length
    });

    res.json({
      status: 'success',
      data: result
    });
  } catch (error) {
    log.error('Failed to get option chain expiries', error, { underlying: req.query.underlying });

    if (error instanceof ValidationError) {
      return res.status(400).json({
        status: 'error',
        message: error.message
      });
    }

    res.status(500).json({
      status: 'error',
      message: error.message || 'Internal server error'
    });
  }
});

/**
 * GET /api/v1/option-chain
 * Get option chain for underlying + expiry
 */
router.get('/', async (req, res) => {
  try {
    const { underlying, expiry, type, include_quotes, strike_window } = req.query;

    if (!underlying) {
      return res.status(400).json({
        status: 'error',
        message: 'underlying parameter is required'
      });
    }

    if (!expiry) {
      return res.status(400).json({
        status: 'error',
        message: 'expiry parameter is required'
      });
    }

    if (type && !['index', 'stock'].includes(type)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid type parameter. Must be "index" or "stock"'
      });
    }

    const includeQuotes = include_quotes === 'true' || include_quotes === true;
    const window = strike_window ? parseInt(strike_window, 10) : null;

    if (window && (isNaN(window) || window < 0)) {
      return res.status(400).json({
        status: 'error',
        message: 'strike_window must be a positive integer'
      });
    }

    const result = await optionChainService.getOptionChain(
      underlying,
      expiry,
      type,
      includeQuotes,
      window
    );

    log.info('Option chain retrieved', {
      underlying,
      expiry,
      type: type || 'auto-detect',
      rows_count: result.rows.length,
      has_quotes: includeQuotes
    });

    res.json({
      status: 'success',
      data: result
    });
  } catch (error) {
    log.error('Failed to get option chain', error, {
      underlying: req.query.underlying,
      expiry: req.query.expiry
    });

    if (error instanceof ValidationError) {
      return res.status(400).json({
        status: 'error',
        message: error.message
      });
    }

    res.status(500).json({
      status: 'error',
      message: error.message || 'Internal server error'
    });
  }
});

/**
 * GET /api/v1/option-chain/sample/:underlying
 * Get a sample option chain with demo data
 */
router.get('/sample/:underlying', async (req, res) => {
  try {
    const { underlying } = req.params;

    const result = await optionChainService.getSampleChain(underlying);

    log.info('Sample option chain retrieved', {
      underlying,
      rows_count: result.rows.length,
      has_quotes: true
    });

    res.json({
      status: 'success',
      data: result
    });
  } catch (error) {
    log.error('Failed to get sample option chain', error, { underlying: req.params.underlying });

    if (error instanceof ValidationError) {
      return res.status(400).json({
        status: 'error',
        message: error.message
      });
    }

    res.status(500).json({
      status: 'error',
      message: error.message || 'Internal server error'
    });
  }
});

export default router;
