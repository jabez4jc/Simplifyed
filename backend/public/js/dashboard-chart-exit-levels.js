/**
 * Exit levels on the underlying (services/exit-levels.service.js on the server).
 *
 * A level is a price on the MAIN chart - the index, future, equity or MCX future on screen. When
 * that instrument reaches it, the app exits the positions it covers on the underlying and its
 * options, by direction: below the price it is a stop for bullish positions and a target for
 * bearish ones, above the price the reverse. Levels are drawn on the main chart and dragged there;
 * each option chart shows what its premium would roughly be at each level ("≈ ₹142 if NIFTY
 * 22,680") - an estimate, since the trigger is the underlying's price.
 *
 * Also here: the rupee max-loss per position (right-click an option chart, or a tradable main
 * chart), and the panel listing both with a Remove for each.
 */

const EXIT_LEVEL_WATCH_MS = 20000;

Object.assign(DashboardApp.prototype, {
  /** Levels, max-losses and premium estimates for the chart on screen. */
  async loadExitLevels() {
    const state = this.chartState;
    if (!state) return;
    const symbolId = state.symbolId;
    try {
      const [levels, caps] = await Promise.all([
        api.request(`/exit-levels?symbolId=${encodeURIComponent(symbolId)}`),
        api.request(`/exit-levels/caps?symbolId=${encodeURIComponent(symbolId)}`),
      ]);
      if (this.chartState?.symbolId !== symbolId) return;
      this.exitLevels = levels.data || [];
      this.exitCaps = caps.data || [];
    } catch (_) {
      this.exitLevels = [];
      this.exitCaps = [];
    }
    this.redrawChartLines();
    this.renderExitLevelsPanel();
    await this.loadLevelProjections();
  },

  /** Poll so a level that fired (or a drag elsewhere) shows up within one cycle. */
  startExitLevelWatch() {
    if (this._exitLevelWatch) return;
    this._exitLevelWatch = setInterval(() => {
      if (this.currentView === 'chart') this.loadExitLevels();
    }, EXIT_LEVEL_WATCH_MS);
  },

  activeExitLevels() {
    return (this.exitLevels || []).filter((l) => l.status === 'ACTIVE');
  },

  /** Main chart only - called from redrawChartLines, which has cleared the lines already. */
  drawExitLevelLines() {
    this.exitLevelLines = [];
    const css = getComputedStyle(document.documentElement);
    const colour = css.getPropertyValue('--color-warning').trim() || '#D4A017';
    for (const level of this.activeExitLevels()) {
      const line = this.addPriceLine({
        price: Number(level.trigger_price),
        color: colour,
        lineWidth: 2,
        dashed: true,
        leftLabel: level.label,
      });
      if (line) this.exitLevelLines.push({ level, line });
    }
  },

  /** Option panes - "≈ ₹142 if NIFTY 22,680" per active level, from the projections endpoint. */
  drawProjectionLines(scope) {
    const pane = this.optionPanes?.[scope];
    if (!pane?.contract) return;
    const css = getComputedStyle(document.documentElement);
    const colour = css.getPropertyValue('--color-warning').trim() || '#D4A017';
    for (const p of (this.levelProjections || []).filter((x) => x.symbol === pane.contract.symbol)) {
      this.addPriceLine({
        price: p.estimate,
        color: colour,
        lineWidth: 1,
        dashed: true,
        leftLabel: `≈ ${Utils.formatNumber(p.estimate)} if ${this.chartState?.symbol} ${Utils.formatNumber(p.underlying)}`,
      }, scope);
    }
  },

  async loadLevelProjections() {
    const state = this.chartState;
    const panes = Object.values(this.optionPanes || {}).filter((p) => p?.contract);
    if (!state || !panes.length || !this.activeExitLevels().length) {
      this.levelProjections = [];
    } else {
      const contracts = panes.map((p) => `${p.contract.exchange}:${p.contract.symbol}`).join(',');
      try {
        const res = await api.request(`/exit-levels/projections?symbolId=${encodeURIComponent(state.symbolId)}&contracts=${encodeURIComponent(contracts)}`);
        if (this.chartState?.symbolId !== state.symbolId) return;
        this.levelProjections = res.data || [];
      } catch (_) {
        this.levelProjections = [];
      }
    }
    for (const key of ['ce', 'pe']) if (this.optionPanes?.[key]) this.redrawChartLines(key);
  },

  /** The list under the chart: every active level and max-loss, each with Remove. */
  renderExitLevelsPanel() {
    const host = document.getElementById('chart-exit-levels');
    if (!host) return;
    const levels = this.exitLevels || [];
    const caps = this.exitCaps || [];
    host.hidden = !levels.length && !caps.length;
    if (host.hidden) { host.innerHTML = ''; return; }
    const fired = (l) => {
      let r = null;
      try { r = JSON.parse(l.result || 'null'); } catch (_) { r = null; }
      const ok = (r?.results || []).filter((x) => x.ok).length;
      const bad = (r?.results || []).filter((x) => !x.ok);
      return `hit at ${Utils.formatNumber(r?.ltp)} · ${ok} exit${ok === 1 ? '' : 's'} sent${bad.length ? ` · ${bad.length} failed: ${bad[0].error}` : ''}`;
    };
    host.innerHTML = `
      <div class="chart-levels-head">
        <span class="chart-levels-title">Levels on ${Utils.escapeHTML(this.chartState?.symbol || '')}</span>
        <span class="chart-levels-mode">exit positions on the underlying and its options</span>
      </div>
      <ul class="chart-exit-level-list">
        ${levels.map((l) => `
          <li class="${l.status === 'ACTIVE' ? '' : 'is-done'}">
            <span>${Utils.escapeHTML(l.label)}</span>
            ${l.status === 'ACTIVE'
              ? `<button type="button" class="btn btn-neutral btn-outline btn-sm" data-remove-level="${l.id}">Remove</button>`
              : `<span class="chart-exit-level-fired">${Utils.escapeHTML(fired(l))}</span>`}
          </li>`).join('')}
        ${caps.map((c) => `
          <li>
            <span>Max loss ₹${Utils.escapeHTML(Utils.formatNumber(c.max_loss))} on ${Utils.escapeHTML(c.symbol)} (per account)</span>
            <button type="button" class="btn btn-neutral btn-outline btn-sm" data-remove-cap="${c.id}">Remove</button>
          </li>`).join('')}
      </ul>`;
    host.querySelectorAll('[data-remove-level]').forEach((b) => b.addEventListener('click', async () => {
      try {
        await api.request(`/exit-levels/${b.dataset.removeLevel}`, { method: 'DELETE' });
        Utils.showToast('Level removed', 'success');
      } catch (error) {
        Utils.showToast(`Could not remove: ${error.message}`, 'error');
      }
      this.loadExitLevels();
    }));
    host.querySelectorAll('[data-remove-cap]').forEach((b) => b.addEventListener('click', async () => {
      try {
        await api.request(`/exit-levels/caps/${b.dataset.removeCap}`, { method: 'DELETE' });
        Utils.showToast('Max loss removed', 'success');
      } catch (error) {
        Utils.showToast(`Could not remove: ${error.message}`, 'error');
      }
      this.loadExitLevels();
    }));
  },

  /** Right-click "Exit level @ price…": what it would do now, then its options. */
  async openExitLevelDialog(price) {
    const state = this.chartState;
    if (!state) return;
    let preview;
    try {
      preview = (await api.request(`/exit-levels/preview?symbolId=${encodeURIComponent(state.symbolId)}&price=${encodeURIComponent(price)}`)).data;
    } catch (error) {
      Utils.showToast(error.message, 'error');
      return;
    }
    const where = preview.side === 'BELOW' ? 'below' : 'above';
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-content chart-confirm">
        <div class="modal-header">
          <h3>Exit level @ ${Utils.escapeHTML(Utils.formatNumber(price))} — ${Utils.escapeHTML(state.symbol)}</h3>
        </div>
        <div class="modal-body">
          <p class="chart-confirm-lead">
            ${Utils.escapeHTML(where[0].toUpperCase() + where.slice(1))} the current price
            (${Utils.escapeHTML(Utils.formatNumber(preview.ltp))}). When ${Utils.escapeHTML(state.symbol)} reaches it, the app exits
            positions on ${Utils.escapeHTML(state.symbol)} and its options, every expiry:
            ${preview.side === 'BELOW' ? 'a <strong>stop</strong> for bullish ones and a <strong>target</strong> for bearish ones'
              : 'a <strong>target</strong> for bullish ones and a <strong>stop</strong> for bearish ones'}.
          </p>
          <p class="chart-confirm-note" data-role="now">Right now: ${Utils.escapeHTML(preview.bullish)} bullish and
            ${Utils.escapeHTML(preview.bearish)} bearish position${preview.bullish + preview.bearish === 1 ? '' : 's'}.
            Positions opened later are covered too.</p>
          <form class="chart-exit-level-form">
            ${preview.mixed ? `
              <fieldset>
                <legend>Both directions are open - exit which?</legend>
                <label><input type="radio" name="coverage" value="ALL" checked> Everything</label>
                <label><input type="radio" name="coverage" value="BULLISH"> Only bullish</label>
                <label><input type="radio" name="coverage" value="BEARISH"> Only bearish</label>
              </fieldset>` : '<input type="hidden" name="coverage" value="ALL">'}
            <label class="chart-exit-level-row">Exit
              <select name="sizeMode">
                <option value="FULL">the whole position</option>
                <option value="PERCENT">a percentage</option>
                <option value="LOTS">a number of lots</option>
              </select>
              <input type="number" name="sizeValue" min="1" step="1" placeholder="50" hidden aria-label="Size">
            </label>
            <p class="chart-confirm-note">Partial exits round down to whole lots (at least 1 lot).</p>
            <fieldset>
              <legend>Accounts</legend>
              ${preview.accounts.map((a) => `
                <label><input type="checkbox" name="acct" value="${a.id}" checked>
                  ${Utils.escapeHTML(a.name)} ${a.isAnalyzer ? '<span class="chart-leg-badge">analyzer</span>' : '<strong>live</strong>'}</label>`).join('')}
            </fieldset>
            <label class="chart-exit-level-row"><input type="checkbox" name="trailing">
              Trailing stop - follows the ${preview.side === 'BELOW' ? 'highest' : 'lowest'} price, keeping this distance
              (${Utils.escapeHTML(Utils.formatNumber(Math.abs(preview.ltp - price)))} points)</label>
          </form>
        </div>
        <div class="modal-footer">
          <button class="btn btn-neutral btn-outline" data-action="cancel">Cancel</button>
          <button class="btn btn-buy" data-action="go">Place level</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    const form = modal.querySelector('form');
    const sizeValue = form.querySelector('[name="sizeValue"]');
    form.querySelector('[name="sizeMode"]').addEventListener('change', (e) => {
      sizeValue.hidden = e.target.value === 'FULL';
      sizeValue.placeholder = e.target.value === 'PERCENT' ? '50 (%)' : '1 (lots)';
    });
    const close = () => modal.remove();
    modal.querySelector('[data-action="cancel"]').addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    modal.querySelector('[data-action="go"]').addEventListener('click', async () => {
      const accounts = [...form.querySelectorAll('[name="acct"]:checked')].map((el) => Number(el.value));
      if (!accounts.length) { Utils.showToast('Choose at least one account', 'error'); return; }
      const mode = form.querySelector('[name="sizeMode"]').value;
      const body = {
        symbolId: state.symbolId,
        price,
        coverage: (form.querySelector('[name="coverage"]:checked') || form.querySelector('[name="coverage"]')).value,
        sizeMode: mode,
        ...(mode === 'FULL' ? {} : { sizeValue: Number(sizeValue.value) }),
        ...(accounts.length === preview.accounts.length ? {} : { instanceIds: accounts }),
        trailing: form.querySelector('[name="trailing"]').checked,
      };
      try {
        await api.request('/exit-levels', { method: 'POST', body });
        close();
        Utils.showToast('Level placed', 'success');
        this.loadExitLevels();
      } catch (error) {
        Utils.showToast(error.message, 'error');
      }
    });
  },

  /** Right-click "Max loss ₹…" on a contract. */
  async openMaxLossDialog(contract) {
    const state = this.chartState;
    if (!state || !contract) return;
    const raw = window.prompt(`Max loss in rupees for ${contract.symbol} (per account). The app closes an account's position once its loss reaches this.`);
    if (raw === null) return;
    const maxLoss = Number(String(raw).replace(/[₹,\s]/g, ''));
    if (!(maxLoss > 0)) { Utils.showToast('Enter a rupee amount above zero', 'error'); return; }
    try {
      await api.request('/exit-levels/caps', {
        method: 'POST',
        body: { symbolId: state.symbolId, exchange: contract.exchange, symbol: contract.symbol, maxLoss },
      });
      Utils.showToast(`Max loss ₹${Utils.formatNumber(maxLoss)} set on ${contract.symbol}`, 'success');
      this.loadExitLevels();
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  },

  /**
   * Drag a level on the main chart. Same hand-rolled approach as the points levels (hit-test the
   * line's y, a small threshold before a drag starts), saved on release - a level is the app's own
   * trigger, not a broker order, so nothing is sent anywhere until it is crossed.
   *
   * Listeners run in the CAPTURE phase and stop the event once a level line is grabbed: the
   * chart's own canvas otherwise panned along with the pointer, so the price under it barely
   * changed and the level landed almost where it started.
   */
  attachExitLevelDragging() {
    const container = document.getElementById('chart-container');
    if (!container || container.dataset.exitDragBound === 'true') return;
    container.dataset.exitDragBound = 'true';
    let hit = null;
    let startY = 0;
    let dragging = false;
    let price = null;

    container.addEventListener('pointerdown', (e) => {
      const rect = container.getBoundingClientRect();
      const y = e.clientY - rect.top;
      hit = (this.exitLevelLines || []).find(({ level }) => {
        const ly = this.chart?.priceToCoordinate(Number(level.trigger_price), 0);
        return Number.isFinite(ly) && Math.abs(ly - y) <= 6;
      }) || null;
      startY = y;
      if (hit) e.stopPropagation(); // the chart must not start a pan under a grabbed level
    }, true);
    container.addEventListener('pointermove', (e) => {
      if (!hit) return;
      e.stopPropagation();
      const y = e.clientY - container.getBoundingClientRect().top;
      if (!dragging) {
        if (Math.abs(y - startY) < 3) return;
        dragging = true;
        container.setPointerCapture?.(e.pointerId);
        container.classList.add('is-dragging-level');
      }
      const p = this.chart.coordinateToPrice(y, 0);
      if (!Number.isFinite(p)) return;
      price = Number(p.toFixed(2));
      hit.line.setPrice(price);
    }, true);
    const end = async (e) => {
      const moved = dragging && hit && price;
      const level = hit?.level;
      if (dragging) {
        container.releasePointerCapture?.(e.pointerId);
        container.classList.remove('is-dragging-level');
      }
      hit = null;
      dragging = false;
      if (!moved) return;
      try {
        await api.request(`/exit-levels/${level.id}`, { method: 'PATCH', body: { price } });
        Utils.showToast(`Level moved to ${Utils.formatNumber(price)}`, 'success');
      } catch (error) {
        Utils.showToast(error.message, 'error');
      }
      price = null;
      this.loadExitLevels();
    };
    container.addEventListener('pointerup', (e) => { if (hit) e.stopPropagation(); end(e); }, true);
    container.addEventListener('pointercancel', end, true);
  },
});
