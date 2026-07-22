/**
 * Strategy Builder
 * Renders a "Strategies" section under each (non-broadcast) watchlist card: list, create,
 * add legs, and a manual "Execute" scalping-style button per strategy - mirrors the existing
 * watchlist quick-order button conventions in quick-order.js.
 */

const QUICK_TRADE_MODE_STORAGE_KEY = 'strategyQuickTradeMode';
const ALLOW_SCALE_IN_STORAGE_KEY = 'strategyAllowScaleIn';

class StrategyBuilder {
  constructor() {
    this.strategiesByWatchlist = new Map(); // watchlistId -> strategies[]
    this.expandedStrategies = new Set(); // strategyId
    this.legsByStrategy = new Map(); // strategyId -> legs[]
  }

  // Off by default - confirmation modals stay the safe default; a user opts into skipping them.
  isQuickTradeMode() {
    try {
      return localStorage.getItem(QUICK_TRADE_MODE_STORAGE_KEY) === 'true';
    } catch (_) {
      return false;
    }
  }

  toggleQuickTradeMode(enabled) {
    try {
      localStorage.setItem(QUICK_TRADE_MODE_STORAGE_KEY, enabled ? 'true' : 'false');
    } catch (_) {
      // ignore localStorage errors (private mode, etc.)
    }
    Utils.showToast(
      enabled
        ? 'Quick Trade Mode on - Execute/Exit now fire immediately, no confirmation'
        : 'Quick Trade Mode off - Execute/Exit will ask for confirmation again',
      enabled ? 'warning' : 'info'
    );
  }

  // Off by default - Execute normally skips any leg that already has an open position, to guard
  // against an accidental double-click duplicating an order. Enabling this opts out of that
  // guard so Execute clicks deliberately add to an already-open leg (scale in) instead.
  isAllowScaleIn() {
    try {
      return localStorage.getItem(ALLOW_SCALE_IN_STORAGE_KEY) === 'true';
    } catch (_) {
      return false;
    }
  }

  toggleAllowScaleIn(enabled) {
    try {
      localStorage.setItem(ALLOW_SCALE_IN_STORAGE_KEY, enabled ? 'true' : 'false');
    } catch (_) {
      // ignore localStorage errors (private mode, etc.)
    }
    Utils.showToast(
      enabled
        ? 'Scale-In allowed - Execute will now add to an already-open leg instead of skipping it'
        : 'Scale-In off - Execute will skip legs that already have an open position again',
      enabled ? 'warning' : 'info'
    );
  }

  async loadStrategies(watchlistId) {
    try {
      const res = await api.getStrategies(watchlistId);
      const strategies = Array.isArray(res?.data) ? res.data : [];
      this.strategiesByWatchlist.set(watchlistId, strategies);
      return strategies;
    } catch (error) {
      console.error('Failed to load strategies', error);
      return [];
    }
  }

  async renderStrategiesSection(watchlistId) {
    const strategies = await this.loadStrategies(watchlistId);

    const rows = strategies.length
      ? strategies.map((s) => this._renderStrategyRow(watchlistId, s)).join('')
      : '<p class="text-neutral-600 text-sm p-2">No strategies yet.</p>';

    const quickTradeChecked = this.isQuickTradeMode() ? 'checked' : '';
    const allowScaleInChecked = this.isAllowScaleIn() ? 'checked' : '';

    return `
      <div class="strategies-section" id="strategies-section-${watchlistId}">
        <div class="strategies-section__header">
          <h5 class="strategies-section__title">Strategies</h5>
          <label class="text-sm text-neutral-500" style="display: flex; align-items: center; gap: 6px; cursor: pointer;" title="When on, Execute/Exit (whole strategy and per-leg) fire immediately with no confirmation dialog.">
            <input type="checkbox" class="form-checkbox" ${quickTradeChecked} onchange="strategyBuilder.toggleQuickTradeMode(this.checked)">
            Quick Trade Mode
          </label>
          <label class="text-sm text-neutral-500" style="display: flex; align-items: center; gap: 6px; cursor: pointer;" title="When on, Execute adds to a leg that already has an open position instead of skipping it (scale in). Off by default to guard against accidental double-clicks duplicating an order.">
            <input type="checkbox" class="form-checkbox" ${allowScaleInChecked} onchange="strategyBuilder.toggleAllowScaleIn(this.checked)">
            Allow Scale-In
          </label>
          <button class="btn btn-buy btn-sm" onclick="strategyBuilder.showCreateStrategyModal(${watchlistId})">
            + New Strategy
          </button>
        </div>
        <div class="strategies-section__list">
          ${rows}
        </div>
      </div>
    `;
  }

