/**
 * Simplifyed Admin V2 - Quick Order: placeOrder + getSymbolCapabilities.
 */

const QUICK_ORDER_QUICK_TRADE_MODE_KEY = 'quickOrderQuickTradeMode';

// Only actions whose broker-side direction is knowable without checking the existing position
// (or operatingMode for options) - EXIT/EXIT_ALL/REDUCE_*/INCREASE_*/CLOSE_ALL_* depend on
// context this function doesn't have, so they're deliberately not mapped here and skip the WS
// fuzzy pre-check below rather than risk a wrong side guess.
function resolveSimpleOrderSide(action) {
  const a = (action || '').toUpperCase();
  if (a === 'BUY' || a === 'BUY_CE' || a === 'BUY_PE' || a === 'COVER') return 'BUY';
  if (a === 'SELL' || a === 'SELL_CE' || a === 'SELL_PE' || a === 'SHORT') return 'SELL';
  return null;
}

Object.defineProperties(QuickOrderHandler.prototype, Object.getOwnPropertyDescriptors(class {
  // Off by default - a confirm dialog stays the safe default before a live order fires; a
  // trader opts into skipping it once they've verified their setup (mirrors strategy-builder.js).
  isQuickTradeMode() {
    try {
      return localStorage.getItem(QUICK_ORDER_QUICK_TRADE_MODE_KEY) === 'true';
    } catch (_) {
      return false;
    }
  }

  toggleQuickTradeMode() {
    const enabled = !this.isQuickTradeMode();
    try {
      localStorage.setItem(QUICK_ORDER_QUICK_TRADE_MODE_KEY, enabled ? 'true' : 'false');
    } catch (_) {
      // ignore localStorage errors (private mode, etc.)
    }
    const btn = document.getElementById('quick-trade-mode-btn');
    if (btn) btn.textContent = `Quick Trade Mode: ${enabled ? 'On' : 'Off'}`;
    Utils.showToast(
      enabled
        ? 'Quick Trade Mode on - Buy/Sell now fire immediately, no confirmation'
        : 'Quick Trade Mode off - Buy/Sell will ask for confirmation again',
      enabled ? 'warning' : 'info'
    );
  }

  /**
   * Place quick order
   */
  async placeOrder(watchlistId, symbolId, action) {
    try {
      const symbolRow = document.querySelector(`tr[data-symbol-id="${symbolId}"]`);
      if (!symbolRow) {
        throw new Error('Symbol row not found in DOM');
      }

      const symbol = symbolRow.dataset.symbol;
      const exchange = symbolRow.dataset.exchange;

    const tradeMode = this.selectedTradeModes.get(symbolId) || 'EQUITY';
    const optionsLeg = this.selectedOptionsLegs.get(symbolId) || 'ATM';
    const quantity = this.defaultQuantities.get(symbolId) || 1;
    const selectedExpiry = this.selectedExpiries.get(symbolId);
    const operatingMode = this.operatingModes.get(symbolId) || 'BUYER';
    const strikePolicy = this.strikePolicies.get(symbolId) || 'FLOAT_OFS';
    const stepLots = this.stepLots.get(symbolId) || quantity;
    const selectedProduct = this.selectedProducts.get(symbolId) || 'MIS';

      // debug removed

      if (!quantity || quantity <= 0) {
        Utils.showToast('Quantity must be greater than 0', 'error');
        return;
      }

      if (!this.isQuickTradeMode()) {
        const actionLabel = action.replace(/_/g, ' ');
        const confirmed = await Utils.confirm(
          `Place ${actionLabel} order for ${quantity} x ${symbol} (${tradeMode})?`,
          'Confirm Order'
        );
        if (!confirmed) return;
      }

      const orderData = {
        symbolId,
        action,
        tradeMode,
        quantity,
        product: selectedProduct,
      };

      if ((tradeMode === 'FUTURES' || tradeMode === 'OPTIONS') && selectedExpiry) {
        orderData.expiry = this.normalizeExpiryDate(selectedExpiry);
        // debug: removed noisy log
      }

      const optionActions = [
        'BUY_CE', 'SELL_CE', 'BUY_PE', 'SELL_PE',
        'REDUCE_CE', 'REDUCE_PE', 'INCREASE_CE', 'INCREASE_PE',
        'CLOSE_ALL_CE', 'CLOSE_ALL_PE'
      ];
      if (tradeMode === 'OPTIONS' && optionActions.includes(action)) {
        orderData.optionsLeg = optionsLeg;
      }

      if (tradeMode === 'OPTIONS') {
        orderData.operatingMode = operatingMode;
        orderData.strikePolicy = strikePolicy;
        orderData.stepLots = stepLots;
        // debug removed
      }

      // debug removed

      const actionButtons = document.querySelectorAll(`#expansion-content-${symbolId} .btn-quick-action, #expansion-content-${symbolId} .btn-action-compact`);
      actionButtons.forEach(btn => {
        btn.disabled = true;
        btn.classList.remove('loading'); // avoid global .loading conflicts
        btn.classList.add('is-loading');
        if (!btn.dataset.originalText) {
          btn.dataset.originalText = btn.textContent;
        }
        btn.textContent = 'Placing...';
      });

      // A lost/5xx response on the FIRST attempt is genuinely ambiguous (did the broker see it or
      // not?) - but request_id makes a same-payload RETRY safe regardless: the backend's
      // idempotency layer (idempotency_keys table) returns the original result if the first
      // attempt actually landed, instead of placing a second live order. One retry only, after a
      // short pause - if that's also ambiguous, stop and tell the trader rather than looping.
      const requestId = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `qo-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      orderData.request_id = requestId;

      let response;
      try {
        response = await api.placeQuickOrder(orderData);
      } catch (err) {
        const status = err?.status ?? 0;
        if (status === 0 || status >= 500) {
          // Fast path: check the order-update push feed before falling back to a REST retry -
          // advisory only (fuzzy match, no orderid to key off since that's exactly what the lost
          // response would have told us), so a miss or an ambiguous action just falls through to
          // the REST idempotent retry below, unchanged from before.
          const side = resolveSimpleOrderSide(action);
          if (side) {
            const wsMatch = await app.waitForOrderUpdateMatch({ symbol, exchange, side, quantity }, 1500);
            if (wsMatch) {
              const filled = wsMatch.order?.filled_quantity || quantity;
              Utils.showToast(`Order confirmed via broker feed (${filled} filled) - no retry needed`, 'success');
              return;
            }
          }

          await new Promise((resolve) => setTimeout(resolve, 800));
          try {
            response = await api.placeQuickOrder(orderData); // same request_id - idempotency-safe
          } catch (retryErr) {
            const retryStatus = retryErr?.status ?? 0;
            if (retryStatus === 409) {
              Utils.showToast(
                'Order request already submitted or still processing. Check the order book before placing again.',
                'warning'
              );
              return;
            }
            if (retryStatus === 0 || retryStatus >= 500) {
              Utils.showToast(
                `Order status still unknown after retry (${retryErr.message}). Check the order book before placing again - do not resubmit blindly.`,
                'error'
              );
              return;
            }
            throw retryErr;
          }
        } else {
          throw err;
        }
      }

      if (response && response.data && response.data.summary) {
        const { successful, failed, total, uncertain = 0 } = response.data.summary;
        const instanceCount = Array.isArray(response.data.results)
          ? new Set(response.data.results.map(r => r.instance_name || r.instance_id || 'inst')).size
          : null;
        if (successful > 0) {
          const unknownSuffix = uncertain > 0 ? `, ${uncertain} unknown` : '';
          Utils.showToast(
            `Order placed: ${successful}/${total} successful${unknownSuffix}${instanceCount ? ` across ${instanceCount} instance(s)` : ''}`,
            failed > 0 ? 'warning' : 'success'
          );
        } else if (uncertain > 0) {
          Utils.showToast(
            `Order status unknown for ${uncertain} instance(s). Check orderbook.`,
            'warning'
          );
        } else {
          Utils.showToast('All orders failed', 'error');
        }
      } else if (response) {
        Utils.showToast('Order placed successfully', 'success');
      }

      // debug removed

      if (response.data.results) {
        response.data.results.forEach((result, index) => {
          if (!result.success) {
            console.error(`[QuickOrder] Order ${index + 1} FAILED:`, {
              message: result.message,
              error: result.error,
              fullResult: result,
            });
          } else {
            // debug removed
          }
        });
      }
    } catch (error) {
      console.error('Quick order failed:', error);
      Utils.showToast(`Order failed: ${error.message}`, 'error');
    } finally {
      const actionButtons = document.querySelectorAll(`#expansion-content-${symbolId} .btn-quick-action, #expansion-content-${symbolId} .btn-action-compact`);
      actionButtons.forEach(btn => {
        btn.disabled = false;
        btn.classList.remove('loading');
        btn.classList.remove('is-loading');
        if (btn.dataset.originalText) {
          btn.textContent = btn.dataset.originalText;
          delete btn.dataset.originalText;
        }
      });
      this.refreshPositionsAfterOrder();
    }
  }

  /**
   * Derive trade capabilities from DOM row
   */
  getSymbolCapabilities(row) {
    const dataset = row?.dataset || {};
    const symbolType = (dataset.symbolType || '').toUpperCase();
    const parse = (value, fallback) => {
      if (value === undefined) return fallback;
      return value === '1' || value === 'true';
    };

    const defaults = {
      equity: true,
      futures: ['INDEX', 'EQUITY_FNO', 'FUTURES'].includes(symbolType),
      options: ['INDEX', 'EQUITY_FNO', 'OPTIONS'].includes(symbolType),
    };

    return {
      symbolType,
      equity: parse(dataset.tradableEquity, defaults.equity),
      futures: parse(dataset.tradableFutures, defaults.futures),
      options: parse(dataset.tradableOptions, defaults.options),
    };
  }
}.prototype));
