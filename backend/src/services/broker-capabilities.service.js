/**
 * Broker Capabilities Service
 * Centralized lookup for broker-specific feature support.
 */

import settingsService from './settings.service.js';
import {
  buildMarketOrderSupportMap,
  resolveMarketOrderSupport,
} from '../utils/brokerage.js';

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

  async supportsMarketOrders(broker) {
    const map = await this._getMarketOrderSupportMap();
    return resolveMarketOrderSupport(broker, map);
  }
}

export default new BrokerCapabilitiesService();