  _renderStrategyRow(watchlistId, strategy) {
    const legCount = strategy.leg_count ?? strategy.legs?.length ?? 0;
    const triggerBadge = strategy.entry_trigger === 'WEBHOOK'
      ? `<span class="watchlist-card-compact__badge info">Webhook</span>`
      : '';
    const isExpanded = this.expandedStrategies.has(strategy.id);
    return `
      <div class="strategy-row-wrapper" data-strategy-id="${strategy.id}">
        <div class="strategy-row">
          <button class="btn-icon-compact" onclick="strategyBuilder.toggleLegs(${strategy.id}, ${watchlistId})" title="${isExpanded ? 'Collapse' : 'Expand'} legs">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" style="${isExpanded ? 'transform: rotate(90deg);' : ''}">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
            </svg>
          </button>
          <div class="strategy-row__info">
            <span class="strategy-row__name">${Utils.escapeHTML(strategy.name)}</span>
            <span class="strategy-row__meta">${Utils.escapeHTML(strategy.exchange)}:${Utils.escapeHTML(strategy.underlying)} • ${legCount} leg(s) • Tag: ${Utils.escapeHTML(strategy.broker_tag || `strategy-${strategy.id}`)}</span>
            ${triggerBadge}
          </div>
          <div class="strategy-row__actions">
            <button class="btn-icon-compact" onclick="strategyBuilder.showEditStrategyModal(${strategy.id}, ${watchlistId})" title="Edit">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </button>
            <button class="btn-icon-compact" onclick="strategyBuilder.showAddLegModal(${strategy.id}, ${watchlistId})" title="Add Leg">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
              </svg>
            </button>
            <button class="btn btn-buy btn-sm" onclick="strategyBuilder.showExecuteModal(${strategy.id}, ${watchlistId})">
              Execute
            </button>
            <button class="btn btn-sell btn-sm" onclick="strategyBuilder.showExitModal(${strategy.id}, ${watchlistId})">
              Exit All
            </button>
            <button class="btn-icon-compact danger" onclick="strategyBuilder.deleteStrategy(${strategy.id}, ${watchlistId})" title="Delete">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </div>
        </div>
        <div class="strategy-legs" id="strategy-legs-${strategy.id}" style="${isExpanded ? '' : 'display: none;'}">
          ${isExpanded ? '<p class="text-neutral-600 text-sm p-2">Loading legs...</p>' : ''}
        </div>
      </div>
    `;
  }

  async toggleLegs(strategyId, watchlistId) {
    const container = document.getElementById(`strategy-legs-${strategyId}`);
    if (!container) return;

    if (this.expandedStrategies.has(strategyId)) {
      this.expandedStrategies.delete(strategyId);
      container.style.display = 'none';
      return;
    }

    this.expandedStrategies.add(strategyId);
    container.style.display = '';
    container.innerHTML = '<p class="text-neutral-600 text-sm p-2">Loading legs...</p>';
    await this._loadAndRenderLegs(strategyId, watchlistId);
  }

  async _loadAndRenderLegs(strategyId, watchlistId) {
    const container = document.getElementById(`strategy-legs-${strategyId}`);
    if (!container) return;
    try {
      const res = await api.getStrategy(strategyId);
      const legs = Array.isArray(res?.data?.legs) ? res.data.legs : [];
      this.legsByStrategy.set(strategyId, legs);
      const legsHtml = legs.length
        ? legs.map((leg) => this._renderLegRow(watchlistId, strategyId, leg)).join('')
        : '<p class="text-neutral-600 text-sm p-2">No legs yet. Use the + button to add one.</p>';
      container.innerHTML = legsHtml + '<div id="strategy-execution-status-' + strategyId + '"></div>';
      await this._loadAndRenderExecutionStatus(strategyId);
    } catch (error) {
      container.innerHTML = `<p class="text-neutral-600 text-sm p-2">Failed to load legs: ${Utils.escapeHTML(error.message || 'unknown error')}</p>`;
    }
  }

  _renderLegRow(watchlistId, strategyId, leg) {
    const instrument = leg.option_type
      ? `${leg.action} ${leg.option_type} ${leg.strike_offset || 'ATM'} (${leg.strike_policy || 'FLOAT_OFS'})`
      : `${leg.action} (Futures/Equity)`;
    const qty = leg.qty_type === 'MARGIN_BASED'
      ? `Margin ${leg.qty_value ?? 1} util`
      : `${leg.qty_value ?? 1} ${leg.qty_type === 'FIXED' ? 'qty' : 'lots'}`;
    const exitParts = [];
    if (leg.target_points != null) exitParts.push(`T:${leg.target_points}`);
    if (leg.stoploss_points != null) exitParts.push(`SL:${leg.stoploss_points}`);
    if (leg.trailing_stoploss_points != null) exitParts.push(`TSL:${leg.trailing_stoploss_points}`);
    const exitMechanismLabel = leg.exit_mechanism === 'GTT' ? ' (GTT)' : '';
    const exitSummary = (exitParts.length ? exitParts.join(' ') : 'No exit config') + exitMechanismLabel;
    const tagSuffix = leg.leg_tag ? ` • Tag: ${Utils.escapeHTML(leg.leg_tag)}` : '';

    const greeksButton = leg.option_type
      ? `<button class="btn-icon-compact" onclick="strategyBuilder.showGreeks(${leg.id}, ${watchlistId}, this)" title="Preview Greeks (fetches live, on demand)">Δ</button>`
      : '';

    return `
      <div class="strategy-leg-row" data-leg-id="${leg.id}">
        <div class="strategy-leg-row__info">
          <span class="strategy-leg-row__instrument">${Utils.escapeHTML(instrument)}</span>
          <span class="strategy-leg-row__meta">${Utils.escapeHTML(qty)} • ${Utils.escapeHTML(leg.product_type || 'MIS')} • ${Utils.escapeHTML(exitSummary)}${tagSuffix}</span>
          <span class="strategy-leg-row__greeks" id="leg-greeks-${leg.id}"></span>
        </div>
        <div class="strategy-leg-row__actions">
          ${greeksButton}
          <button class="btn btn-buy btn-sm" onclick="strategyBuilder.showExecuteLegModal(${leg.id}, ${strategyId}, ${watchlistId})" title="Enter just this leg">
            Enter
          </button>
          <button class="btn btn-sell btn-sm" onclick="strategyBuilder.showExitLegModal(${leg.id}, ${strategyId}, ${watchlistId})" title="Exit just this leg">
            Exit
          </button>
          <button class="btn-icon-compact" onclick="strategyBuilder.showEditLegModal(${leg.id}, ${strategyId}, ${watchlistId})" title="Edit Leg">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          </button>
          <button class="btn-icon-compact danger" onclick="strategyBuilder.deleteLeg(${leg.id}, ${strategyId}, ${watchlistId})" title="Delete Leg">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      </div>
    `;
  }

