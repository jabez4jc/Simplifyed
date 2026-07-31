/**
 * Live price on the chart.
 *
 * Candles come from the history API in bulk; ticks come from the quote stream. This joins the
 * two: each tick folds into the bar it belongs to, and a tick past the bar's end opens a new one.
 * No refetch and no re-render - `series.update()` mutates the last bar in place, which is what
 * keeps the price moving without the chart flickering or losing your zoom.
 *
 * Only the underlying updates this way. The stream carries the symbols the watchlists subscribe
 * to, and the resolved CE/PE contracts are not among them, so the option panes stay on their
 * fetched history until the next load. That is honest rather than convenient: inventing a tick
 * for a contract nothing is quoting would be worse than a slightly stale pane.
 */
const TIMEFRAME_SECONDS = {
  '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, D: 86400,
};

// IST_OFFSET_SECONDS comes from dashboard-chart.js (loaded first) - used only for bucket-boundary
// math here (which bar a tick belongs to in IST wall-clock time), not a display shift. The chart
// itself renders IST natively from raw UTC seconds.

/**
 * REST fallback cadence. Only used when the WebSocket gateway is off or disconnected - with the
 * stream up this never fires, and the chart moves tick by tick instead.
 */
const CHART_POLL_MS = 3000;

/**
 * How long a chart may go without a WS-sourced tick before its own fallback poll resumes, even
 * while the WS socket itself reports "connected". `isWsStreamingActive()` is a connection-level
 * flag - true the instant the socket is up, regardless of whether THIS symbol is actually being
 * pushed over it (a chart on a symbol outside every watchlist previously depended on an
 * incidental REST-priming side effect to even get subscribed - see ensureSymbolSubscribed on the
 * backend). Matches the order of magnitude of the server's own 10-15s quote TTL, so both layers
 * agree on what "stale" means.
 */
const CHART_STALE_MS = 12000;

/**
 * How old a quote may be before the chart refuses to draw it.
 *
 * Six hours is deliberately generous - an illiquid contract's last trade can legitimately be
 * hours old while its price is still the right one to show. It exists to catch the failure
 * actually seen: a broker snapshot cached in January was still being served in July, and the
 * chart folded that 190-day-old price into today's live bar. NIFTY jumped from 23,955 to
 * 25,665 in one candle and then flat-lined, because every subsequent poll returned the same
 * frozen value.
 */
const MAX_QUOTE_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * INT32 overflow markers. OpenAlgo/broker feeds send 2^31 (and 2^31/100 for prices, which are
 * scaled by 100) for fields they have no value for. Charted, they become a 21-million-rupee
 * candle; used as a volume baseline, they poison every subsequent delta.
 */
const INT32_SENTINEL = 2 ** 31;
const INT32_SENTINEL_PRICE = INT32_SENTINEL / 100;

const isSentinel = (n) => n === INT32_SENTINEL || n === INT32_SENTINEL_PRICE;

