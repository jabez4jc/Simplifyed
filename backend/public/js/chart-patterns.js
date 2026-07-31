/**
 * Candlestick pattern detection.
 *
 * Pure functions over candles, no DOM and no charting types, for the same reason the indicator
 * maths lives apart: a wrong pattern is invisible on a chart. A mislabelled Hammer still draws a
 * neat marker under a bar and reads as a signal, so the rules are stated explicitly here and
 * pinned by tests rather than tuned until the picture looks plausible.
 *
 * Every detector returns true/false for the candle at index `i`, given the full series. Patterns
 * that need N bars simply return false when there is not enough history - never a partial match.
 *
 * A note on trend context. Several classical patterns (Hammer, Hanging Man, Morning Star) are
 * only meaningful after a move in a given direction; the same three bars mean opposite things in
 * an uptrend and a downtrend. Trend is approximated with the slope of the preceding closes over
 * TREND_LOOKBACK bars. That is a heuristic, not a market structure model - it is what keeps a
 * Hammer from being flagged at the top of a rally, which is the failure that matters.
 */
(function (global) {
  'use strict';

  const TREND_LOOKBACK = 5;

  // A "long" body relative to recent bars. Absolute thresholds do not travel across instruments -
  // 20 points is a big NIFTY candle and noise on BTC - so everything is measured against the
  // average range of the preceding bars.
  const AVG_LOOKBACK = 10;

  const body = (c) => Math.abs(c.close - c.open);
  const range = (c) => c.high - c.low;
  const upperShadow = (c) => c.high - Math.max(c.open, c.close);
  const lowerShadow = (c) => Math.min(c.open, c.close) - c.low;
  const isBull = (c) => c.close > c.open;
  const isBear = (c) => c.close < c.open;
  const mid = (c) => (c.open + c.close) / 2;

  /** Body no more than 5% of the bar's range - the conventional doji tolerance. */
  const isDoji = (c) => range(c) > 0 && body(c) <= range(c) * 0.05;

  /** Mean range of the AVG_LOOKBACK bars before `i`, used to judge "long" and "short". */
  function avgRange(candles, i) {
    const from = Math.max(0, i - AVG_LOOKBACK);
    if (i <= from) return range(candles[i]) || 1;
    let sum = 0;
    for (let k = from; k < i; k += 1) sum += range(candles[k]);
    return sum / (i - from) || 1;
  }

  const isLongBody = (candles, i) => body(candles[i]) > avgRange(candles, i) * 0.6;
  const isShortBody = (candles, i) => body(candles[i]) < avgRange(candles, i) * 0.3;

  /**
   * Direction of the run leading INTO bar i (bar i itself excluded - it is the signal, not the
   * context). Returns 1 for up, -1 for down, 0 for neither.
   */
  function trendBefore(candles, i) {
    const from = i - TREND_LOOKBACK;
    if (from < 0) return 0;
    const first = candles[from].close;
    const last = candles[i - 1].close;
    const move = last - first;
    const threshold = avgRange(candles, i) * 0.5;
    if (move > threshold) return 1;
    if (move < -threshold) return -1;
    return 0;
  }

  const gapUp = (prev, cur) => cur.low > prev.high;
  const gapDown = (prev, cur) => cur.high < prev.low;

  /**
   * Detectors, keyed by id. Each is `(candles, i) => boolean`.
   *
   * `bullish` on the definition drives the default marker colour and placement, and is also what
   * the UI groups by; it is not used by the maths.
   *
   * `short` is what gets drawn on the chart. Full names are unreadable at any real bar density -
   * "Bearish Engulfing" is wider than a dozen candles - so the marker carries a code and the full
   * name stays in the pattern picker. Codes are three characters where possible, with a trailing
   * + or - only where a pattern has a bullish and a bearish twin that would otherwise collide.
   */
  const PATTERNS = [
    // --- single bar ------------------------------------------------------------------------
    {
      id: 'doji', label: 'Doji', short: 'DOJI', bullish: null,
      fn: (c, i) => isDoji(c[i]),
    },
    {
      id: 'dragonflyDoji', label: 'Dragonfly Doji', short: 'DFD', bullish: true,
      fn: (c, i) => isDoji(c[i]) && lowerShadow(c[i]) > range(c[i]) * 0.6 && upperShadow(c[i]) <= range(c[i]) * 0.1,
    },
    {
      id: 'gravestoneDoji', label: 'Gravestone Doji', short: 'GSD', bullish: false,
      fn: (c, i) => isDoji(c[i]) && upperShadow(c[i]) > range(c[i]) * 0.6 && lowerShadow(c[i]) <= range(c[i]) * 0.1,
    },
    {
      id: 'hammer', label: 'Hammer', short: 'HMR', bullish: true,
      fn: (c, i) => trendBefore(c, i) === -1 && !isDoji(c[i])
        && lowerShadow(c[i]) >= body(c[i]) * 2 && upperShadow(c[i]) <= range(c[i]) * 0.15,
    },
    {
      id: 'hangingMan', label: 'Hanging Man', short: 'HGM', bullish: false,
      // Identical shape to the Hammer; only the preceding trend separates them.
      fn: (c, i) => trendBefore(c, i) === 1 && !isDoji(c[i])
        && lowerShadow(c[i]) >= body(c[i]) * 2 && upperShadow(c[i]) <= range(c[i]) * 0.15,
    },
    {
      id: 'invertedHammer', label: 'Inverted Hammer', short: 'IHM', bullish: true,
      fn: (c, i) => trendBefore(c, i) === -1 && !isDoji(c[i])
        && upperShadow(c[i]) >= body(c[i]) * 2 && lowerShadow(c[i]) <= range(c[i]) * 0.15,
    },
    {
      id: 'shootingStar', label: 'Shooting Star', short: 'SHS', bullish: false,
      fn: (c, i) => trendBefore(c, i) === 1 && !isDoji(c[i])
        && upperShadow(c[i]) >= body(c[i]) * 2 && lowerShadow(c[i]) <= range(c[i]) * 0.15,
    },
    {
      id: 'marubozuWhite', label: 'Marubozu White', short: 'MBW', bullish: true,
      fn: (c, i) => isBull(c[i]) && isLongBody(c, i)
        && upperShadow(c[i]) <= range(c[i]) * 0.03 && lowerShadow(c[i]) <= range(c[i]) * 0.03,
    },
    {
      id: 'marubozuBlack', label: 'Marubozu Black', short: 'MBB', bullish: false,
      fn: (c, i) => isBear(c[i]) && isLongBody(c, i)
        && upperShadow(c[i]) <= range(c[i]) * 0.03 && lowerShadow(c[i]) <= range(c[i]) * 0.03,
    },
    {
      id: 'spinningTopWhite', label: 'Spinning Top White', short: 'STW', bullish: null,
      fn: (c, i) => isBull(c[i]) && !isDoji(c[i]) && isShortBody(c, i)
        && upperShadow(c[i]) > body(c[i]) && lowerShadow(c[i]) > body(c[i]),
    },
    {
      id: 'spinningTopBlack', label: 'Spinning Top Black', short: 'STB', bullish: null,
      fn: (c, i) => isBear(c[i]) && !isDoji(c[i]) && isShortBody(c, i)
        && upperShadow(c[i]) > body(c[i]) && lowerShadow(c[i]) > body(c[i]),
    },
    {
      id: 'longLowerShadow', label: 'Long Lower Shadow', short: 'LLS', bullish: true,
      fn: (c, i) => range(c[i]) > 0 && lowerShadow(c[i]) >= range(c[i]) * 0.66,
    },
    {
      id: 'longUpperShadow', label: 'Long Upper Shadow', short: 'LUS', bullish: false,
      fn: (c, i) => range(c[i]) > 0 && upperShadow(c[i]) >= range(c[i]) * 0.66,
    },

    // --- two bars --------------------------------------------------------------------------
    {
      id: 'engulfingBullish', label: 'Bullish Engulfing', short: 'ENG+', bullish: true,
      fn: (c, i) => i >= 1 && isBear(c[i - 1]) && isBull(c[i])
        && c[i].close > c[i - 1].open && c[i].open < c[i - 1].close,
    },
    {
      id: 'engulfingBearish', label: 'Bearish Engulfing', short: 'ENG-', bullish: false,
      fn: (c, i) => i >= 1 && isBull(c[i - 1]) && isBear(c[i])
        && c[i].open > c[i - 1].close && c[i].close < c[i - 1].open,
    },
    {
      id: 'haramiBullish', label: 'Harami Bullish', short: 'HAR+', bullish: true,
      fn: (c, i) => i >= 1 && isBear(c[i - 1]) && isLongBody(c, i - 1) && isBull(c[i])
        && c[i].open > c[i - 1].close && c[i].close < c[i - 1].open,
    },
    {
      id: 'haramiBearish', label: 'Harami Bearish', short: 'HAR-', bullish: false,
      fn: (c, i) => i >= 1 && isBull(c[i - 1]) && isLongBody(c, i - 1) && isBear(c[i])
        && c[i].open < c[i - 1].close && c[i].close > c[i - 1].open,
    },
    {
      id: 'haramiCrossBullish', label: 'Harami Cross Bullish', short: 'HRC+', bullish: true,
      fn: (c, i) => i >= 1 && isBear(c[i - 1]) && isLongBody(c, i - 1) && isDoji(c[i])
        && c[i].high < c[i - 1].open && c[i].low > c[i - 1].close,
    },
    {
      id: 'haramiCrossBearish', label: 'Harami Cross Bearish', short: 'HRC-', bullish: false,
      fn: (c, i) => i >= 1 && isBull(c[i - 1]) && isLongBody(c, i - 1) && isDoji(c[i])
        && c[i].high < c[i - 1].close && c[i].low > c[i - 1].open,
    },
    {
      id: 'piercing', label: 'Piercing', short: 'PRC', bullish: true,
      fn: (c, i) => i >= 1 && isBear(c[i - 1]) && isLongBody(c, i - 1) && isBull(c[i])
        && c[i].open < c[i - 1].low && c[i].close > mid(c[i - 1]) && c[i].close < c[i - 1].open,
    },
    {
      id: 'darkCloudCover', label: 'Dark Cloud Cover', short: 'DCC', bullish: false,
      fn: (c, i) => i >= 1 && isBull(c[i - 1]) && isLongBody(c, i - 1) && isBear(c[i])
        && c[i].open > c[i - 1].high && c[i].close < mid(c[i - 1]) && c[i].close > c[i - 1].open,
    },
    {
      id: 'kickingBullish', label: 'Kicking Bullish', short: 'KCK+', bullish: true,
      fn: (c, i) => i >= 1 && isBear(c[i - 1]) && isBull(c[i])
        && upperShadow(c[i - 1]) <= range(c[i - 1]) * 0.03 && lowerShadow(c[i - 1]) <= range(c[i - 1]) * 0.03
        && upperShadow(c[i]) <= range(c[i]) * 0.03 && lowerShadow(c[i]) <= range(c[i]) * 0.03
        && gapUp(c[i - 1], c[i]),
    },
    {
      id: 'kickingBearish', label: 'Kicking Bearish', short: 'KCK-', bullish: false,
      fn: (c, i) => i >= 1 && isBull(c[i - 1]) && isBear(c[i])
        && upperShadow(c[i - 1]) <= range(c[i - 1]) * 0.03 && lowerShadow(c[i - 1]) <= range(c[i - 1]) * 0.03
        && upperShadow(c[i]) <= range(c[i]) * 0.03 && lowerShadow(c[i]) <= range(c[i]) * 0.03
        && gapDown(c[i - 1], c[i]),
    },
    {
      id: 'tweezerBottom', label: 'Tweezer Bottom', short: 'TWB', bullish: true,
      fn: (c, i) => i >= 1 && trendBefore(c, i) === -1 && isBear(c[i - 1]) && isBull(c[i])
        && Math.abs(c[i].low - c[i - 1].low) <= avgRange(c, i) * 0.05,
    },
    {
      id: 'tweezerTop', label: 'Tweezer Top', short: 'TWT', bullish: false,
      fn: (c, i) => i >= 1 && trendBefore(c, i) === 1 && isBull(c[i - 1]) && isBear(c[i])
        && Math.abs(c[i].high - c[i - 1].high) <= avgRange(c, i) * 0.05,
    },
    {
      id: 'onNeck', label: 'On Neck', short: 'ONK', bullish: false,
      fn: (c, i) => i >= 1 && isBear(c[i - 1]) && isLongBody(c, i - 1) && isBull(c[i])
        && c[i].open < c[i - 1].low && Math.abs(c[i].close - c[i - 1].close) <= avgRange(c, i) * 0.05,
    },
    {
      id: 'risingWindow', label: 'Rising Window', short: 'RWN', bullish: true,
      fn: (c, i) => i >= 1 && gapUp(c[i - 1], c[i]),
    },
    {
      id: 'fallingWindow', label: 'Falling Window', short: 'FWN', bullish: false,
      fn: (c, i) => i >= 1 && gapDown(c[i - 1], c[i]),
    },
    {
      id: 'dojiStarBullish', label: 'Doji Star Bullish', short: 'DST+', bullish: true,
      fn: (c, i) => i >= 1 && isBear(c[i - 1]) && isLongBody(c, i - 1) && isDoji(c[i])
        && c[i].high < c[i - 1].close,
    },
    {
      id: 'dojiStarBearish', label: 'Doji Star Bearish', short: 'DST-', bullish: false,
      fn: (c, i) => i >= 1 && isBull(c[i - 1]) && isLongBody(c, i - 1) && isDoji(c[i])
        && c[i].low > c[i - 1].close,
    },

    // --- three bars ------------------------------------------------------------------------
    {
      id: 'morningStar', label: 'Morning Star', short: 'MST', bullish: true,
      fn: (c, i) => i >= 2 && isBear(c[i - 2]) && isLongBody(c, i - 2)
        && isShortBody(c, i - 1) && c[i - 1].high < c[i - 2].close
        && isBull(c[i]) && c[i].close > mid(c[i - 2]),
    },
    {
      id: 'morningDojiStar', label: 'Morning Doji Star', short: 'MDS', bullish: true,
      fn: (c, i) => i >= 2 && isBear(c[i - 2]) && isLongBody(c, i - 2)
        && isDoji(c[i - 1]) && c[i - 1].high < c[i - 2].close
        && isBull(c[i]) && c[i].close > mid(c[i - 2]),
    },
    {
      id: 'eveningStar', label: 'Evening Star', short: 'EST', bullish: false,
      fn: (c, i) => i >= 2 && isBull(c[i - 2]) && isLongBody(c, i - 2)
        && isShortBody(c, i - 1) && c[i - 1].low > c[i - 2].close
        && isBear(c[i]) && c[i].close < mid(c[i - 2]),
    },
    {
      id: 'eveningDojiStar', label: 'Evening Doji Star', short: 'EDS', bullish: false,
      fn: (c, i) => i >= 2 && isBull(c[i - 2]) && isLongBody(c, i - 2)
        && isDoji(c[i - 1]) && c[i - 1].low > c[i - 2].close
        && isBear(c[i]) && c[i].close < mid(c[i - 2]),
    },
    {
      id: 'abandonedBabyBullish', label: 'Abandoned Baby Bullish', short: 'ABB+', bullish: true,
      // The defining feature is the isolating gap on BOTH sides of the doji - shadows must not
      // overlap at all, which is what separates it from an ordinary Morning Doji Star.
      fn: (c, i) => i >= 2 && isBear(c[i - 2]) && isDoji(c[i - 1])
        && gapDown(c[i - 2], c[i - 1]) && gapUp(c[i - 1], c[i]) && isBull(c[i]),
    },
    {
      id: 'abandonedBabyBearish', label: 'Abandoned Baby Bearish', short: 'ABB-', bullish: false,
      fn: (c, i) => i >= 2 && isBull(c[i - 2]) && isDoji(c[i - 1])
        && gapUp(c[i - 2], c[i - 1]) && gapDown(c[i - 1], c[i]) && isBear(c[i]),
    },
    {
      id: 'triStarBullish', label: 'Tri Star Bullish', short: 'TRI+', bullish: true,
      fn: (c, i) => i >= 2 && trendBefore(c, i) === -1
        && isDoji(c[i - 2]) && isDoji(c[i - 1]) && isDoji(c[i]),
    },
    {
      id: 'triStarBearish', label: 'Tri Star Bearish', short: 'TRI-', bullish: false,
      fn: (c, i) => i >= 2 && trendBefore(c, i) === 1
        && isDoji(c[i - 2]) && isDoji(c[i - 1]) && isDoji(c[i]),
    },
    {
      id: 'threeWhiteSoldiers', label: 'Three White Soldiers', short: '3WS', bullish: true,
      fn: (c, i) => i >= 2
        && isBull(c[i - 2]) && isBull(c[i - 1]) && isBull(c[i])
        && c[i - 1].close > c[i - 2].close && c[i].close > c[i - 1].close
        && c[i - 1].open > c[i - 2].open && c[i - 1].open < c[i - 2].close
        && c[i].open > c[i - 1].open && c[i].open < c[i - 1].close
        && upperShadow(c[i - 1]) < body(c[i - 1]) && upperShadow(c[i]) < body(c[i]),
    },
    {
      id: 'threeBlackCrows', label: 'Three Black Crows', short: '3BC', bullish: false,
      fn: (c, i) => i >= 2
        && isBear(c[i - 2]) && isBear(c[i - 1]) && isBear(c[i])
        && c[i - 1].close < c[i - 2].close && c[i].close < c[i - 1].close
        && c[i - 1].open < c[i - 2].open && c[i - 1].open > c[i - 2].close
        && c[i].open < c[i - 1].open && c[i].open > c[i - 1].close
        && lowerShadow(c[i - 1]) < body(c[i - 1]) && lowerShadow(c[i]) < body(c[i]),
    },
    {
      id: 'upsideTasukiGap', label: 'Upside Tasuki Gap', short: 'UTG', bullish: true,
      fn: (c, i) => i >= 2 && isBull(c[i - 2]) && isBull(c[i - 1]) && gapUp(c[i - 2], c[i - 1])
        && isBear(c[i]) && c[i].open > c[i - 1].open && c[i].open < c[i - 1].close
        && c[i].close < c[i - 1].open && c[i].close > c[i - 2].close,
    },
    {
      id: 'downsideTasukiGap', label: 'Downside Tasuki Gap', short: 'DTG', bullish: false,
      fn: (c, i) => i >= 2 && isBear(c[i - 2]) && isBear(c[i - 1]) && gapDown(c[i - 2], c[i - 1])
        && isBull(c[i]) && c[i].open < c[i - 1].open && c[i].open > c[i - 1].close
        && c[i].close > c[i - 1].open && c[i].close < c[i - 2].close,
    },

    // --- five bars -------------------------------------------------------------------------
    {
      id: 'risingThreeMethods', label: 'Rising Three Methods', short: 'R3M', bullish: true,
      fn: (c, i) => {
        if (i < 4) return false;
        const [a, b1, b2, b3, e] = [c[i - 4], c[i - 3], c[i - 2], c[i - 1], c[i]];
        return isBull(a) && isLongBody(c, i - 4) && isBull(e) && isLongBody(c, i)
          && [b1, b2, b3].every((x) => x.high <= a.high && x.low >= a.low)
          && e.close > a.close;
      },
    },
    {
      id: 'fallingThreeMethods', label: 'Falling Three Methods', short: 'F3M', bullish: false,
      fn: (c, i) => {
        if (i < 4) return false;
        const [a, b1, b2, b3, e] = [c[i - 4], c[i - 3], c[i - 2], c[i - 1], c[i]];
        return isBear(a) && isLongBody(c, i - 4) && isBear(e) && isLongBody(c, i)
          && [b1, b2, b3].every((x) => x.high <= a.high && x.low >= a.low)
          && e.close < a.close;
      },
    },
  ];

  const BY_ID = new Map(PATTERNS.map((p) => [p.id, p]));

  /**
   * Detect the enabled patterns across a candle series.
   *
   * @param {Array} candles oldest-first, each `{ time, open, high, low, close }`
   * @param {Iterable<string>} enabled pattern ids to look for
   * @returns {Array} `{ time, id, label, bullish }`, one entry per hit, in bar order
   */
  function detect(candles, enabled) {
    if (!Array.isArray(candles) || !candles.length) return [];
    const wanted = [...(enabled || [])].map((id) => BY_ID.get(id)).filter(Boolean);
    if (!wanted.length) return [];

    const out = [];
    for (let i = 0; i < candles.length; i += 1) {
      for (const def of wanted) {
        let hit = false;
        // A malformed bar (a null OHLC from a thin contract) must not take the whole chart down.
        try { hit = def.fn(candles, i); } catch (_) { hit = false; }
        if (hit) {
          out.push({
            time: candles[i].time, id: def.id,
            label: def.label, short: def.short, bullish: def.bullish,
          });
        }
      }
    }
    return out;
  }

  const api = { PATTERNS, detect, isDoji, trendBefore, avgRange };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.ChartPatterns = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
