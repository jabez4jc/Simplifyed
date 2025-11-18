/**
 * Market Data Feed Service
 * Centralized polling + cache for OpenAlgo feeds (quotes, positions, orders, funds, etc.)
 * Step 2 of rate-limit mitigation: consolidate traffic so multiple dashboard users don't duplicate calls.
 */

import EventEmitter from 'events';
import instanceService from './instance.service.js';
import marketDataInstanceService from './market-data-instance.service.js';
import watchlistService from './watchlist.service.js';
import openalgoClient from '../integrations/openalgo/client.js';
import { log } from '../core/logger.js';

const DEFAULT_QUOTE_INTERVAL = 2000;   // 2 seconds
const DEFAULT_POSITION_INTERVAL = 10000; // 10 seconds
const DEFAULT_FUNDS_INTERVAL = 15000;

class MarketDataFeedService extends EventEmitter {
  constructor() {
    super();
    this.quoteCache = new Map();      // key: instanceId -> { data, fetchedAt }
    this.positionCache = new Map();
    this.fundsCache = new Map();
    this.intervals = [];
    this.isRunning = false;
  }

  async start(config = {}) {
    if (this.isRunning) return;
    this.isRunning = true;

    const quoteInterval = config.quoteInterval ?? DEFAULT_QUOTE_INTERVAL;
    const positionInterval = config.positionInterval ?? DEFAULT_POSITION_INTERVAL;
    const fundsInterval = config.fundsInterval ?? DEFAULT_FUNDS_INTERVAL;

    await Promise.allSettled([
      this.refreshQuotes(),
      this.refreshPositions(),
      this.refreshFunds(),
    ]);

    this.intervals.push(setInterval(() => this.refreshQuotes(), quoteInterval));
    this.intervals.push(setInterval(() => this.refreshPositions(), positionInterval));
    this.intervals.push(setInterval(() => this.refreshFunds(), fundsInterval));

    log.info('MarketDataFeedService started', { quoteInterval, positionInterval, fundsInterval });
  }

  stop() {
    this.intervals.forEach(clearInterval);
    this.intervals = [];
    this.isRunning = false;
  }

  /**
   * Quotes (per market-data instance)
   */
  async refreshQuotes() {
    try {
      const marketDataInstances = await marketDataInstanceService.getMarketDataInstances();
      const symbolList = await this._buildGlobalSymbolList();

      if (symbolList.length === 0) {
        log.debug('No tracked symbols found. Skipping quote refresh.');
        return;
      }

      await Promise.all(marketDataInstances.map(async (inst) => {
        try {
          const snapshot = await openalgoClient.getQuotes(inst, symbolList);
          this.setQuoteSnapshot(inst.id, snapshot);
          log.debug('Quotes refreshed', { instance: inst.name, count: snapshot.length });
        } catch (error) {
          log.warn('Failed to refresh quotes for instance', {
            instance: inst.name,
            error: error.message,
          });
        }
      }));
    } catch (error) {
      log.warn('Failed to refresh quotes', { error: error.message });
    }
  }

  getQuoteSnapshot(instanceId) {
    return this.quoteCache.get(instanceId);
  }

  setQuoteSnapshot(instanceId, quotes) {
    this.quoteCache.set(instanceId, { data: quotes, fetchedAt: Date.now() });
    this.emit('quotes:update', { instanceId, data: quotes });
  }

  /**
   * Positions (per trading instance)
   */
  async refreshPositions() {
    try {
      const instances = await instanceService.getAllInstances({ is_active: true });
      await Promise.all(instances.map(inst => this.refreshPositionsForInstance(inst.id)));
    } catch (error) {
      log.warn('refreshPositions failed to load instances', { error: error.message });
    }
  }

  getPositionSnapshot(instanceId) {
    return this.positionCache.get(instanceId);
  }

  setPositionSnapshot(instanceId, positions) {
    this.positionCache.set(instanceId, { data: positions, fetchedAt: Date.now() });
    this.emit('positions:update', { instanceId, data: positions });
  }

  async refreshPositionsForInstance(instanceId) {
    try {
      const instance = await instanceService.getInstanceById(instanceId);
      const positionBook = await openalgoClient.getPositionBook(instance);
      this.setPositionSnapshot(instanceId, positionBook);
    } catch (error) {
      log.warn('Failed to refresh positions for instance', { instanceId, error: error.message });
    }
  }

  async invalidatePositions(instanceId, { refresh = false } = {}) {
    this.positionCache.delete(instanceId);
    if (refresh) {
      await this.refreshPositionsForInstance(instanceId);
    }
  }

  /**
   * Funds / balances (per trading instance)
   */
  async refreshFunds() {
    try {
      const instances = await instanceService.getAllInstances({ is_active: true });
      await Promise.all(instances.map(inst => this.refreshFundsForInstance(inst.id)));
    } catch (error) {
      log.warn('refreshFunds failed to load instances', { error: error.message });
    }
  }

  getFundsSnapshot(instanceId) {
    return this.fundsCache.get(instanceId);
  }

  setFundsSnapshot(instanceId, funds) {
    this.fundsCache.set(instanceId, { data: funds, fetchedAt: Date.now() });
    this.emit('funds:update', { instanceId, data: funds });
  }

  async refreshFundsForInstance(instanceId) {
    try {
      const instance = await instanceService.getInstanceById(instanceId);
      const funds = await openalgoClient.getFunds(instance);
      this.setFundsSnapshot(instanceId, funds);
    } catch (error) {
      log.warn('Failed to refresh funds for instance', { instanceId, error: error.message });
    }
  }

  async invalidateFunds(instanceId, { refresh = false } = {}) {
    this.fundsCache.delete(instanceId);
    if (refresh) {
      await this.refreshFundsForInstance(instanceId);
    }
  }

  /**
   * Helpers
   */
  async _buildGlobalSymbolList() {
    try {
      let trackedSymbols = await watchlistService.getTrackedSymbols({
        onlyActiveWatchlists: true,
        onlyEnabledSymbols: true,
        requireAssignedInstances: true,
      });

      // Fallback: include unassigned symbols if nothing is currently assigned
      if (trackedSymbols.length === 0) {
        trackedSymbols = await watchlistService.getTrackedSymbols({
          onlyActiveWatchlists: true,
          onlyEnabledSymbols: true,
          requireAssignedInstances: false,
        });
      }

      if (trackedSymbols.length === 0) {
        return [];
      }

      return trackedSymbols.map(symbol => ({
        exchange: symbol.exchange,
        symbol: symbol.symbol,
      }));
    } catch (error) {
      log.warn('Failed to build global symbol list', { error: error.message });
      return [];
    }
  }
}

const marketDataFeedService = new MarketDataFeedService();
export default marketDataFeedService;
