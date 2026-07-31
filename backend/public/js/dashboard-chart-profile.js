/**
 * Order flow: Volume Profile, Footprint and Cumulative Delta - openalgo-charts' `profile` tier
 * (see js/openalgo-charts-bridge.js).
 *
 * Volume Profile is derived from the loaded OHLCV history - an honest per-bar approximation
 * (volume spread across each bar's range, buy/sell split from bar direction), the same
 * approximation the library's own indicatorConfig-adjacent docs describe for the family.
 *
 * Footprint and CVD are a different story: they need trade-by-trade prints classified bid/ask
 * (was this print buyer- or seller-initiated?), and OpenAlgo does not store that history by
 * default - the profile tier's own doc comment says so outright ("either live-session-only or
 * needs a tick-recorder backend"). So both are built LIVE from the same tick stream
 * applyChartQuote already folds into the candles, classified with the standard tick rule (a
 * print at/above the ask is buy-initiated, at/below the bid is sell-initiated, midpoint or an
 * up/down tick as the fallback when no quoted spread is available). Both start EMPTY the moment
 * they are switched on and grow only from there - never pretending to have history they don't.
 */
Object.assign(DashboardApp.prototype, {
  profileState() {
    if (!this._profile) {
      this._profile = {
        volumeOn: false, footprintOn: false, cvdOn: false,
        vpPrimitive: null, footprintPrimitive: null, cvdSeries: null, cvdPaneIndex: null,
        cvdLegend: null, aggregator: null, footprintBars: [],
      };
    }
    return this._profile;
  },

  loadProfilePrefs() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('chart-profile') || '{}'); } catch (_) { /* corrupt */ }
    const s = this.profileState();
    s.volumeOn = Boolean(saved.volumeOn);
    s.footprintOn = Boolean(saved.footprintOn);
    s.cvdOn = Boolean(saved.cvdOn);
  },

  saveProfilePrefs() {
    const s = this.profileState();
    try {
      localStorage.setItem('chart-profile', JSON.stringify({
        volumeOn: s.volumeOn, footprintOn: s.footprintOn, cvdOn: s.cvdOn,
      }));
    } catch (_) { /* private mode */ }
  },

  toggleVolumeProfile() {
    const s = this.profileState();
    s.volumeOn = !s.volumeOn;
    this.saveProfilePrefs();
    if (s.volumeOn) this.refreshVolumeProfile(); else this.clearVolumeProfile();
    this.renderProfileBar();
    this.updateChartBarChips();
  },

  toggleFootprint() {
    const s = this.profileState();
    s.footprintOn = !s.footprintOn;
    this.saveProfilePrefs();
    if (s.footprintOn) this.renderFootprint(); else this.clearFootprint();
    this.renderProfileBar();
    this.updateChartBarChips();
  },

  toggleCvd() {
    const s = this.profileState();
    s.cvdOn = !s.cvdOn;
    this.saveProfilePrefs();
    if (s.cvdOn) this.renderCvd(); else this.clearCvd();
    this.renderProfileBar();
    this.updateChartBarChips();
  },

  renderProfileBar() {
    const host = document.getElementById('chart-profile-bar');
    if (!host) return;
    const s = this.profileState();
    host.innerHTML = `
      <span class="chart-toolbar-label">Order flow</span>
      <button type="button" class="chart-ind-btn ${s.volumeOn ? 'active' : ''}" data-profile="volume">Volume Profile</button>
      <button type="button" class="chart-ind-btn ${s.footprintOn ? 'active' : ''}" data-profile="footprint">Footprint</button>
      <button type="button" class="chart-ind-btn ${s.cvdOn ? 'active' : ''}" data-profile="cvd">CVD</button>
      <p class="chart-profile-note">
        Volume Profile uses the loaded history. Footprint and CVD build up from live ticks only -
        OpenAlgo does not store trade-by-trade bid/ask history, so both start empty and grow from
        when you switch them on, not before.
      </p>`;
    host.querySelectorAll('[data-profile]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const kind = btn.dataset.profile;
        if (kind === 'volume') this.toggleVolumeProfile();
        else if (kind === 'footprint') this.toggleFootprint();
        else if (kind === 'cvd') this.toggleCvd();
      });
    });
  },

  /**
   * Real tick size from the instruments master (see the `tickSize` field GET /history/symbols
   * now carries), falling back to a reasonable guess by price magnitude only for a symbol the
   * instrument sync hasn't reached yet - never silently substituting a wrong-but-plausible unit,
   * since a wrong tick size buckets every row at the wrong price and every level reads sensible.
   */
  chartTickSize() {
    const explicit = Number(this.chartState?.symbols?.find((s) => s.symbolId === this.chartState.symbolId)?.tickSize);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    const price = this.chartLastPrice || this.chartCandles?.[this.chartCandles.length - 1]?.close || 100;
    if (price >= 10000) return 0.5;
    if (price >= 1000) return 0.1;
    if (price >= 100) return 0.05;
    return 0.01;
  },

  refreshVolumeProfile() {
    const s = this.profileState();
    if (!s.volumeOn || !this.chart || !window.OAC) return;
    const candles = this.chartCandles;
    if (!candles?.length) return;

    const bars = candles.map((c) => ({
      time: c.ts, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0,
    }));
    const result = window.OAC.computeVolumeProfileSessions(bars, {
      tickSize: this.chartTickSize(), session: 'composite', valueAreaPercent: 0.7, deltaFromBarDirection: true,
    });

    try {
      if (!s.vpPrimitive) {
        s.vpPrimitive = new window.OAC.VolumeProfile(result, { width: 120 });
        this.chart.addPrimitive(s.vpPrimitive, 0);
      } else {
        s.vpPrimitive.setData(result);
      }
    } catch (error) {
      console.error('[Chart] volume profile failed', error);
    }
  },

  clearVolumeProfile() {
    const s = this.profileState();
    if (s.vpPrimitive) {
      try { this.chart?.removePrimitive(s.vpPrimitive); } catch (_) { /* disposed */ }
      s.vpPrimitive = null;
    }
  },

  /**
   * Tick rule: a print at/above the ask is buy-initiated, at/below the bid is sell-initiated -
   * the standard proxy wherever true exchange-side classification isn't available. Falls back to
   * the quoted midpoint, and finally to the plain up/down tick, so a quote missing depth (some
   * instances report `bid_price`/`ask_price` as 0) still contributes rather than being dropped.
   */
  classifyTick(quote) {
    const ltp = Number(quote.ltp);
    if (!Number.isFinite(ltp) || ltp <= 0) return null;
    const bid = Number(quote.bid_price);
    const ask = Number(quote.ask_price);
    const haveBid = Number.isFinite(bid) && bid > 0;
    const haveAsk = Number.isFinite(ask) && ask > 0;

    if (haveAsk && ltp >= ask) return 'ask';
    if (haveBid && ltp <= bid) return 'bid';
    if (haveBid && haveAsk) return ltp >= (bid + ask) / 2 ? 'ask' : 'bid';

    const prev = this._lastClassifiedPrice;
    this._lastClassifiedPrice = ltp;
    if (prev === undefined || ltp === prev) return null;
    return ltp > prev ? 'ask' : 'bid';
  },

  ensureFootprintAggregator() {
    const s = this.profileState();
    if (s.aggregator) return s.aggregator;
    const seconds = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, D: 86400 }[this.chartState?.timeframe] || 300;
    s.aggregator = new window.OAC.FootprintAggregator({ mode: 'interval', seconds }, this.chartTickSize(), 10);
    s.footprintBars = [];
    return s.aggregator;
  },

  /** Drop everything accumulated so far - a new symbol or timeframe has nothing in common with
   * the previous one's ticks, so carrying them over would mix two instruments' order flow. */
  resetProfileTicks() {
    const s = this.profileState();
    s.aggregator = null;
    s.footprintBars = [];
    this._lastClassifiedPrice = undefined;
    if (s.footprintOn) this.renderFootprint();
    if (s.cvdOn) this.renderCvd();
  },

  /**
   * A trustworthy UTC-seconds timestamp for a tick, or "now" when the quote's own is not
   * trustworthy. `quote.timestamp`/`.ltt` is ambiguous in the same way `quoteAgeMs` already
   * guards against (seconds or milliseconds depending on the broker) - AND, unlike that
   * read-only age check, a bad value here is written into the footprint/CVD series' own time
   * axis, which every pane shares. An unguarded INT32 sentinel (2^31, the same "no value" marker
   * OpenAlgo sends for other unset fields) parses as a real 2038-ish date, and one such point is
   * enough to stretch the WHOLE shared time axis out to accommodate it - collapsing every real,
   * current point into an unreadable sliver at the edge. Rather than special-case the sentinel,
   * anything further than a day from the browser's own clock is rejected outright.
   */
  timeFromQuote(quote) {
    const raw = Number(quote?.timestamp ?? quote?.ltt);
    const now = Date.now();
    if (!Number.isFinite(raw) || raw <= 0) return Math.floor(now / 1000);
    const ms = raw < 1e12 ? raw * 1000 : raw;
    if (Math.abs(ms - now) > 24 * 60 * 60 * 1000) return Math.floor(now / 1000);
    return Math.floor(ms / 1000);
  },

  /** Called from applyChartQuote (dashboard-chart-live.js) for every tick the chart accepts. */
  feedProfileTick(quote) {
    const s = this.profileState();
    if (!s.footprintOn && !s.cvdOn) return;
    if (!window.OAC) return;
    const side = this.classifyTick(quote);
    if (!side) return;

    const aggregator = this.ensureFootprintAggregator();
    const qty = Number(quote.last_traded_qty ?? quote.ltq ?? 1);
    const update = aggregator.onTick({
      time: this.timeFromQuote(quote), price: Number(quote.ltp),
      qty: Number.isFinite(qty) && qty > 0 ? qty : 1, side,
    });
    if (!update) return;

    if (update.isNew) s.footprintBars.push(update.bar);
    else if (s.footprintBars.length) s.footprintBars[s.footprintBars.length - 1] = update.bar;
    // A footprint column is only readable across a couple dozen bars anyway - bounded so the
    // array doesn't grow for as long as the chart stays open.
    if (s.footprintBars.length > 300) s.footprintBars.shift();

    if (s.footprintOn) this.renderFootprint();
    if (s.cvdOn) this.renderCvd();
  },

  renderFootprint() {
    const s = this.profileState();
    if (!s.footprintOn || !this.chart || !window.OAC) return;
    try {
      if (!s.footprintPrimitive) {
        // Bigger than the library default (font 10, 90% of the bar slot) - a footprint only
        // ever has a handful of live bars to show (see the tick-only note above), so there is no
        // reason to leave headroom for a dense, fully-zoomed-out history the way the default
        // tuning does. cellWidth is left auto (derived from bar spacing) rather than fixed, so
        // it keeps adapting correctly as the chart is zoomed.
        s.footprintPrimitive = new window.OAC.Footprint({ font: 12, widthFactor: 0.96, minTextHeight: 9 });
        this.chart.addPrimitive(s.footprintPrimitive, 0);
      }
      s.footprintPrimitive.setBars(s.footprintBars);
    } catch (error) {
      console.error('[Chart] footprint failed', error);
    }
  },

  clearFootprint() {
    const s = this.profileState();
    if (s.footprintPrimitive) {
      try { this.chart?.removePrimitive(s.footprintPrimitive); } catch (_) { /* disposed */ }
      s.footprintPrimitive = null;
    }
  },

  renderCvd() {
    const s = this.profileState();
    if (!s.cvdOn || !this.chart || !window.OAC) return;
    try {
      if (!s.cvdSeries) {
        // Always its own new pane, never a fixed index - the indicator toolbar creates panes
        // dynamically too (RSI, MACD...), so a hardcoded index could land CVD on the same pane
        // as an oscillator with an entirely different value range.
        s.cvdPaneIndex = this.chart.panes().length;
        s.cvdSeries = this.chart.addSeries('line', {
          paneIndex: s.cvdPaneIndex, style: { color: '#22D3EE', width: 1.5, title: 'CVD' },
        });
        // A plain addSeries title isn't enough on its own to draw the pane-corner legend row
        // every indicator pane gets (that row is drawn by a PaneLegend primitive, which the
        // indicator runtime attaches for you but a bare series does not get automatically) -
        // so one is attached by hand here, the same primitive RSI/MACD's panes use.
        s.cvdLegend = new window.OAC.PaneLegend({ id: 'cvd', title: 'CVD', color: '#22D3EE', actions: [] });
        this.chart.addPrimitive(s.cvdLegend, s.cvdPaneIndex);
      }
      const values = window.OAC.cumulativeDelta(s.footprintBars);
      s.cvdSeries.setData(s.footprintBars.map((bar, i) => ({ time: bar.time, value: values[i] })));
      const last = values[values.length - 1];
      if (s.cvdLegend && Number.isFinite(last)) s.cvdLegend.setValue(Utils.formatNumber(last));
    } catch (error) {
      console.error('[Chart] CVD failed', error);
    }
  },

  /**
   * `series.remove()` alone leaves the now-empty pane behind - removing an indicator's last
   * series auto-cleans its pane internally, but that cleanup lives specifically in the
   * indicator-removal path, not in generic series removal, and this is a plain `chart.addSeries`
   * line, not an indicator instance. Without `removePane` here, switching CVD off then on again
   * left the old empty pane in place AND added a new one on top of it - exactly the "blank panel
   * that won't close, one more each click" bug this fixes. `removePane` also reindexes any
   * indicator panes (RSI/MACD) above the one being removed, so those stay correctly placed.
   */
  clearCvd() {
    const s = this.profileState();
    // removePane destroys every series it holds, but the legend is a PRIMITIVE, not a series -
    // detached explicitly first rather than assuming the pane's own teardown reaches it too.
    if (s.cvdLegend) {
      try { this.chart?.removePrimitive(s.cvdLegend); } catch (_) { /* disposed */ }
      s.cvdLegend = null;
    }
    if (s.cvdPaneIndex !== null && s.cvdPaneIndex > 0 && this.chart) {
      try { this.chart.removePane(s.cvdPaneIndex); } catch (_) { /* disposed */ }
    } else if (s.cvdSeries) {
      try { s.cvdSeries.remove(); } catch (_) { /* disposed */ }
    }
    s.cvdSeries = null;
    s.cvdPaneIndex = null;
  },

  /** Full teardown - called from destroyChart(). The primitives/series belong to the chart
   * instance that is going away; the accumulated ticks belong to nothing once it does either. */
  destroyProfile() {
    this.clearVolumeProfile();
    this.clearFootprint();
    this.clearCvd();
    const s = this.profileState();
    s.aggregator = null;
    s.footprintBars = [];
  },
});