Object.assign(DashboardApp.prototype, {
  /**
   * Keep the chart's price current for as long as the chart view is open.
   *
   * The stream is preferred and the poll is a fallback, not a supplement: they are checked on
   * each tick rather than at start-up, because the socket can drop at any point and a chart that
   * silently stops moving is the worst failure mode here.
   */
  startChartLiveUpdates() {
    this.stopChartLiveUpdates();
    // A fresh chart (symbol just switched, view just opened) hasn't proven WS is delivering for
    // ITS symbol yet - starting at 0 means the very first gate check treats it as stale and
    // polls immediately, rather than trusting a stale timestamp left over from whatever symbol
    // was on screen before.
    this.lastChartTickAt = 0;
    this.chartPollInterval = setInterval(() => {
      if (this.isPaused || this.currentView !== 'chart') return;
      // Connection-level "is the socket up" is a safe enough proxy for the watchlist (its
      // symbols are always subscribed by construction), but not for the chart - a symbol can sit
      // unsubscribed on an otherwise-healthy socket. Fall back to REST unless a WS tick for THIS
      // symbol has actually landed within CHART_STALE_MS.
      const wsFreshForSymbol = this.isWsStreamingActive()
        && (Date.now() - (this.lastChartTickAt || 0)) < CHART_STALE_MS;
      if (wsFreshForSymbol) return;
      this.pollChartQuote().catch(() => { /* transient; the next tick retries */ });
    }, CHART_POLL_MS);
  },

  stopChartLiveUpdates() {
    if (this.chartPollInterval) {
      clearInterval(this.chartPollInterval);
      this.chartPollInterval = null;
    }
  },

  /** Say so on the status line rather than freezing silently at a wrong price. */
  noteStaleQuote(ageMs) {
    const el = document.getElementById('chart-status');
    if (!el) return;
    const hours = Math.round(ageMs / 3600000);
    const note = `live feed stale (${hours >= 24 ? `${Math.round(hours / 24)}d` : `${hours}h`} old) — showing history only`;
    if (el.dataset.staleNote === note) return;
    el.dataset.staleNote = note;
    el.textContent = note;
    el.title = note;
  },

  async pollChartQuote() {
    const state = this.chartState;
    if (!state) return;
    // No `refresh: false` here, deliberately. On the chart view nothing else pulls quotes, so
    // asking for the cache-only snapshot returns the same LTP forever: the candles flat-line and
    // every indicator flat-lines with them. The endpoint's default refreshes only when the
    // snapshot is older than its TTL, which is the throttle that was wanted in the first place.
    const res = await api.getQuoteSnapshots({
      exchange: state.exchange,
      symbols: state.symbol,
    });
    const ts = Date.now();
    let sawStale = false;
    for (const instance of res.data?.instances || []) {
      // The endpoint already knows: it compares each snapshot against the quote TTL. Charting a
      // snapshot it has flagged stale is how a January price ended up on a July candle.
      if (instance.stale) { sawStale = instance.quotes?.length ? true : sawStale; continue; }
      for (const quote of instance.quotes || []) {
        if (this.applyChartQuote(this.hydrateQuoteWithLtp(quote, ts))) return;
      }
    }
    if (sawStale) this.noteStaleQuote(MAX_QUOTE_AGE_MS);
  },

  /**
   * Fold one streamed quote into the chart, if it is for the symbol on screen.
   * @returns {boolean} whether the chart consumed it (used by the tests and the feed status)
   */
  /**
   * Age of a quote from its OWN clock, or null when it does not carry one.
   *
   * Deliberately not `ltpTs`: hydrateQuoteWithLtp stamps that with the moment the browser
   * received the message, so a snapshot cached six months ago looks brand new through it.
   */
  quoteAgeMs(quote) {
    const stamp = Number(quote?.timestamp ?? quote?.ltt);
    if (!Number.isFinite(stamp) || stamp <= 0) return null;
    // Seconds or milliseconds, depending on the broker.
    const ms = stamp < 1e12 ? stamp * 1000 : stamp;
    return Date.now() - ms;
  },

  applyChartQuote(quote, fromWs = false) {
    const state = this.chartState;
    if (!state || !this.candleSeries || !quote) return false;

    const ltp = Number(quote.ltp);
    if (!Number.isFinite(ltp) || ltp <= 0 || isSentinel(ltp)) return false;

    // A stale quote is worse than no quote: it draws a confident price that is simply not the
    // market. The server flags staleness per instance too, but the WebSocket push path carries
    // no such flag, so the check has to live here as well.
    const age = this.quoteAgeMs(quote);
    if (age !== null && age > MAX_QUOTE_AGE_MS) {
      this.noteStaleQuote(age);
      return false;
    }

    // Reuse the watchlist key builder so exchange aliases and numeric segment codes normalise
    // the same way here as everywhere else - a second implementation would drift.
    const wanted = this.buildWatchlistSymbolKey(state.exchange, state.symbol);
    const exchange = quote.exchange || quote.exch || quote.exchange_segment || quote.exchangeSegment;
    const matches = [quote.symbol, quote.trading_symbol, quote.tradingSymbol, quote.tradingsymbol]
      .some((sym) => sym && this.buildWatchlistSymbolKey(exchange, sym) === wanted);
    if (!wanted || !matches) return false;

    const seconds = TIMEFRAME_SECONDS[state.timeframe] || 300;
    // Bucket in IST, matching the history API's own day boundaries; a UTC-bucketed daily bar
    // would roll over at 05:30 IST, mid-session for crypto.
    const nowSec = Math.floor((quote.ltpTs || Date.now()) / 1000);
    const bucket = Math.floor((nowSec + IST_OFFSET_SECONDS) / seconds) * seconds - IST_OFFSET_SECONDS;

    const candles = this.chartCandles || [];
    const last = candles[candles.length - 1];

    // A tick older than the bar already drawn is a late or replayed message - folding it in
    // would rewrite a closed bar with a stale price.
    if (last && bucket < last.ts) return false;

    // Broker quotes report volume CUMULATIVELY for the session, not per bar. Assigning it
    // straight to the bar would make the live candle's volume the whole day's and drag VWAP
    // toward it, so the bar's own volume is the delta since the bar opened.
    const cumulative = Number(quote.volume);
    const haveVolume = Number.isFinite(cumulative) && cumulative >= 0 && !isSentinel(cumulative);

    let bar;
    if (last && last.ts === bucket) {
      bar = last;
      bar.close = ltp;
      if (ltp > bar.high) bar.high = ltp;
      if (ltp < bar.low) bar.low = ltp;
      // A cumulative counter that went backwards means a new session or a feed reset; treat the
      // reading as the new baseline rather than emitting a negative volume.
      if (haveVolume && bar._volBase !== undefined) {
        bar.volume = cumulative >= bar._volBase ? cumulative - bar._volBase : 0;
        if (cumulative < bar._volBase) bar._volBase = cumulative;
      }
    } else {
      // `last` just closed - feed it to the active chart-type transform (Renko etc.), if any,
      // BEFORE starting the new bar. These transforms are built from discrete completed price
      // movements, not intrabar noise, so they only ever see finished bars.
      if (last && typeof this.feedChartTransformOnClose === 'function') {
        this.feedChartTransformOnClose(last);
      }
      bar = { ts: bucket, open: ltp, high: ltp, low: ltp, close: ltp, volume: 0 };
      if (haveVolume) bar._volBase = cumulative;
      candles.push(bar);
      this.chartCandles = candles;
    }

    if (this.volumeSeries && haveVolume) {
      const css = getComputedStyle(document.documentElement);
      const up = css.getPropertyValue('--color-profit-bg').trim() || 'rgba(52,211,153,0.5)';
      const down = css.getPropertyValue('--color-loss-bg').trim() || 'rgba(248,113,113,0.5)';
      try {
        this.volumeSeries.update({
          time: bar.ts,
          value: bar.volume,
          color: bar.close >= bar.open ? up : down,
        });
      } catch (_) { /* series disposed */ }
    }

    // No display-time shift needed: the engine renders IST natively from raw UTC seconds. Skipped
    // while a chart-type transform is active (Renko etc.) - the forming real bar's intrabar
    // movement isn't what those series render; only completed bars reach them, via
    // feedChartTransformOnClose() above.
    if (!this._chartType?.transform) {
      this.candleSeries.update({
        time: bar.ts,
        open: bar.open, high: bar.high, low: bar.low, close: bar.close,
      });
    }

    // Only a WS-sourced tick counts as proof WS is delivering FOR THIS SYMBOL - stamping it on
    // REST-polled ticks too would make the poll's own success look like "WS is fine" and starve
    // itself right back into the gap it exists to cover (see startChartLiveUpdates's gate).
    if (fromWs) this.lastChartTickAt = Date.now();

    this.chartLastBar = bar;
    this.chartLastPrice = bar.close;
    this.renderChartLegend();
    this.updateTicketPrices();
    this.refreshLiveIndicators();
    if (typeof this.feedProfileTick === 'function') this.feedProfileTick(quote);
    if (typeof this.pushOrderLinesLtp === 'function') this.pushOrderLinesLtp();
    return true;
  },
});
