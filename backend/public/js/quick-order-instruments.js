/**
 * Simplifyed Admin V2 - Quick Order: expiry/instrument helpers.
 */

Object.defineProperties(QuickOrderHandler.prototype, Object.getOwnPropertyDescriptors(class {
  /**
   * Fetch available expiries for a symbol
   */
  async fetchAvailableExpiries(underlyingSymbol, exchange, tradeMode, baseExchange) {
    const cleanedInput = (underlyingSymbol || '').trim();
    const normalizedUnderlying = this.extractUnderlying(cleanedInput) || cleanedInput;
    const derivativeExchange = this.getDerivativeExchange(exchange);
    const shouldUseSymbolMatch = ['NSE_INDEX', 'BSE_INDEX'].includes((baseExchange || '').toUpperCase());
    const primaryMatchField = shouldUseSymbolMatch ? 'symbol' : 'name';
    const instrumentTypes = this.getInstrumentTypesForMode(tradeMode);
    // debug: removed noisy log

    const fetchWithField = async (field, options = {}) => {
      const response = await api.getExpiry(normalizedUnderlying, {
        exchange: derivativeExchange,
        instrumentTypes,
        matchField: field,
        ...options,
      });
      if (response?.data && Array.isArray(response.data)) {
        return response.data.map(exp => exp.expiry || exp);
      }
      return [];
    };

    try {
      // Fast path: rely on instruments cache (no instanceId required)
      let cachedExpiries = await fetchWithField(primaryMatchField);

      if (cachedExpiries.length === 0) {
        const fallbackField = primaryMatchField === 'symbol' ? 'name' : 'symbol';
        if (fallbackField !== primaryMatchField) {
          cachedExpiries = await fetchWithField(fallbackField);
        }
      }

      if (cachedExpiries.length > 0) {
        // debug: removed noisy log
        return cachedExpiries;
      }

      // debug: removed noisy log

      // Fallback: find an active instance to refresh expiries from broker
      let instancesResponse = await api.getInstances({ is_active: 1 });
      let activeInstances = instancesResponse.data || [];
      if (activeInstances.length === 0) {
        instancesResponse = await api.getInstances({});
        activeInstances = (instancesResponse.data || []).filter(inst =>
          inst.is_active === 1 || inst.is_active === true || inst.is_active === '1'
        );
      }

      if (activeInstances.length === 0) {
        console.warn('[QuickOrder] No active instances available to refresh expiries');
        return [];
      }

      const fallbackInstance = activeInstances[0];
      // debug: removed noisy log
      let refreshedExpiries = await fetchWithField(primaryMatchField, { instanceId: fallbackInstance.id });
      if (refreshedExpiries.length === 0) {
        const fallbackField = primaryMatchField === 'symbol' ? 'name' : 'symbol';
        if (fallbackField !== primaryMatchField) {
          refreshedExpiries = await fetchWithField(fallbackField, { instanceId: fallbackInstance.id });
        }
      }
      // debug: removed noisy log
      return refreshedExpiries;
    } catch (error) {
      console.error('[QuickOrder] Failed to fetch expiries:', error);
      return [];
    }
  }

  /**
   * Get the correct exchange for derivatives based on the symbol's cash exchange
   */
  getDerivativeExchange(exchange, symbolType) {
    // Map cash exchanges to their derivative exchanges
    const exchangeMap = {
      'NSE': 'NFO',         // NSE equity -> NSE F&O
      'NSE_INDEX': 'NFO',   // NSE indices -> NSE F&O
      'BSE': 'BFO',         // BSE equity -> BSE F&O
      'BSE_INDEX': 'BFO',   // BSE indices -> BSE F&O
      'NFO': 'NFO',         // Already derivative exchange
      'BFO': 'BFO',         // Already derivative exchange
      'MCX': 'MCX',         // Commodities
      'CDS': 'CDS',         // Currency derivatives
    };

    return exchangeMap[exchange] || exchange; // Unmapped (e.g. CRYPTO) - use as-is
  }

  /**
   * Extract underlying symbol from full symbol name
   */
  extractUnderlying(symbol) {
    // Remove common suffixes and extract base symbol
    // Examples: BANKNIFTY25NOV2558000CE -> BANKNIFTY
    //           NIFTY25DEC50FUT -> NIFTY
    //           NATGASMINI28JUL26FUT -> NATGASMINI

    if (!symbol) return symbol;
    const upper = String(symbol).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!upper) return symbol;

    // Broker symbols embed a DDMMMYY-style expiry (e.g. 28JUL26) followed by an optional strike
    // and a CE/PE/FUT suffix. Naive trailing-digit stripping breaks on this because the suffix
    // is letters (CE/PE/FUT), not digits - split on the date pattern instead to recover the
    // plain underlying name regardless of what follows it.
    const dateMatch = upper.match(/^([A-Z]+)\d{1,2}[A-Z]{3}\d{2,4}/);
    if (dateMatch) {
      return dateMatch[1];
    }

    // Fallback for symbols with no recognizable date pattern (legacy behavior).
    return upper.replace(/\d+$/, '');
  }

  getInstrumentTypesForMode(tradeMode) {
    if (tradeMode === 'FUTURES') {
      return ['FUT'];
    }
    if (tradeMode === 'OPTIONS') {
      return ['CE', 'PE'];
    }
    return [];
  }

  /**
   * Format expiry date for display
   */
  formatExpiryDate(expiry) {
    if (!expiry) return 'N/A';

    // Handle different date formats
    // "2025-11-28" -> "28-NOV-25"
    // "28-NOV-25" -> "28-NOV-25" (already formatted)

    if (expiry.includes('-') && expiry.length === 10) {
      // Convert YYYY-MM-DD to DD-MMM-YY
      const date = new Date(expiry);
      const day = String(date.getDate()).padStart(2, '0');
      const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
                          'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
      const month = monthNames[date.getMonth()];
      const year = String(date.getFullYear()).slice(-2);
      return `${day}-${month}-${year}`;
    }

    return expiry;
  }

  /**
   * Normalize expiry date to YYYY-MM-DD format (API format)
   * Converts "18-NOV-25" -> "2025-11-18"
   * Passes through "2025-11-18" unchanged
   */
  normalizeExpiryDate(expiry) {
    if (!expiry) return null;

    // Already in YYYY-MM-DD format (10 chars, starts with digit, has 2 dashes)
    if (expiry.length === 10 && /^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
      return expiry;
    }

    // Convert DD-MMM-YY to YYYY-MM-DD
    if (expiry.length === 9 && /^\d{2}-[A-Z]{3}-\d{2}$/.test(expiry)) {
      const [day, monthStr, year] = expiry.split('-');
      const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
                          'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
      const month = monthNames.indexOf(monthStr);

      if (month === -1) {
        console.error('[QuickOrder] Invalid month in expiry:', expiry);
        return null;
      }

      // Convert 2-digit year to 4-digit year (assuming 20xx)
      const fullYear = `20${year}`;
      const paddedMonth = String(month + 1).padStart(2, '0');

      return `${fullYear}-${paddedMonth}-${day}`;
    }

    console.warn('[QuickOrder] Unknown expiry format:', expiry);
    return expiry;
  }
}.prototype));
