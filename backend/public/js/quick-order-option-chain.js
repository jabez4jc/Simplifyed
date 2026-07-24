/**
 * Simplifyed Admin V2 - Quick Order: option-chain modal.
 */

Object.defineProperties(QuickOrderHandler.prototype, Object.getOwnPropertyDescriptors(class {
  /**
   * Fetch and display option chain in a modal
   */
  async showOptionChainModal(symbolId) {
    try {
      const symbolRow = document.querySelector(`tr[data-symbol-id="${symbolId}"]`);
      if (!symbolRow) {
        throw new Error('Symbol row not found');
      }

      const underlying = symbolRow.dataset.underlying || symbolRow.dataset.symbol || '';
      const exchange = (symbolRow.dataset.exchange || 'NFO').toUpperCase();
      const expiry = this.selectedExpiries.get(symbolId);

      if (exchange === 'MCX') {
        Utils.showToast('Option chain is not available for MCX via broker. Button disabled.', 'warning');
        return;
      }

      if (!underlying || !expiry) {
        Utils.showToast('Select a symbol and expiry first', 'warning');
        return;
      }

      const params = {
        underlying,
        expiry,
        include_quotes: 'true',
        strike_window: 8,
        forward_source: this.optionChainForwardSource || 'carry'
      };

      this.optionChainParams = params;
      this.optionChainActiveKey = `${underlying}|${expiry}`;
      this.optionChainPrevValues.delete(this.optionChainActiveKey);

      await this._loadAndRenderOptionChain(params);

      if (this.optionChainInterval) {
        clearInterval(this.optionChainInterval);
      }
      this.optionChainInterval = setInterval(() => {
        const nextParams = this.optionChainParams || params;
        this._loadAndRenderOptionChain(nextParams, true).catch(() => {});
      }, 5000);
    } catch (error) {
      console.error('[QuickOrder] Option chain modal error:', error);
      Utils.showToast(error.message, 'error');
    }
  }

  async _loadAndRenderOptionChain(params, isRefresh = false) {
    const qs = new URLSearchParams(params);
    const res = await fetch(`/api/v1/option-chain?${qs.toString()}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || 'Failed to load option chain');
    }
    const json = await res.json();
    const data = json.data || {};
    const chain = data.rows || [];
    const atmStrike = data.atm_strike || data.meta?.atm_strike || null;
    const meta = data.meta || {};

    // Keep latest forward source in sync with backend response
    if (meta.forward_used) {
      this.optionChainForwardSource = meta.forward_used;
    }

    // If modal was closed but refresh interval is still running, stop it
    if (isRefresh && !document.querySelector('.option-chain-overlay')) {
      if (this.optionChainInterval) {
        clearInterval(this.optionChainInterval);
        this.optionChainInterval = null;
      }
      return;
    }
    if (!chain.length) {
      if (!isRefresh) Utils.showToast('Option chain empty for this expiry', 'warning');
      return;
    }
    if (!this.optionChainActiveKey && meta.underlying && meta.expiry) {
      this.optionChainActiveKey = `${meta.underlying}|${meta.expiry}`;
    }
    this._renderOptionChainModal(chain, atmStrike, meta, params, isRefresh);
  }

  _renderOptionChainModal(chain, atmStrike, meta = {}, params = {}, isRefresh = false) {
    // Sort strikes ascending (lowest at top)
    const sorted = [...chain].sort((a, b) => a.strike - b.strike);
    const fmt = (v) => (v === 0 || v ? v : '—');

    const totalCallOi = sorted.reduce((sum, r) => sum + (Number(r.ce?.oi || 0)), 0);
    const totalPutOi = sorted.reduce((sum, r) => sum + (Number(r.pe?.oi || 0)), 0);
    const headerInfo = {
      underlying: chain?.[0]?.ce?.symbol?.split(/\d{2}[A-Z]{3}\d{2}/)[0] || '—',
      expiry: chain?.[0]?.ce?.symbol?.match(/\d{2}[A-Z]{3}\d{2}/)?.[0] || '—',
      callOi: totalCallOi,
      putOi: totalPutOi,
    };

    let modal = document.querySelector('.option-chain-overlay');
    if (!modal) {
      modal = document.createElement('div');
      modal.className = 'modal-overlay option-chain-overlay';
      modal.innerHTML = `
        <div class="modal-content wide option-chain-modal">
          <div class="modal-header sticky-header">
            <h3>Option Chain</h3>
            <div class="oc-meta">
              <span><strong>Underlying:</strong> <span id="oc-underlying">—</span></span>
              <span><strong>Expiry:</strong> <span id="oc-expiry">—</span></span>
              <span><strong>Spot:</strong> <span id="oc-spot">—</span></span>
              <span><strong>Call OI:</strong> <span id="oc-call-oi">—</span></span>
              <span><strong>Put OI:</strong> <span id="oc-put-oi">—</span></span>
              <span><strong>Forward:</strong>
                <select id="oc-forward-source">
                  <option value="carry">Carry (F_carry)</option>
                  <option value="synth_exact">Synthetic (exact)</option>
                  <option value="synth_simple">Synthetic (simple)</option>
                </select>
              </span>
              <span id="oc-forward-values" class="oc-forward-values"></span>
            </div>
            <button class="btn btn-neutral btn-outline btn-sm" onclick="quickOrder._closeOptionChainModal()">Close</button>
          </div>
          <div class="modal-body option-chain-body">
            <div class="option-chain-scroll">
              <table class="table option-chain-table option-chain-wide">
                <thead class="sticky-thead">
                  <tr>
                    <th colspan="11">Calls</th>
                    <th rowspan="2">Strike</th>
                    <th colspan="11">Puts</th>
                  </tr>
                  <tr>
                    <th>Lot</th><th>Vega</th><th>Θ</th><th>Γ</th><th>IV</th><th>Δ</th><th>OI</th><th>Vol</th><th>Bid</th><th>Ask</th><th>LTP</th>
                    <th>LTP</th><th>Ask</th><th>Bid</th><th>Vol</th><th>OI</th><th>Δ</th><th>IV</th><th>Γ</th><th>Θ</th><th>Vega</th><th>Lot</th>
                  </tr>
                </thead>
                <tbody></tbody>
              </table>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
      // Not relying on the generic global backdrop-click handler here - this modal needs the
      // interval/state cleanup in _closeOptionChainModal(), not just DOM removal.
      modal.addEventListener('click', (e) => {
        if (e.target === modal) this._closeOptionChainModal();
      });

      // forward selector change
      modal.querySelector('#oc-forward-source').addEventListener('change', (e) => {
        this.optionChainForwardSource = e.target.value;
        const baseParams = this.optionChainParams || params;
        const newParams = { ...baseParams, forward_source: this.optionChainForwardSource };
        this.optionChainParams = newParams;
        this.optionChainPrevValues.delete(this.optionChainActiveKey || '');
        this._loadAndRenderOptionChain(newParams).catch(() => {});
      });
    }

    const tbody = modal.querySelector('tbody');
    const prevKey = this.optionChainActiveKey || `${meta.underlying || ''}|${meta.expiry || ''}`;
    const prevMap = this.optionChainPrevValues.get(prevKey) || new Map();
    const nextMap = new Map();

    const diffClass = (key, current) => {
      const prev = prevMap.has(key) ? prevMap.get(key) : null;
      if (prev === null || prev === undefined || current === null || current === undefined) return '';
      if (Number(current) > Number(prev)) return 'val-up';
      if (Number(current) < Number(prev)) return 'val-down';
      return '';
    };

    const recordValue = (key, value) => {
      if (value === undefined) return;
      nextMap.set(key, value);
    };

    tbody.innerHTML = sorted
      .map((row) => {
        const isAtm = atmStrike && Number(row.strike) === Number(atmStrike);
        const ce = row.ce || {};
        const pe = row.pe || {};
        const keyPrefix = `${meta.underlying || 'und'}|${meta.expiry || 'exp'}|${row.strike}`;
        const spot = meta.spot || meta.forward_value || atmStrike || row.strike;
        const callState = Number(row.strike) < Number(spot || 0) ? 'itm' : isAtm ? 'atm' : 'otm';
        const putState = Number(row.strike) > Number(spot || 0) ? 'itm' : isAtm ? 'atm' : 'otm';
        const callCls = `oc-${callState}`;
        const putCls = `oc-${putState}`;
        const strikeCls = isAtm ? 'oc-atm' : '';
        const cells = {
          ce: {
            delta: ce.greeks?.delta,
            gamma: ce.greeks?.gamma,
            theta: ce.greeks?.theta,
            vega: ce.greeks?.vega,
            iv: ce.iv,
            oi: ce.oi,
            vol: ce.volume,
            bid: ce.bid,
            ask: ce.ask,
            ltp: ce.ltp,
          },
          pe: {
            delta: pe.greeks?.delta,
            gamma: pe.greeks?.gamma,
            theta: pe.greeks?.theta,
            vega: pe.greeks?.vega,
            iv: pe.iv,
            oi: pe.oi,
            vol: pe.volume,
            bid: pe.bid,
            ask: pe.ask,
            ltp: pe.ltp,
          },
        };

        Object.entries(cells.ce).forEach(([field, value]) => recordValue(`${keyPrefix}|CE|${field}`, value));
        Object.entries(cells.pe).forEach(([field, value]) => recordValue(`${keyPrefix}|PE|${field}`, value));

        return `
          <tr class="${isAtm ? 'is-atm' : ''}">
            <td class="oc-num ${callCls}">${fmt(ce.lotsize || ce.lot_size)}</td>
            <td class="oc-num ${callCls} ${diffClass(`${keyPrefix}|CE|vega`, ce.greeks?.vega)}">${fmt(ce.greeks?.vega)}</td>
            <td class="oc-num ${callCls} ${diffClass(`${keyPrefix}|CE|theta`, ce.greeks?.theta)}">${fmt(ce.greeks?.theta)}</td>
            <td class="oc-num ${callCls} ${diffClass(`${keyPrefix}|CE|gamma`, ce.greeks?.gamma)}">${fmt(ce.greeks?.gamma)}</td>
            <td class="oc-num ${callCls} ${diffClass(`${keyPrefix}|CE|iv`, ce.iv)}">${fmt(ce.iv)}</td>
            <td class="oc-num ${callCls} ${diffClass(`${keyPrefix}|CE|delta`, ce.greeks?.delta)}">${fmt(ce.greeks?.delta)}</td>
            <td class="oc-num ${callCls} ${diffClass(`${keyPrefix}|CE|oi`, ce.oi)}">${fmt(ce.oi)}</td>
            <td class="oc-num ${callCls} ${diffClass(`${keyPrefix}|CE|vol`, ce.volume)}">${fmt(ce.volume)}</td>
            <td class="oc-num ${callCls} ${diffClass(`${keyPrefix}|CE|bid`, ce.bid)}">${fmt(ce.bid)}</td>
            <td class="oc-num ${callCls} ${diffClass(`${keyPrefix}|CE|ask`, ce.ask)}">${fmt(ce.ask)}</td>
            <td class="oc-num ${callCls} ${diffClass(`${keyPrefix}|CE|ltp`, ce.ltp)}">${fmt(ce.ltp)}</td>
            <td class="oc-strike ${strikeCls}">${row.strike}</td>
            <td class="oc-num ${putCls} ${diffClass(`${keyPrefix}|PE|ltp`, pe.ltp)}">${fmt(pe.ltp)}</td>
            <td class="oc-num ${putCls} ${diffClass(`${keyPrefix}|PE|ask`, pe.ask)}">${fmt(pe.ask)}</td>
            <td class="oc-num ${putCls} ${diffClass(`${keyPrefix}|PE|bid`, pe.bid)}">${fmt(pe.bid)}</td>
            <td class="oc-num ${putCls} ${diffClass(`${keyPrefix}|PE|vol`, pe.volume)}">${fmt(pe.volume)}</td>
            <td class="oc-num ${putCls} ${diffClass(`${keyPrefix}|PE|oi`, pe.oi)}">${fmt(pe.oi)}</td>
            <td class="oc-num ${putCls} ${diffClass(`${keyPrefix}|PE|delta`, pe.greeks?.delta)}">${fmt(pe.greeks?.delta)}</td>
            <td class="oc-num ${putCls} ${diffClass(`${keyPrefix}|PE|iv`, pe.iv)}">${fmt(pe.iv)}</td>
            <td class="oc-num ${putCls} ${diffClass(`${keyPrefix}|PE|gamma`, pe.greeks?.gamma)}">${fmt(pe.greeks?.gamma)}</td>
            <td class="oc-num ${putCls} ${diffClass(`${keyPrefix}|PE|theta`, pe.greeks?.theta)}">${fmt(pe.greeks?.theta)}</td>
            <td class="oc-num ${putCls} ${diffClass(`${keyPrefix}|PE|vega`, pe.greeks?.vega)}">${fmt(pe.greeks?.vega)}</td>
            <td class="oc-num ${putCls}">${fmt(pe.lotsize || pe.lot_size)}</td>
          </tr>
        `;
      })
      .join('');

    // persist last values for diffing
    if (this.optionChainActiveKey) {
      this.optionChainPrevValues.set(this.optionChainActiveKey, nextMap);
    }

    const atmRow = modal.querySelector('.option-chain-table .is-atm');
    if (atmRow) {
      atmRow.scrollIntoView({ block: 'center' });
    }

    // Update header meta
    document.getElementById('oc-underlying').textContent = meta.underlying || headerInfo.underlying;
    document.getElementById('oc-expiry').textContent = meta.expiry || headerInfo.expiry;
    document.getElementById('oc-spot').textContent = meta.spot ? Number(meta.spot).toFixed(2) : '—';
    document.getElementById('oc-call-oi').textContent = (meta.call_oi_total || headerInfo.callOi || 0).toLocaleString();
    document.getElementById('oc-put-oi').textContent = (meta.put_oi_total || headerInfo.putOi || 0).toLocaleString();
    const forwardSelect = document.getElementById('oc-forward-source');
    if (forwardSelect && meta.forward_used) {
      forwardSelect.value = meta.forward_used;
    }
    const forwardValues = document.getElementById('oc-forward-values');
    if (forwardValues) {
      const fmtNum = (v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(2) : '—');
      forwardValues.innerHTML = `
        F<sub>carry</sub>: ${fmtNum(meta.F_carry)} |
        F<sub>synth exact</sub>: ${fmtNum(meta.F_synth_exact)} |
        F<sub>synth simple</sub>: ${fmtNum(meta.F_synth_simple)}
      `;
    }
  }

  async _closeOptionChainModal() {
    const modal = document.querySelector('.option-chain-overlay');
    if (modal) {
      const closed = await Utils.closeModal(modal);
      if (!closed) return;
    }
    if (this.optionChainInterval) {
      clearInterval(this.optionChainInterval);
      this.optionChainInterval = null;
    }
    this.optionChainActiveKey = null;
    this.optionChainParams = null;
  }
}.prototype));
