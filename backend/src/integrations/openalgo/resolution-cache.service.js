/**
 * OpenAlgo Resolution Cache Service
 * Symbol resolution and lot-size caches (bounded, TTL'd) used by the OpenAlgo client when
 * resolving futures/options symbols. Extracted from client.js - fully self-contained, zero
 * references to any other cluster's state.
 */

import { log } from '../../core/logger.js';

class ResolutionCacheService {
  constructor() {
    // Symbol resolution cache for futures/options (bounded to prevent memory growth)
    this.symbolResolutionCache = new Map(); // key: underlying|exchange|expiry -> { symbol, resolvedAt }
    this.symbolResolutionTtl = 5 * 60 * 1000; // 5 minutes
    this.symbolResolutionCacheMaxSize = 1000; // Max entries to prevent unbounded growth

    // Lot size cache (bounded to prevent memory growth)
    this.lotSizeCache = new Map(); // key: exchange|symbol -> { lotSize, cachedAt }
    this.lotSizeCacheTtl = 24 * 60 * 60 * 1000; // 24 hours (lot sizes rarely change)
    this.lotSizeCacheMaxSize = 500; // Max entries to prevent unbounded growth
  }

  cacheResolvedSymbol(underlying, exchange, expiry, resolved) {
    const key = `${underlying}|${exchange}|${expiry}`;

    // Evict oldest entries if cache is at max size
    if (this.symbolResolutionCache.size >= this.symbolResolutionCacheMaxSize) {
      this._evictOldestEntries(this.symbolResolutionCache, 'resolvedAt', 100);
    }

    this.symbolResolutionCache.set(key, {
      ...resolved,
      resolvedAt: Date.now(),
    });
  }

  /**
   * Get cached resolved symbol if still valid
   * @param {string} underlying - Underlying symbol
   * @param {string} exchange - Exchange
   * @param {string} expiry - Expiry date
   * @returns {Object|null} - Resolved symbol or null if not cached/expired
   */
  getCachedResolvedSymbol(underlying, exchange, expiry) {
    const key = `${underlying}|${exchange}|${expiry}`;
    const cached = this.symbolResolutionCache.get(key);
    if (cached && (Date.now() - cached.resolvedAt) < this.symbolResolutionTtl) {
      return cached;
    }
    return null;
  }

  /**
   * Cache lot size for a symbol with bounded size
   * Evicts oldest entries when cache exceeds max size
   * @param {string} exchange - Exchange
   * @param {string} symbol - Symbol
   * @param {number} lotSize - Lot size
   */
  cacheLotSize(exchange, symbol, lotSize) {
    const key = `${exchange}|${symbol}`;

    // Evict oldest entries if cache is at max size
    if (this.lotSizeCache.size >= this.lotSizeCacheMaxSize) {
      this._evictOldestEntries(this.lotSizeCache, 'cachedAt', 50);
    }

    this.lotSizeCache.set(key, {
      lotSize,
      cachedAt: Date.now(),
    });
  }

  /**
   * Get cached lot size
   * @param {string} exchange - Exchange
   * @param {string} symbol - Symbol
   * @returns {number|null} - Lot size or null if not cached
   */
  getCachedLotSize(exchange, symbol) {
    const key = `${exchange}|${symbol}`;
    const cached = this.lotSizeCache.get(key);
    if (cached && (Date.now() - cached.cachedAt) < this.lotSizeCacheTtl) {
      return cached.lotSize;
    }
    return null;
  }

  /**
   * Pre-load lot sizes for multiple symbols
   * @param {Array<{exchange: string, symbol: string, lotSize: number}>} symbols
   */
  preloadLotSizes(symbols) {
    for (const { exchange, symbol, lotSize } of symbols) {
      if (lotSize && lotSize > 0) {
        this.cacheLotSize(exchange, symbol, lotSize);
      }
    }
    log.debug('Pre-loaded lot sizes', { count: symbols.length });
  }

  /**
   * Evict oldest entries from a cache Map
   * Removes entries with the oldest timestamp values
   * @private
   * @param {Map} cache - The cache Map to evict from
   * @param {string} timestampKey - The key in cache values containing the timestamp
   * @param {number} count - Number of entries to evict
   */
  _evictOldestEntries(cache, timestampKey, count) {
    // CRITICAL FIX: More efficient cache eviction
    // Old: O(n log n) sort on every eviction
    // New: O(n) for large deletions, O(n * count) for small deletions (better for typical use)
    const toDelete = Math.min(count, cache.size);

    if (toDelete === 0) return;

    // Strategy: If deleting >30%, sort is worth it. Otherwise, iterate to find oldest.
    const deletionRatio = toDelete / cache.size;

    if (deletionRatio > 0.3 || cache.size < 100) {
      // For large deletions or small caches, sorting is efficient
      const entries = [...cache.entries()]
        .sort((a, b) => (a[1][timestampKey] || 0) - (b[1][timestampKey] || 0));

      for (let i = 0; i < toDelete; i++) {
        cache.delete(entries[i][0]);
      }
    } else {
      // For small deletions in large cache, find oldest iteratively (avoids full sort)
      for (let i = 0; i < toDelete; i++) {
        let oldestKey = null;
        let oldestTimestamp = Infinity;

        for (const [key, value] of cache.entries()) {
          const ts = value[timestampKey] || 0;
          if (ts < oldestTimestamp) {
            oldestTimestamp = ts;
            oldestKey = key;
          }
        }

        if (oldestKey !== null) {
          cache.delete(oldestKey);
        } else {
          break;
        }
      }
    }

    log.debug('Cache eviction performed', {
      evicted: toDelete,
      remainingSize: cache.size,
      strategy: deletionRatio > 0.3 ? 'sorted' : 'iterative'
    });
  }
}

const resolutionCacheService = new ResolutionCacheService();
export default resolutionCacheService;
export { ResolutionCacheService };
