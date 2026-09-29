/**
 * Broker Capabilities Service
 * Centralized lookup for broker-specific feature support.
 */

import settingsService from './settings.service.js';
import {
  buildMarketOrderSupportMap,
  resolveMarketOrderSupport,
} from '../utils/brokerage.js';
import { marketOrderAllowed } from '../utils/broker-type.util.js';

const MARKET_SUPPORT_SETTING = 'brokerage.market_order_support';
const CACHE_TTL_MS = 5000;

class BrokerCapabilitiesService {
  constructor() {
    this.marketOrderSupport = {
      map: {},
      updatedAt: 0,
    };
  }

  async _getMarketOrderSupportMap() {
    const now = Date.now();
    if (now - this.marketOrderSupport.updatedAt < CACHE_TTL_MS) {
      return this.marketOrderSupport.map;
    }

    let map = {};
    try {
      const setting = await settingsService.getSetting(MARKET_SUPPORT_SETTING);
      const rawValue = setting?.value ?? setting?.rawValue ?? {};
      map = buildMarketOrderSupportMap(rawValue);
    } catch (error) {
      map = {};
    }

    this.marketOrderSupport = {
      map,
      updatedAt: now,
    };

    return map;
  }

  /**
   * With an exchange, also applies SEBI's limit-only rule: false for every Indian exchange,
   * whatever the broker supports. Callers that know the exchange must pass it.
   */
  async supportsMarketOrders(broker, exchange = undefined) {
    const map = await this._getMarketOrderSupportMap();
    const brokerSupports = resolveMarketOrderSupport(broker, map);
    return exchange === undefined ? brokerSupports : marketOrderAllowed(brokerSupports, exchange);
  }
}

export default new BrokerCapabilitiesService();