  // Live execution status: what actually got resolved/placed/closed per leg per instance, from
  // the strategy_leg_executions ledger - read-only, uses cached position/quote data server-side
  // (no live broker calls triggered by viewing this).
  async _loadAndRenderExecutionStatus(strategyId) {
    const target = document.getElementById(`strategy-execution-status-${strategyId}`);
    if (!target) return;
    try {
      const res = await api.getStrategyStatus(strategyId);
      const status = res?.data;
      target.innerHTML = this._renderExecutionStatusTable(status);
    } catch (error) {
      target.innerHTML = '';
    }
  }

  _renderExecutionStatusTable(status) {
    if (!status?.hasExecutions) return '';
    const rows = (status.executions || []).map((e) => {
      const legLabel = e.legOptionType ? `${e.legAction} ${e.legOptionType}` : (e.legAction || '-');
      const pnlClass = e.pnl > 0 ? 'text-success' : e.pnl < 0 ? 'text-error' : '';
      const pnlText = e.pnl != null ? e.pnl.toFixed(2) : '-';
      const statusText = e.isOpen ? 'OPEN' : (e.exitStatus || 'CLOSED');
      const statusClass = e.isOpen ? 'text-success' : 'text-neutral-500';
      return `
        <tr>
          <td>${Utils.escapeHTML(legLabel)}</td>
          <td>${Utils.escapeHTML(e.instanceName)}</td>
          <td>${Utils.escapeHTML(e.resolvedSymbol)}</td>
          <td>${e.quantity}</td>
          <td>${e.ltp != null ? e.ltp : '-'}</td>
          <td class="${pnlClass}">${pnlText}</td>
          <td class="${statusClass}">${Utils.escapeHTML(statusText)}</td>
        </tr>
      `;
    }).join('');

    return `
      <div class="strategy-execution-status">
        <h6 class="strategy-execution-status__title">Live Execution</h6>
        <table class="strategy-execution-status__table">
          <thead>
            <tr><th>Leg</th><th>Instance</th><th>Symbol</th><th>Qty</th><th>LTP</th><th>P&amp;L</th><th>Status</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  // On-demand only (no automatic/background fetching) - resolves the leg's exact contract via
  // the first watchlist-assigned instance, then fetches Greeks for it. Two live broker calls per
  // click, intentionally opt-in given this app's broker-rate-limit sensitivity.
  async showGreeks(legId, watchlistId, buttonEl) {
    const target = document.getElementById(`leg-greeks-${legId}`);
    if (!target) return;
    const originalLabel = buttonEl.textContent;
    buttonEl.textContent = '...';
    buttonEl.disabled = true;
    try {
      const wlRes = await api.getWatchlistById(watchlistId);
      const instance = (wlRes?.data?.instances || [])[0];
      if (!instance) {
        Utils.showToast('No instance assigned to this watchlist', 'warning');
        return;
      }
      const previewRes = await api.previewStrategyLeg(legId, instance.id);
      const { symbol, exchange } = previewRes?.data || {};
      if (!symbol || !exchange) {
        Utils.showToast('Could not resolve this leg to a live contract', 'warning');
        return;
      }
      const greeksRes = await api.getOptionGreeks({ symbol, exchange, instanceId: instance.id });
      const g = greeksRes?.data?.greeks;
      if (!g) {
        Utils.showToast('Greeks unavailable for this contract', 'warning');
        return;
      }
      target.textContent = `Δ${g.delta?.toFixed(2)} Γ${g.gamma?.toFixed(4)} Θ${g.theta?.toFixed(2)} V${g.vega?.toFixed(2)}`;
    } catch (error) {
      Utils.showToast(error.message || 'Failed to fetch Greeks', 'error');
    } finally {
      buttonEl.textContent = originalLabel;
      buttonEl.disabled = false;
    }
  }

  async deleteLeg(legId, strategyId, watchlistId) {
    if (!confirm('Delete this leg?')) return;
    try {
      await api.deleteStrategyLeg(legId);
      Utils.showToast('Leg deleted', 'success');
      await this._loadAndRenderLegs(strategyId, watchlistId);
      await this._refreshLegCountOnly(strategyId, watchlistId);
    } catch (error) {
      Utils.showToast(error.message || 'Failed to delete leg', 'error');
    }
  }

  // Updates just the leg-count text in the collapsed row header without collapsing the
  // already-expanded legs list (refreshSection() would re-render and reset expansion state).
  async _refreshLegCountOnly(strategyId, watchlistId) {
    const strategies = await this.loadStrategies(watchlistId);
    const strategy = strategies.find((s) => s.id === strategyId);
    const metaEl = document.querySelector(`.strategy-row-wrapper[data-strategy-id="${strategyId}"] .strategy-row__meta`);
    if (metaEl && strategy) {
      const legCount = strategy.leg_count ?? 0;
      metaEl.textContent = `${strategy.exchange}:${strategy.underlying} • ${legCount} leg(s)`;
    }
  }

  async refreshSection(watchlistId) {
    const container = document.getElementById(`strategies-section-${watchlistId}`);
    if (!container) return;
    container.outerHTML = await this.renderStrategiesSection(watchlistId);
  }

  async showCreateStrategyModal(watchlistId) {
    // Strategies live exclusively on strategy-type watchlists (never standard/broadcast), which
    // never have pre-existing watchlist_symbols rows - createStrategy auto-seeds the anchor row
    // server-side from whatever underlying/exchange is submitted here, so this is always a
    // free-text input rather than a dropdown of existing symbols.
    const modal = document.createElement('div');
    modal.className = 'modal-overlay strategy-modal';
    modal.innerHTML = `
      <div class="modal-content" style="max-width: 480px;">
        <div class="modal-header"><h3>New Strategy</h3></div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">Name</label>
            <input type="text" id="strategy-name-input" class="form-input" placeholder="e.g. NIFTY Short Straddle">
          </div>
          <div class="form-group">
            <label class="form-label">Underlying Symbol</label>
            <input type="text" id="strategy-underlying-input" class="form-input" placeholder="e.g. NIFTY, NATURALGAS">
          </div>
          <div class="form-group">
            <label class="form-label">Exchange</label>
            <select id="strategy-exchange-select" class="form-input">
              <option value="NSE_INDEX">NSE_INDEX</option>
              <option value="NSE">NSE</option>
              <option value="BSE_INDEX">BSE_INDEX</option>
              <option value="BSE">BSE</option>
              <option value="MCX">MCX</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Entry Trigger</label>
            <select id="strategy-trigger-input" class="form-input">
              <option value="MANUAL">Manual</option>
              <option value="WEBHOOK">TradingView Webhook</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Broker Tag (optional)</label>
            <input type="text" id="strategy-broker-tag-input" class="form-input" placeholder="Auto: strategy-&lt;id&gt;">
            <p class="text-sm text-neutral-500" style="margin-top: 4px;">Shown as the "strategy" field in OpenAlgo order/logs and as the Order History correlation id prefix. Leave blank to auto-generate.</p>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-neutral btn-outline" onclick="strategyBuilder.closeModal()">Cancel</button>
          <button class="btn btn-buy" onclick="strategyBuilder.submitCreateStrategy(${watchlistId})">Create</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    this.activeModal = modal;
    document.getElementById('strategy-name-input').focus();
  }

