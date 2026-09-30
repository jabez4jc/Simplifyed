/**
 * Option Greeks Service
 * Thin wrapper over the OpenAlgo Greeks endpoints, resolving underlying_symbol/underlying_exchange
 * the same way the rest of the options pipeline does (options-resolution.service.js) for
 * consistency, rather than reimplementing that lookup.
 */

import db from '../core/database.js';
import { ValidationError } from '../core/errors.js';
import openalgoClient from '../integrations/openalgo/client.js';

class OptionGreeksService {
  async getGreeks(instanceId, { symbol, exchange, underlyingSymbol, underlyingExchange }) {
    if (!symbol || !exchange) {
      throw new ValidationError('symbol and exchange are required');
    }
    const instance = await this._getInstance(instanceId);
    return openalgoClient.getOptionGreeks(instance, {
      symbol,
      exchange,
      underlying_symbol: underlyingSymbol || undefined,
      underlying_exchange: underlyingExchange || undefined,
    });
  }


  async _getInstance(instanceId) {
    const instance = await db.get('SELECT * FROM instances WHERE id = ?', [instanceId]);
    if (!instance) {
      throw new ValidationError('Instance not found');
    }
    return instance;
  }
}

const optionGreeksService = new OptionGreeksService();
export default optionGreeksService;
