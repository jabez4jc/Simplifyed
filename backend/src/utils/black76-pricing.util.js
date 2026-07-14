/**
 * Black-76 Option Pricing Utilities
 * Pure pricing/greeks/IV-solver functions for commodity/futures-style options (no DB or
 * network access) - extracted from option-chain.service.js, which still owns the impure
 * quote-enrichment/spot-resolution logic that calls these.
 */

export function erfApprox(x) {
  // Abramowitz and Stegun formula 7.1.26
  const sign = x < 0 ? -1 : 1;
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * Math.abs(x));
  const y =
    1 -
    (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x));
  return sign * y;
}

export function normCdf(x) {
  const erfFn = typeof Math.erf === 'function' ? Math.erf : erfApprox;
  return 0.5 * (1 + erfFn(x / Math.sqrt(2)));
}

export function normPdf(x) {
  return (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * x * x);
}

export function d1d2(F, K, T, sigma) {
  const volSqrtT = sigma * Math.sqrt(T);
  const lnFK = Math.log(F / K);
  const d1 = (lnFK + 0.5 * sigma * sigma * T) / volSqrtT;
  const d2 = d1 - volSqrtT;
  return { d1, d2 };
}

export function black76Price(F, K, T, r, sigma, isCall) {
  const { d1, d2 } = d1d2(F, K, T, sigma);
  const disc = Math.exp(-r * T);
  return isCall
    ? disc * (F * normCdf(d1) - K * normCdf(d2))
    : disc * (K * normCdf(-d2) - F * normCdf(-d1));
}

export function black76Greeks(F, K, T, r, sigma, isCall) {
  const { d1, d2 } = d1d2(F, K, T, sigma);
  const disc = Math.exp(-r * T);
  const pdf = normPdf(d1);

  const delta = isCall ? disc * normCdf(d1) : -disc * normCdf(-d1);
  const gamma = disc * pdf / (F * sigma * Math.sqrt(T));
  const vega = disc * F * pdf * Math.sqrt(T);

  const theta =
    -disc * F * pdf * sigma / (2 * Math.sqrt(T)) +
    (isCall
      ? r * disc * (F * normCdf(d1) - K * normCdf(d2))
      : r * disc * (K * normCdf(-d2) - F * normCdf(-d1)));

  return {
    delta,
    gamma,
    vega,
    theta,
    thetaPerDay: theta / 365,
    d1,
    d2,
  };
}

export function impliedVolBlack76(targetPrice, F, K, T, r, isCall, opts = {}) {
  const options = {
    tol: 1e-6,
    maxIter: 100,
    lower: 1e-4,
    upper: 3.0,
    ...opts,
  };

  if (!Number.isFinite(targetPrice) || targetPrice <= 0 || !Number.isFinite(F) || !Number.isFinite(K) || F <= 0 || K <= 0) {
    return 0;
  }

  let lo = options.lower;
  let hi = options.upper;
  let mid = (lo + hi) / 2;

  for (let i = 0; i < options.maxIter; i++) {
    mid = (lo + hi) / 2;
    const price = black76Price(F, K, T, r, mid, isCall);
    const diff = price - targetPrice;
    if (Math.abs(diff) < options.tol) break;
    if (diff > 0) {
      hi = mid;
    } else {
      lo = mid;
    }
  }

  return mid;
}

export function parseExpiryToYearFraction(expiry) {
  if (!expiry) return null;
  const now = new Date();
  let dt = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
    dt = new Date(`${expiry}T15:30:00`);
  } else if (/^\d{2}-[A-Z]{3}-\d{2}$/.test(expiry)) {
    const [d, mon, yy] = expiry.split('-');
    const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const mi = monthNames.indexOf(mon);
    if (mi >= 0) dt = new Date(`20${yy}-${String(mi + 1).padStart(2, '0')}-${d}T15:30:00`);
  } else if (/^\d{2}[A-Z]{3}\d{2}$/.test(expiry)) {
    const d = expiry.slice(0, 2);
    const mon = expiry.slice(2, 5);
    const yy = expiry.slice(5, 7);
    const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const mi = monthNames.indexOf(mon);
    if (mi >= 0) dt = new Date(`20${yy}-${String(mi + 1).padStart(2, '0')}-${d}T15:30:00`);
  }
  if (!dt) return null;
  const ms = dt.getTime() - now.getTime();
  const years = ms / (1000 * 60 * 60 * 24 * 365.25);
  return years > 0 ? years : null;
}

export function riskFreeRateForSymbol(sym) {
  if (!sym) return 0.0675;
  const u = sym.toUpperCase();
  if (u.includes('NIFTY')) return 0.0675;
  if (u.includes('BANKNIFTY')) return 0.0675;
  return 0.0675;
}

export function dividendYieldForSymbol(sym) {
  if (!sym) return 0.012;
  const u = sym.toUpperCase();
  if (u.includes('NIFTY')) return 0.014;
  if (u.includes('BANKNIFTY')) return 0.011;
  return 0.01;
}

export function normalizeLeg(raw) {
  if (!raw) return null;
  const pick = (obj, keys) => {
    for (const k of keys) {
      if (obj[k] !== undefined && obj[k] !== null) return obj[k];
    }
    return null;
  };
  return {
    symbol: raw.symbol || raw.tradingsymbol || '',
    ltp: pick(raw, ['ltp', 'last_price', 'trade_price', 'last', 'price', 'close']),
    bid: pick(raw, ['bid', 'bid_price', 'best_bid_price', 'bidPrice']),
    ask: pick(raw, ['ask', 'ask_price', 'best_ask_price', 'askPrice']),
    volume: pick(raw, ['volume', 'vol', 'traded_volume', 'volumeTraded', 'qty_traded']),
    oi: pick(raw, ['oi', 'open_interest', 'openInterest']),
    lotsize: pick(raw, ['lotsize', 'lot_size', 'lotSize']),
  };
}

