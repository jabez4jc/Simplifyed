/**
 * Simplifyed Admin V2 - Quick Order: option preview polling + futures preview polling, kept as
 * one file since syncPreviewPollingWithStreaming genuinely drives both together and
 * buildQuoteKey/computeChangePercent are shared by both preview renderers.
 */

Object.defineProperties(QuickOrderHandler.prototype, Object.getOwnPropertyDescriptors(class {
  triggerOptionPreviewRefresh(symbolId) {
    const container = document.getElementById(`option-preview-${symbolId}`);
    if (!container) {
      return;
    }

    // Kick off a refresh without waiting for the next scheduled tick
    this.refreshOptionPreview(symbolId);
  }

  startOptionPreviewPolling(symbolId) {
    this.stopOptionPreviewPolling(symbolId);
    this.refreshOptionPreview(symbolId);
    if (window.app && typeof window.app.isWsStreamingActive === 'function' && window.app.isWsStreamingActive()) {
      return;
    }
    const intervalId = setInterval(() => this.refreshOptionPreview(symbolId), 20000);
    this.optionPreviewTimers.set(symbolId, intervalId);
  }

  stopOptionPreviewPolling(symbolId) {
    if (this.optionPreviewTimers.has(symbolId)) {
      clearInterval(this.optionPreviewTimers.get(symbolId));
      this.optionPreviewTimers.delete(symbolId);
    }
    this.optionPreviewRequestIds.delete(symbolId);
  }

  stopAllOptionPreviewPolling() {
    this.optionPreviewTimers.forEach(intervalId => clearInterval(intervalId));
    this.optionPreviewTimers.clear();
    this.optionPreviewRequestIds.clear();
  }

  refreshPositionsAfterOrder() {
    if (window.app && window.app.currentView === 'watchlists' && typeof window.app.loadPositionsTab === 'function') {
      window.app.loadPositionsTab();
    }
  }

  async refreshOptionPreview(symbolId) {
    const container = document.getElementById(`option-preview-${symbolId}`);
    if (!container) {
      return;
    }

    const tradeMode = this.selectedTradeModes.get(symbolId) || 'EQUITY';
    if (tradeMode !== 'OPTIONS') {
      container.innerHTML = '<p class="text-sm text-neutral-500">Switch to Options mode to view CE/PE quotes.</p>';
      this.stopOptionPreviewPolling(symbolId);
      return;
    }

    const expiry = this.selectedExpiries.get(symbolId);
    if (!expiry) {
      container.innerHTML = '<p class="text-sm text-warning">Select an expiry to view CE/PE quotes.</p>';
      return;
    }

    const optionsLeg = this.selectedOptionsLegs.get(symbolId) || 'ATM';
    const requestId = (this.optionPreviewRequestIds.get(symbolId) || 0) + 1;
    this.optionPreviewRequestIds.set(symbolId, requestId);

    if (!container.dataset.loaded) {
      container.innerHTML = '<p class="text-sm text-neutral-500">Loading option quotes…</p>';
    }

    try {
      const response = await api.getQuickOrderOptionsPreview({
        symbolId,
        expiry,
        optionsLeg,
      });

      if (this.optionPreviewRequestIds.get(symbolId) !== requestId) {
        return;
      }

      const preview = response?.data || response;
      this.renderOptionPreview(symbolId, preview);
      container.dataset.loaded = 'true';
    } catch (error) {
      if (this.optionPreviewRequestIds.get(symbolId) !== requestId) {
        return;
      }
      const message = error?.message || 'Failed to load option quotes';
      container.innerHTML = `<p class="text-sm text-error">${Utils.escapeHTML(message)}</p>`;
    }
  }

  renderOptionPreview(symbolId, preview) {
    const container = document.getElementById(`option-preview-${symbolId}`);
    if (!container) {
      return;
    }

    if (!preview) {
      container.innerHTML = '<p class="text-sm text-error">Option preview unavailable.</p>';
      return;
    }

    if (preview.strikePreview) {
      this.strikeOffsetSnapshots.set(symbolId, preview.strikePreview);
    } else {
      this.strikeOffsetSnapshots.delete(symbolId);
    }
    this.refreshStrikeDropdownLabels(symbolId);

    const expiryLabel = preview.expiry ? this.formatExpiryDate(preview.expiry) : 'N/A';
    const underlyingSymbol = preview.underlying?.symbol || '';
    const underlyingLtp = preview.underlying?.ltp != null
      ? `₹${Utils.formatNumber(preview.underlying.ltp)}`
      : '—';
    const underlyingKey = this.buildQuoteKey(
      preview.underlying?.exchange,
      preview.underlying?.symbol || preview.underlying?.trading_symbol || preview.underlying?.tradingsymbol
    );
    const atmStrike = preview.atmStrike != null ? preview.atmStrike : '—';
    const updatedAt = preview.updatedAt ? new Date(preview.updatedAt) : null;
    const updatedLabel = updatedAt
      ? `Refreshed ${updatedAt.toLocaleTimeString()}`
      : 'Refreshed moments ago';

    container.innerHTML = `
      <div class="flex items-center justify-between gap-2 text-xs mb-2">
        <div class="font-semibold text-base-content">
          Option Symbols (${preview.strikeOffset}) | Expiry <span class="text-neutral-700">${expiryLabel}</span> • ${Utils.escapeHTML(underlyingSymbol)} <span class="text-neutral-700" ${underlyingKey ? `data-quote-key="${Utils.escapeHTML(underlyingKey)}" data-quote-role="ltp"` : ''}>${underlyingLtp}</span> • ATM <span class="text-neutral-700">${atmStrike}</span>
        </div>
        <span class="text-neutral-500 whitespace-nowrap">${updatedLabel}</span>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
        ${this.renderOptionPreviewLeg('CALL', preview.ce)}
        ${this.renderOptionPreviewLeg('PUT', preview.pe)}
      </div>
    `;
  }

  renderOptionPreviewLeg(label, leg) {
    if (!leg) {
      return `
        <div class="text-xs text-neutral-500 p-1">
          No ${label} leg available
        </div>
      `;
    }

    const quoteKey = this.buildQuoteKey(
      leg.exchange || leg.exch || leg.exchangeSegment,
      leg.symbol || leg.trading_symbol || leg.tradingsymbol
    );
    const legLtp = leg.ltp ?? leg.lastPrice ?? leg.last_price ?? leg.price;
    const ltpDefined = typeof legLtp === 'number' && !Number.isNaN(legLtp);
    const ltpText = ltpDefined ? `₹${Utils.formatNumber(legLtp)}` : '—';
    const ltpClass = leg.quoteStale || !ltpDefined
      ? 'text-base font-semibold text-neutral-400'
      : 'text-base font-semibold';
    const legChange = leg.changePercent ?? leg.change_percent;
    const changeDefined = typeof legChange === 'number' && !Number.isNaN(legChange);
    const changeText = changeDefined
      ? `${legChange >= 0 ? '+' : ''}${legChange.toFixed(2)}%`
      : '—';
    const changeClass = changeDefined
      ? (legChange > 0 ? 'text-profit' : (legChange < 0 ? 'text-loss' : 'text-neutral-500'))
      : 'text-neutral-500';
    const sourceBadge = this.renderQuoteSourceBadge(leg.quoteSource);

    return `
      <div class="text-xs">
        <div class="text-neutral-600 mb-1">
          ${label} • <span class="font-mono">${Utils.escapeHTML(leg.symbol || '')}</span> • Strike ${leg.strike ?? '—'} • Lot ${leg.lotSize ?? '—'} ${sourceBadge}
        </div>
        <div class="flex items-baseline gap-2">
          <span class="${ltpClass}" ${quoteKey ? `data-quote-key="${Utils.escapeHTML(quoteKey)}" data-quote-role="ltp"` : ''}>${ltpText}</span>
        </div>
      </div>
    `;
  }

  renderQuoteSourceBadge(source) {
    if (!source) return '';
    const normalized = String(source).toLowerCase();
    let label = 'REST';
    if (normalized.includes('ws')) {
      label = 'WS';
    } else if (normalized.includes('cache')) {
      label = 'CACHE';
    }
    return `<span class="text-[10px] uppercase tracking-wide text-neutral-500 border border-neutral-300 rounded px-1 align-middle">${label}</span>`;
  }

  triggerFuturesPreviewRefresh(symbolId) {
    const container = document.getElementById(`futures-preview-${symbolId}`);
    if (!container) {
      return;
    }
    this.refreshFuturesPreview(symbolId);
  }

  startFuturesPreviewPolling(symbolId) {
    this.stopFuturesPreviewPolling(symbolId);
    this.refreshFuturesPreview(symbolId);
    if (window.app && typeof window.app.isWsStreamingActive === 'function' && window.app.isWsStreamingActive()) {
      return;
    }
    const intervalId = setInterval(() => this.refreshFuturesPreview(symbolId), 20000);
    this.futuresPreviewTimers.set(symbolId, intervalId);
  }

  stopFuturesPreviewPolling(symbolId) {
    if (this.futuresPreviewTimers.has(symbolId)) {
      clearInterval(this.futuresPreviewTimers.get(symbolId));
      this.futuresPreviewTimers.delete(symbolId);
    }
    this.futuresPreviewRequestIds.delete(symbolId);
  }

  stopAllFuturesPreviewPolling() {
    this.futuresPreviewTimers.forEach(intervalId => clearInterval(intervalId));
    this.futuresPreviewTimers.clear();
    this.futuresPreviewRequestIds.clear();
  }

  syncPreviewPollingWithStreaming() {
    const wsActive = window.app && typeof window.app.isWsStreamingActive === 'function'
      ? window.app.isWsStreamingActive()
      : false;
    const rows = Array.from(this.expandedRows || []);
    rows.forEach((rowKey) => {
      const parts = rowKey.split('_');
      const symbolId = parseInt(parts[1], 10);
      if (!Number.isFinite(symbolId)) return;

      if (wsActive) {
        this.stopOptionPreviewPolling(symbolId);
        this.stopFuturesPreviewPolling(symbolId);
        this.refreshOptionPreview(symbolId);
        this.refreshFuturesPreview(symbolId);
        return;
      }

      const tradeMode = this.selectedTradeModes.get(symbolId);
      if (tradeMode === 'OPTIONS') {
        this.startOptionPreviewPolling(symbolId);
      } else if (tradeMode === 'FUTURES') {
        this.startFuturesPreviewPolling(symbolId);
      } else {
        this.stopOptionPreviewPolling(symbolId);
        this.stopFuturesPreviewPolling(symbolId);
      }
    });
  }

  buildQuoteKey(exchange, symbol) {
    const segmentMap = {
      1: 'NSE',
      2: 'NFO',
      3: 'BSE',
      4: 'BFO',
      5: 'MCX',
    };
    let exchInput = exchange;
    if (typeof exchInput === 'number') {
      exchInput = segmentMap[exchInput] || String(exchInput);
    }
    const exch = (exchInput || '').trim().toUpperCase().replace(/_INDEX$/, '');
    if (!symbol || !exch) return null;
    let sym = (symbol || '').toUpperCase();
    if (sym.includes(':')) {
      sym = sym.split(':').pop();
    }
    return sym ? `${exch}|${sym}` : null;
  }

  computeChangePercent(quote) {
    if (quote?.ltp !== undefined && quote?.prev_close !== undefined && quote.prev_close > 0) {
      return ((quote.ltp - quote.prev_close) / quote.prev_close) * 100;
    }
    if (quote?.change_percent !== undefined) {
      return quote.change_percent;
    }
    if (quote?.changePercent !== undefined) {
      return quote.changePercent;
    }
    return null;
  }

  applyQuoteUpdate(quote) {
    if (!quote) return;
    const exchange = quote.exchange || quote.exch || quote.exchange_segment || quote.exchangeSegment;
    const keys = new Set();
    [quote.symbol, quote.trading_symbol, quote.tradingSymbol, quote.tradingsymbol].forEach((sym) => {
      const key = this.buildQuoteKey(exchange, sym);
      if (key) keys.add(key);
    });

    if (!keys.size) return;

    const changePercent = this.computeChangePercent(quote);
    keys.forEach((key) => {
      const ltpNodes = document.querySelectorAll(`[data-quote-key="${key}"][data-quote-role="ltp"]`);
      ltpNodes.forEach((node) => {
        if (quote.ltp !== undefined) {
          node.textContent = `₹${Utils.formatNumber(quote.ltp)}`;
          node.classList.remove('text-neutral-400');
        }
      });

      if (changePercent !== null) {
        const changeNodes = document.querySelectorAll(`[data-quote-key="${key}"][data-quote-role="change"]`);
        changeNodes.forEach((node) => {
          const changeText = `${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(2)}%`;
          node.textContent = changeText;
          node.classList.remove('text-profit', 'text-loss', 'text-neutral-500');
          node.classList.add(changePercent > 0 ? 'text-profit' : (changePercent < 0 ? 'text-loss' : 'text-neutral-500'));
        });
      }
    });
  }

  async refreshFuturesPreview(symbolId) {
    const container = document.getElementById(`futures-preview-${symbolId}`);
    if (!container) return;

    const tradeMode = this.selectedTradeModes.get(symbolId) || 'EQUITY';
    if (tradeMode !== 'FUTURES') {
      container.innerHTML = '<p class="text-sm text-neutral-500">Switch to Futures mode to view the contract quote.</p>';
      this.stopFuturesPreviewPolling(symbolId);
      return;
    }

    const expiry = this.selectedExpiries.get(symbolId);
    if (!expiry) {
      container.innerHTML = '<p class="text-sm text-warning">Select an expiry to view the futures quote.</p>';
      return;
    }

    const requestId = (this.futuresPreviewRequestIds.get(symbolId) || 0) + 1;
    this.futuresPreviewRequestIds.set(symbolId, requestId);

    if (!container.dataset.loaded) {
      container.innerHTML = '<p class="text-sm text-neutral-500">Loading futures quote…</p>';
    }

    try {
      const response = await api.getQuickOrderFuturesPreview({ symbolId, expiry });
      if (this.futuresPreviewRequestIds.get(symbolId) !== requestId) {
        return;
      }

      const preview = response?.data || response;
      this.renderFuturesPreview(symbolId, preview);
      container.dataset.loaded = 'true';
    } catch (error) {
      if (this.futuresPreviewRequestIds.get(symbolId) !== requestId) {
        return;
      }
      const message = error?.message || 'Failed to load futures quote';
      container.innerHTML = `<p class="text-sm text-error">${Utils.escapeHTML(message)}</p>`;
    }
  }

  renderFuturesPreview(symbolId, preview) {
    const container = document.getElementById(`futures-preview-${symbolId}`);
    if (!container) {
      return;
    }

    if (!preview) {
      container.innerHTML = '<p class="text-sm text-error">Futures quote unavailable.</p>';
      return;
    }

    const expiryLabel = preview.expiry ? this.formatExpiryDate(preview.expiry) : 'N/A';
    const futLtp = preview.quote?.ltp ?? preview.quote?.lastPrice ?? preview.quote?.last_price ?? preview.quote?.price;
    const ltp = futLtp != null ? `₹${Utils.formatNumber(futLtp)}` : '—';
    const changePercent = preview.quote?.changePercent ?? preview.quote?.change_percent;
    const changeText = typeof changePercent === 'number'
      ? `${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(2)}%`
      : '—';
    const changeClass = typeof changePercent === 'number'
      ? (changePercent > 0 ? 'text-profit' : (changePercent < 0 ? 'text-loss' : 'text-neutral-500'))
      : 'text-neutral-500';
    const quoteKey = this.buildQuoteKey(
      preview.quote?.exchange || preview.exchange,
      preview.quote?.symbol || preview.tradingSymbol || preview.futuresSymbol
    );
    const sourceBadge = this.renderQuoteSourceBadge(preview.quote?.source);
    const refreshedLabel = preview.quote?.fetchedAt
      ? `Refreshed ${Utils.formatDateTime(new Date(preview.quote.fetchedAt).toISOString(), true)}`
      : preview.updatedAt
        ? `Refreshed ${Utils.formatDateTime(new Date(preview.updatedAt).toISOString(), true)}`
        : '';

    container.innerHTML = `
      <div class="flex items-center justify-between gap-2 text-xs mb-1">
        <div class="font-semibold text-base-content">
          Contract | <span class="text-neutral-700">${Utils.escapeHTML(preview.tradingSymbol || preview.futuresSymbol)}</span> • Expiry <span class="text-neutral-700">${expiryLabel}</span> ${sourceBadge}
        </div>
        ${refreshedLabel ? `<span class="text-neutral-500 whitespace-nowrap">${Utils.escapeHTML(refreshedLabel)}</span>` : ''}
      </div>
      <div class="flex items-baseline gap-2">
        <span class="text-lg font-semibold ${changeClass}" ${quoteKey ? `data-quote-key="${Utils.escapeHTML(quoteKey)}" data-quote-role="ltp"` : ''}>${ltp}</span>
      </div>
    `;
  }
}.prototype));