  async submitCreateStrategy(watchlistId) {
    const name = document.getElementById('strategy-name-input').value.trim();
    const entryTrigger = document.getElementById('strategy-trigger-input').value;
    const brokerTag = document.getElementById('strategy-broker-tag-input').value.trim();
    const underlying = document.getElementById('strategy-underlying-input').value.trim();
    const exchange = document.getElementById('strategy-exchange-select').value;

    if (!name || !underlying || !exchange) {
      Utils.showToast('Name and underlying are required', 'warning');
      return;
    }

    try {
      await api.createStrategy({
        watchlist_id: watchlistId,
        name,
        underlying,
        exchange,
        entry_trigger: entryTrigger,
        ...(brokerTag ? { broker_tag: brokerTag } : {}),
      });
      Utils.showToast('Strategy created', 'success');
      this.closeModal();
      await this.refreshSection(watchlistId);
    } catch (error) {
      Utils.showToast(error.message || 'Failed to create strategy', 'error');
    }
  }

  showEditStrategyModal(strategyId, watchlistId) {
    const strategy = (this.strategiesByWatchlist.get(watchlistId) || []).find((s) => s.id === strategyId);
    if (!strategy) {
      Utils.showToast('Strategy not found', 'error');
      return;
    }

    // Every strategy lives on a strategy-type watchlist, which unconditionally supports both
    // trigger kinds - no per-watchlist gating needed here.
    const triggerOptionsHtml = `<option value="MANUAL" ${strategy.entry_trigger === 'MANUAL' ? 'selected' : ''}>Manual</option><option value="WEBHOOK" ${strategy.entry_trigger === 'WEBHOOK' ? 'selected' : ''}>TradingView Webhook</option>`;
    const triggerHint = '<p class="text-sm text-neutral-500" style="margin-top: 4px;">Switching to Manual revokes the current webhook URL - switching back to Webhook later generates a new one.</p>';

    const webhookUrl = strategy.webhook_slug
      ? `${window.location.origin.replace(/\/$/, '')}/webhook/tradingview/broadcast/${strategy.webhook_slug}`
      : null;
    // Unlike a watchlist's own broadcast webhook, a strategy webhook needs no symbol/exchange/
    // quantity fields at all - the strategy's legs already define every order to place, so the
    // request body only ever needs (optionally) an action.
    const entryPayload = '{\n  "action": "ENTRY"\n}';
    const exitPayload = '{\n  "action": "EXIT_ALL"\n}';
    const legPayload = '{\n  "action": "ENTRY",\n  "leg_tag": "put_leg"\n}';
    const escapeForCopy = (str) => str.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
    const webhookCardHtml = (strategy.entry_trigger === 'WEBHOOK' && strategy.webhook_slug) ? `
      <div class="form-group">
        <label class="form-label">Webhook</label>
        <div class="border border-base-200 rounded-lg p-3 space-y-2 bg-base-100">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p class="text-xs text-neutral-500">Slug</p>
              <code class="code-inline">${Utils.escapeHTML(strategy.webhook_slug)}</code>
            </div>
            <button class="btn btn-neutral btn-sm" type="button" onclick="Utils.copyToClipboard('${strategy.webhook_slug}')">Copy</button>
          </div>
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p class="text-xs text-neutral-500">Webhook URL</p>
              <code class="code-inline">${Utils.escapeHTML(webhookUrl)}</code>
            </div>
            <button class="btn btn-neutral btn-sm" type="button" onclick="Utils.copyToClipboard('${webhookUrl}')">Copy URL</button>
          </div>
          <p class="text-xs text-neutral-500">Send TradingView alerts with header <code>X-Webhook-Token</code>. No symbol/exchange/quantity fields needed - this strategy's legs already define what to trade.</p>
          <div class="flex items-center justify-between">
            <p class="text-xs text-neutral-500">Sample Payload - Entry (default action if omitted)</p>
            <button class="btn btn-neutral btn-sm" type="button" onclick="Utils.copyToClipboard('${escapeForCopy(entryPayload)}')">Copy JSON</button>
          </div>
          <pre class="code-block" style="white-space: pre-wrap;">${entryPayload}</pre>
          <div class="flex items-center justify-between">
            <p class="text-xs text-neutral-500">Sample Payload - Exit (closes every open leg)</p>
            <button class="btn btn-neutral btn-sm" type="button" onclick="Utils.copyToClipboard('${escapeForCopy(exitPayload)}')">Copy JSON</button>
          </div>
          <pre class="code-block" style="white-space: pre-wrap;">${exitPayload}</pre>
          <div class="flex items-center justify-between">
            <p class="text-xs text-neutral-500">Sample Payload - Single Leg (add a Leg Tag on a leg to target just it)</p>
            <button class="btn btn-neutral btn-sm" type="button" onclick="Utils.copyToClipboard('${escapeForCopy(legPayload)}')">Copy JSON</button>
          </div>
          <pre class="code-block" style="white-space: pre-wrap;">${legPayload}</pre>
        </div>
      </div>
    ` : '';

    const modal = document.createElement('div');
    modal.className = 'modal-overlay strategy-modal';
    modal.innerHTML = `
      <div class="modal-content" style="max-width: 480px;">
        <div class="modal-header"><h3>Edit Strategy</h3></div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">Name</label>
            <input type="text" id="strategy-edit-name-input" class="form-input" value="${Utils.escapeHTML(strategy.name)}">
          </div>
          <div class="form-group">
            <label class="form-label">Entry Trigger</label>
            <select id="strategy-edit-trigger-input" class="form-input">${triggerOptionsHtml}</select>
            ${triggerHint}
          </div>
          ${webhookCardHtml}
          <div class="form-group">
            <label class="form-label">Broker Tag</label>
            <input type="text" id="strategy-edit-broker-tag-input" class="form-input" value="${Utils.escapeHTML(strategy.broker_tag || `strategy-${strategy.id}`)}">
            <p class="text-sm text-neutral-500" style="margin-top: 4px;">Shown as the "strategy" field in OpenAlgo order/logs and as the Order History correlation id prefix. Must be unique across strategies.</p>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-neutral btn-outline" onclick="strategyBuilder.closeModal()">Cancel</button>
          <button class="btn btn-buy" onclick="strategyBuilder.submitEditStrategy(${strategyId}, ${watchlistId})">Save</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    this.activeModal = modal;
    document.getElementById('strategy-edit-name-input').focus();
  }

  async submitEditStrategy(strategyId, watchlistId) {
    const name = document.getElementById('strategy-edit-name-input').value.trim();
    const entryTrigger = document.getElementById('strategy-edit-trigger-input').value;
    const brokerTag = document.getElementById('strategy-edit-broker-tag-input').value.trim();

    if (!name || !brokerTag) {
      Utils.showToast('Name and broker tag are required', 'warning');
      return;
    }

    try {
      await api.updateStrategy(strategyId, { name, entry_trigger: entryTrigger, broker_tag: brokerTag });
      Utils.showToast('Strategy updated', 'success');
      this.closeModal();
      await this.refreshSection(watchlistId);
      // Reopen so a newly-generated (or just-revoked) webhook slug/URL is visible immediately
      // without a second manual click, per the switch just made above.
      if (entryTrigger === 'WEBHOOK') {
        this.showEditStrategyModal(strategyId, watchlistId);
      }
    } catch (error) {
      Utils.showToast(error.message || 'Failed to update strategy', 'error');
    }
  }

  _legFormBodyHtml(leg = {}) {
    const opt = (value, selected) => `<option value="${value}" ${selected ? 'selected' : ''}>${value || 'None (Futures/Equity)'}</option>`;
    return `
      <div class="form-group">
        <label class="form-label">Action</label>
        <select id="leg-action-input" class="form-input">
          <option value="SELL" ${leg.action === 'SELL' || !leg.action ? 'selected' : ''}>SELL</option>
          <option value="BUY" ${leg.action === 'BUY' ? 'selected' : ''}>BUY</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Option Type (leave blank for futures/equity)</label>
        <select id="leg-option-type-input" class="form-input">
          ${opt('', !leg.option_type)}
          ${opt('CE', leg.option_type === 'CE')}
          ${opt('PE', leg.option_type === 'PE')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Strike Offset</label>
        <select id="leg-strike-offset-input" class="form-input">
          ${['ATM', 'ITM1', 'ITM2', 'OTM1', 'OTM2'].map((o) => `<option value="${o}" ${leg.strike_offset === o ? 'selected' : ''}>${o}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Quantity Type</label>
        <select id="leg-qty-type-input" class="form-input">
          <option value="LOTS" ${leg.qty_type === 'LOTS' || !leg.qty_type ? 'selected' : ''}>Lots</option>
          <option value="FIXED" ${leg.qty_type === 'FIXED' ? 'selected' : ''}>Fixed Quantity</option>
          <option value="MARGIN_BASED" ${leg.qty_type === 'MARGIN_BASED' ? 'selected' : ''}>Margin-Based (utilization %)</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Quantity Value (lots / fixed qty / margin utilization 0-1)</label>
        <input type="number" step="0.01" id="leg-qty-value-input" class="form-input" value="${leg.qty_value ?? 1}">
      </div>
      <div class="form-group">
        <label class="form-label">Target (points)</label>
        <input type="number" id="leg-target-input" class="form-input" placeholder="optional" value="${leg.target_points ?? ''}">
      </div>
      <div class="form-group">
        <label class="form-label">Stoploss (points)</label>
        <input type="number" id="leg-stoploss-input" class="form-input" placeholder="optional" value="${leg.stoploss_points ?? ''}">
      </div>
      <div class="form-group">
        <label class="form-label">Trailing Stoploss (points)</label>
        <input type="number" id="leg-trailing-input" class="form-input" placeholder="optional" value="${leg.trailing_stoploss_points ?? ''}">
      </div>
      <div class="form-group">
        <label class="form-label">Product Type</label>
        <select id="leg-product-type-input" class="form-input">
          <option value="MIS" ${leg.product_type === 'MIS' || !leg.product_type ? 'selected' : ''}>MIS (intraday)</option>
          <option value="NRML" ${leg.product_type === 'NRML' ? 'selected' : ''}>NRML</option>
          <option value="CNC" ${leg.product_type === 'CNC' ? 'selected' : ''}>CNC</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Exit Mechanism</label>
        <select id="leg-exit-mechanism-input" class="form-input">
          <option value="POLLING" ${leg.exit_mechanism !== 'GTT' ? 'selected' : ''}>App-managed (polling)</option>
          <option value="GTT" ${leg.exit_mechanism === 'GTT' ? 'selected' : ''}>Broker GTT (requires NRML/CNC, not MIS)</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Leg Tag (optional)</label>
        <input type="text" id="leg-tag-input" class="form-input" placeholder="e.g. put_leg" value="${Utils.escapeHTML(leg.leg_tag || '')}">
        <p class="text-sm text-neutral-500" style="margin-top: 4px;">Lets a TradingView webhook alert target just this leg (<code>leg_tag</code> field) instead of the whole strategy. Must be unique within this strategy.</p>
      </div>
    `;
  }

  _readLegForm() {
    const optionType = document.getElementById('leg-option-type-input').value || null;
    const target = document.getElementById('leg-target-input').value;
    const stoploss = document.getElementById('leg-stoploss-input').value;
    const trailing = document.getElementById('leg-trailing-input').value;
    const legTag = document.getElementById('leg-tag-input').value.trim();
    return {
      action: document.getElementById('leg-action-input').value,
      option_type: optionType,
      strike_offset: optionType ? document.getElementById('leg-strike-offset-input').value : null,
      qty_type: document.getElementById('leg-qty-type-input').value,
      qty_value: parseFloat(document.getElementById('leg-qty-value-input').value),
      target_points: target ? parseFloat(target) : null,
      stoploss_points: stoploss ? parseFloat(stoploss) : null,
      trailing_stoploss_points: trailing ? parseFloat(trailing) : null,
      product_type: document.getElementById('leg-product-type-input').value,
      exit_mechanism: document.getElementById('leg-exit-mechanism-input').value,
      leg_tag: legTag || null,
    };
  }

  showAddLegModal(strategyId, watchlistId) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay strategy-modal';
    modal.innerHTML = `
      <div class="modal-content" style="max-width: 480px;">
        <div class="modal-header"><h3>Add Leg</h3></div>
        <div class="modal-body">${this._legFormBodyHtml()}</div>
        <div class="modal-footer">
          <button class="btn btn-neutral btn-outline" onclick="strategyBuilder.closeModal()">Cancel</button>
          <button class="btn btn-buy" onclick="strategyBuilder.submitAddLeg(${strategyId}, ${watchlistId})">Add Leg</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    this.activeModal = modal;
  }

  async submitAddLeg(strategyId, watchlistId) {
    try {
      await api.addStrategyLeg(strategyId, this._readLegForm());
      Utils.showToast('Leg added', 'success');
      this.closeModal();
      this.expandedStrategies.add(strategyId);
      await this._refreshLegCountOnly(strategyId, watchlistId);
      await this._loadAndRenderLegs(strategyId, watchlistId);
    } catch (error) {
      Utils.showToast(error.message || 'Failed to add leg', 'error');
    }
  }

  showEditLegModal(legId, strategyId, watchlistId) {
    const leg = (this.legsByStrategy.get(strategyId) || []).find((l) => l.id === legId);
    if (!leg) {
      Utils.showToast('Leg not found - try re-expanding the strategy', 'error');
      return;
    }

    const modal = document.createElement('div');
    modal.className = 'modal-overlay strategy-modal';
    modal.innerHTML = `
      <div class="modal-content" style="max-width: 480px;">
        <div class="modal-header"><h3>Edit Leg</h3></div>
        <div class="modal-body">${this._legFormBodyHtml(leg)}</div>
        <div class="modal-footer">
          <button class="btn btn-neutral btn-outline" onclick="strategyBuilder.closeModal()">Cancel</button>
          <button class="btn btn-buy" onclick="strategyBuilder.submitEditLeg(${legId}, ${strategyId}, ${watchlistId})">Save Changes</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    this.activeModal = modal;
  }

  async submitEditLeg(legId, strategyId, watchlistId) {
    try {
      await api.updateStrategyLeg(legId, this._readLegForm());
      Utils.showToast('Leg updated', 'success');
      this.closeModal();
      await this._loadAndRenderLegs(strategyId, watchlistId);
    } catch (error) {
      Utils.showToast(error.message || 'Failed to update leg', 'error');
    }
  }

  // Execution automatically targets every active instance assigned to the strategy's watchlist -
  // no instance picker. This confirmation just makes clear which instances will receive live
  // orders before the user commits (no live broker calls are made just to populate this dialog -
  // margin figures are shown after execution, as part of the result, not fetched up front).
  async showExecuteModal(strategyId, watchlistId) {
    if (this.isQuickTradeMode()) {
      Utils.showToast('Executing strategy...', 'info');
      return this.submitExecute(strategyId, watchlistId);
    }
    let watchlist;
    try {
      const res = await api.getWatchlistById(watchlistId);
      watchlist = res?.data;
    } catch (error) {
      Utils.showToast('Failed to load watchlist instances', 'error');
      return;
    }

    const instances = Array.isArray(watchlist?.instances) ? watchlist.instances : [];
    if (!instances.length) {
      Utils.showToast('No active instances are assigned to this watchlist - assign one first', 'warning');
      return;
    }

    const instanceList = instances.map((i) => `<li>${Utils.escapeHTML(i.name)}</li>`).join('');
    const scaleInWarning = this.isAllowScaleIn()
      ? '<p class="text-sm" style="color: var(--color-warning, #d97706);">Allow Scale-In is on - any leg that already has an open position will get an <strong>additional</strong> order on top of it, not be skipped.</p>'
      : '';

    const modal = document.createElement('div');
    modal.className = 'modal-overlay strategy-modal';
    modal.innerHTML = `
      <div class="modal-content" style="max-width: 420px;">
        <div class="modal-header"><h3>Execute Strategy</h3></div>
        <div class="modal-body">
          <p class="text-neutral-600 text-sm">This places live orders for every leg against <strong>all ${instances.length} instance(s)</strong> assigned to this watchlist:</p>
          <ul style="margin: var(--space-2) 0; padding-left: var(--space-5);">${instanceList}</ul>
          <p class="text-neutral-600 text-sm">Each instance's required margin is checked as part of execution and shown in the result.</p>
          ${scaleInWarning}
        </div>
        <div class="modal-footer">
          <button class="btn btn-neutral btn-outline" onclick="strategyBuilder.closeModal()">Cancel</button>
          <button class="btn btn-buy" onclick="strategyBuilder.submitExecute(${strategyId}, ${watchlistId})">Execute on All ${instances.length}</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    this.activeModal = modal;
  }

  async submitExecute(strategyId, watchlistId) {
    this.closeModal();
    try {
      const res = await api.executeStrategy(strategyId, { allowScaleIn: this.isAllowScaleIn() });
      const data = res?.data;
      const ok = data?.success;
      const instanceSummaries = (data?.instances || []).map((inst) => {
        const legOk = (inst.legs || []).filter((l) => l.success).length;
        const legTotal = (inst.legs || []).length;
        const margin = inst.marginPreview?.total_margin_required;
        const marginText = margin != null ? ` (margin: ${margin})` : '';
        return `${inst.instanceName}: ${legOk}/${legTotal} legs${marginText}`;
      });
      Utils.showToast(
        (ok ? 'Strategy executed: ' : 'Strategy executed with failures: ') + instanceSummaries.join(' | '),
        ok ? 'success' : 'warning'
      );
      if (this.expandedStrategies.has(strategyId)) {
        await this._loadAndRenderLegs(strategyId, watchlistId);
      }
    } catch (error) {
      Utils.showToast(error.message || 'Strategy execution failed', 'error');
    }
  }

  // Closes every still-open leg (per the strategy_leg_executions ledger) across every instance
  // assigned to the watchlist - same all-instances-at-once convention as Execute.
  async showExitModal(strategyId, watchlistId) {
    if (this.isQuickTradeMode()) {
      Utils.showToast('Exiting strategy...', 'info');
      return this.submitExit(strategyId, watchlistId);
    }
    let watchlist;
    try {
      const res = await api.getWatchlistById(watchlistId);
      watchlist = res?.data;
    } catch (error) {
      Utils.showToast('Failed to load watchlist instances', 'error');
      return;
    }

    const instances = Array.isArray(watchlist?.instances) ? watchlist.instances : [];
    const instanceList = instances.map((i) => `<li>${Utils.escapeHTML(i.name)}</li>`).join('');

    const modal = document.createElement('div');
    modal.className = 'modal-overlay strategy-modal';
    modal.innerHTML = `
      <div class="modal-content" style="max-width: 420px;">
        <div class="modal-header"><h3>Exit Strategy</h3></div>
        <div class="modal-body">
          <p class="text-neutral-600 text-sm">This closes every still-open leg of this strategy across <strong>all ${instances.length} instance(s)</strong> assigned to this watchlist:</p>
          <ul style="margin: var(--space-2) 0; padding-left: var(--space-5);">${instanceList}</ul>
          <p class="text-neutral-600 text-sm">Legs with no open position are skipped.</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-neutral btn-outline" onclick="strategyBuilder.closeModal()">Cancel</button>
          <button class="btn btn-sell" onclick="strategyBuilder.submitExit(${strategyId}, ${watchlistId})">Exit All Legs</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    this.activeModal = modal;
  }

  async submitExit(strategyId, watchlistId) {
    this.closeModal();
    try {
      const res = await api.exitStrategy(strategyId);
      const data = res?.data;
      const ok = data?.success;
      const instanceSummaries = (data?.instances || []).map((inst) => {
        const legOk = (inst.legs || []).filter((l) => l.success).length;
        const legTotal = (inst.legs || []).length;
        return `${inst.instanceName}: ${legOk}/${legTotal} legs closed`;
      });
      Utils.showToast(
        (ok ? 'Strategy exited: ' : 'Strategy exit had failures: ') + (instanceSummaries.join(' | ') || 'no open legs'),
        ok ? 'success' : 'warning'
      );
      if (this.expandedStrategies.has(strategyId)) {
        await this._loadAndRenderLegs(strategyId, watchlistId);
      }
    } catch (error) {
      Utils.showToast(error.message || 'Strategy exit failed', 'error');
    }
  }

  // Same convention as showExecuteModal, scoped to a single leg - places a live order for just
  // this leg against every instance assigned to the watchlist (the already-open-leg guard on the
  // backend still applies, so re-entering an already-live leg is a safe no-op, not a duplicate).
  async showExecuteLegModal(legId, strategyId, watchlistId) {
    if (this.isQuickTradeMode()) {
      Utils.showToast('Entering leg...', 'info');
      return this.submitExecuteLeg(legId, strategyId, watchlistId);
    }
    let watchlist;
    try {
      const res = await api.getWatchlistById(watchlistId);
      watchlist = res?.data;
    } catch (error) {
      Utils.showToast('Failed to load watchlist instances', 'error');
      return;
    }

    const instances = Array.isArray(watchlist?.instances) ? watchlist.instances : [];
    if (!instances.length) {
      Utils.showToast('No active instances are assigned to this watchlist - assign one first', 'warning');
      return;
    }

    const instanceList = instances.map((i) => `<li>${Utils.escapeHTML(i.name)}</li>`).join('');
    const allowScaleIn = this.isAllowScaleIn();
    const scaleInNote = allowScaleIn
      ? '<p class="text-sm" style="color: var(--color-warning, #d97706);">Allow Scale-In is on - instances where this leg is already open will get an <strong>additional</strong> order on top of it, not be skipped.</p>'
      : '<p class="text-neutral-600 text-sm">Instances where this leg is already open are skipped, not duplicated.</p>';

    const modal = document.createElement('div');
    modal.className = 'modal-overlay strategy-modal';
    modal.innerHTML = `
      <div class="modal-content" style="max-width: 420px;">
        <div class="modal-header"><h3>Enter Leg</h3></div>
        <div class="modal-body">
          <p class="text-neutral-600 text-sm">This places a live order for just this leg against <strong>all ${instances.length} instance(s)</strong> assigned to this watchlist:</p>
          <ul style="margin: var(--space-2) 0; padding-left: var(--space-5);">${instanceList}</ul>
          ${scaleInNote}
        </div>
        <div class="modal-footer">
          <button class="btn btn-neutral btn-outline" onclick="strategyBuilder.closeModal()">Cancel</button>
          <button class="btn btn-buy" onclick="strategyBuilder.submitExecuteLeg(${legId}, ${strategyId}, ${watchlistId})">Enter Leg on All ${instances.length}</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    this.activeModal = modal;
  }

  async submitExecuteLeg(legId, strategyId, watchlistId) {
    this.closeModal();
    try {
      const res = await api.executeStrategy(strategyId, { legId, allowScaleIn: this.isAllowScaleIn() });
      const data = res?.data;
      const ok = data?.success;
      const instanceSummaries = (data?.instances || []).map((inst) => {
        const leg = (inst.legs || [])[0];
        const label = leg?.skipped ? 'already open, skipped' : (leg?.success ? 'entered' : (leg?.error || 'failed'));
        return `${inst.instanceName}: ${label}`;
      });
      Utils.showToast(
        (ok ? 'Leg entered: ' : 'Leg entry had failures: ') + instanceSummaries.join(' | '),
        ok ? 'success' : 'warning'
      );
      if (this.expandedStrategies.has(strategyId)) {
        await this._loadAndRenderLegs(strategyId, watchlistId);
      }
    } catch (error) {
      Utils.showToast(error.message || 'Leg entry failed', 'error');
    }
  }

  // Same convention as showExitModal, scoped to a single leg.
  async showExitLegModal(legId, strategyId, watchlistId) {
    if (this.isQuickTradeMode()) {
      Utils.showToast('Exiting leg...', 'info');
      return this.submitExitLeg(legId, strategyId, watchlistId);
    }
    let watchlist;
    try {
      const res = await api.getWatchlistById(watchlistId);
      watchlist = res?.data;
    } catch (error) {
      Utils.showToast('Failed to load watchlist instances', 'error');
      return;
    }

    const instances = Array.isArray(watchlist?.instances) ? watchlist.instances : [];
    const instanceList = instances.map((i) => `<li>${Utils.escapeHTML(i.name)}</li>`).join('');

    const modal = document.createElement('div');
    modal.className = 'modal-overlay strategy-modal';
    modal.innerHTML = `
      <div class="modal-content" style="max-width: 420px;">
        <div class="modal-header"><h3>Exit Leg</h3></div>
        <div class="modal-body">
          <p class="text-neutral-600 text-sm">This closes just this leg's open position across <strong>all ${instances.length} instance(s)</strong> assigned to this watchlist:</p>
          <ul style="margin: var(--space-2) 0; padding-left: var(--space-5);">${instanceList}</ul>
          <p class="text-neutral-600 text-sm">Instances with no open position for this leg are skipped.</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-neutral btn-outline" onclick="strategyBuilder.closeModal()">Cancel</button>
          <button class="btn btn-sell" onclick="strategyBuilder.submitExitLeg(${legId}, ${strategyId}, ${watchlistId})">Exit Leg on All ${instances.length}</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    this.activeModal = modal;
  }

  async submitExitLeg(legId, strategyId, watchlistId) {
    this.closeModal();
    try {
      const res = await api.exitStrategy(strategyId, { legId });
      const data = res?.data;
      const ok = data?.success;
      const instanceSummaries = (data?.instances || []).map((inst) => {
        const leg = (inst.legs || [])[0];
        const label = leg ? (leg.success ? 'closed' : (leg.error || 'failed')) : 'no open position';
        return `${inst.instanceName}: ${label}`;
      });
      Utils.showToast(
        (ok ? 'Leg exited: ' : 'Leg exit had failures: ') + (instanceSummaries.join(' | ') || 'no open positions'),
        ok ? 'success' : 'warning'
      );
      if (this.expandedStrategies.has(strategyId)) {
        await this._loadAndRenderLegs(strategyId, watchlistId);
      }
    } catch (error) {
      Utils.showToast(error.message || 'Leg exit failed', 'error');
    }
  }

  async deleteStrategy(strategyId, watchlistId) {
    if (!confirm('Delete this strategy and all its legs?')) return;
    try {
      await api.deleteStrategy(strategyId);
      Utils.showToast('Strategy deleted', 'success');
      await this.refreshSection(watchlistId);
    } catch (error) {
      Utils.showToast(error.message || 'Failed to delete strategy', 'error');
    }
  }

  closeModal() {
    if (this.activeModal) {
      this.activeModal.remove();
      this.activeModal = null;
    }
  }
}

const strategyBuilder = new StrategyBuilder();