export function fillMissingLtp(leg) {
  if (!leg) return leg;
  const hasLtp = Number(leg.ltp || 0) > 0;
  if (!hasLtp) {
    const bid = Number(leg.bid || 0);
    const ask = Number(leg.ask || 0);
    if (bid > 0 && ask > 0) {
      leg.ltp = (bid + ask) / 2;
    } else if (bid > 0) {
      leg.ltp = bid;
    } else if (ask > 0) {
      leg.ltp = ask;
    }
  }
  return leg;
}

export function findNearestAtmRow(rows, atmStrike) {
  if (!rows?.length) return null;
  if (!atmStrike) return rows[Math.floor(rows.length / 2)];
  let best = rows[0];
  let bestDiff = Math.abs(rows[0].strike - atmStrike);
  for (const r of rows) {
    const diff = Math.abs(r.strike - atmStrike);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = r;
    }
  }
  return best;
}

export function computeForwardSet({ spot, atmRow, T, r, q }) {
  const F_carry = Number.isFinite(spot) && spot > 0 ? spot * Math.exp((r - q) * T) : null;
  let F_synth_exact = null;
  let F_synth_simple = null;
  if (atmRow?.strike && atmRow?.ce && atmRow?.pe) {
    const C = Number(atmRow.ce.ltp || 0);
    const P = Number(atmRow.pe.ltp || 0);
    const K = Number(atmRow.strike);
    if (C > 0 || P > 0) {
      F_synth_exact = K + Math.exp(r * T) * (C - P);
      F_synth_simple = K + (C - P);
    }
  }
  return { F_carry, F_synth_exact, F_synth_simple };
}

export function chooseForward(forwardSource, forwards) {
  const order = ['carry', 'synth_exact', 'synth_simple'];
  const requested = forwardSource && order.includes(forwardSource) ? forwardSource : 'carry';
  const value =
    (requested === 'carry' && forwards.F_carry) ||
    (requested === 'synth_exact' && forwards.F_synth_exact) ||
    (requested === 'synth_simple' && forwards.F_synth_simple);
  if (value) return { forwardUsed: requested, forwardValue: value };
  // fallback to first available
  for (const key of order) {
    if (forwards[`F_${key}`]) return { forwardUsed: key, forwardValue: forwards[`F_${key}`] };
  }
  return { forwardUsed: requested, forwardValue: null };
}

export function buildGreeksForRows(rows, meta, forwardSource = 'carry') {
  const round3 = (v) => (Number.isFinite(v) ? Number(v.toFixed(3)) : null);
  const { r, q, T, spot } = meta;
  const forwards = computeForwardSet({
    spot,
    atmRow: findNearestAtmRow(rows, meta.atm_strike || meta.atmStrike),
    T,
    r,
    q,
  });
  const atmRow = findNearestAtmRow(rows, meta.atm_strike || meta.atmStrike);
  const atmStrikeResolved = atmRow?.strike || meta.atm_strike || meta.atmStrike || null;
  const { forwardUsed, forwardValue } = chooseForward(forwardSource, forwards);
  const forwardFallback = forwardValue || atmStrikeResolved || spot || rows[0]?.strike || 1;

  const processedRows = rows.map((row) => {
    const K = Number(row.strike || 0);
    const processLeg = (leg, isCall) => {
      if (!leg) return null;
      const enrichedLeg = fillMissingLtp({ ...leg });
      const ltpNum = Number(enrichedLeg.ltp || 0);
      let iv = null;
      let greeks = null;
      if (ltpNum > 0 && K > 0 && T > 0 && forwardFallback > 0) {
        iv = impliedVolBlack76(ltpNum, forwardFallback, K, T, r, isCall);
        const g = black76Greeks(forwardFallback, K, T, r, iv || 0.0001, isCall);
        greeks = {
          delta: round3(g.delta),
          gamma: round3(g.gamma),
          theta: round3(g.thetaPerDay),
          vega: round3(g.vega),
        };
      }
      return {
        ...enrichedLeg,
        iv: iv !== null ? round3(iv) : null,
        greeks,
      };
    };
    return {
      ...row,
      ce: processLeg(row.ce, true),
      pe: processLeg(row.pe, false),
    };
  });

  const callOi = processedRows.reduce((sum, r) => sum + (Number(r.ce?.oi || 0)), 0);
  const putOi = processedRows.reduce((sum, r) => sum + (Number(r.pe?.oi || 0)), 0);

  return {
    rows: processedRows,
    meta: {
      ...meta,
      ...forwards,
      forward_used: forwardUsed,
      forward_value: forwardFallback,
      atm_strike: atmStrikeResolved,
      call_oi_total: callOi,
      put_oi_total: putOi,
    },
  };
}


export function nearestStrikeToSpot(rows, spot) {
  if (!rows?.length || !Number.isFinite(spot) || spot <= 0) return null;
  let best = rows[0].strike;
  let bestDiff = Math.abs(rows[0].strike - spot);
  for (const r of rows) {
    const diff = Math.abs(r.strike - spot);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = r.strike;
    }
  }
  return best;
}

export function stripDerivativeSuffix(sym) {
  if (!sym) return sym;
  const upper = sym.toUpperCase();
  // Remove common derivative tails like 26DEC25FUT, 30DEC25CE, 30DEC25PE
  const m = upper.match(/^(.*?)(\d{2}[A-Z]{3}\d{2}(FUT|CE|PE))$/);
  if (m && m[1]) return m[1];
  return upper;
}
