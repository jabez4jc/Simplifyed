import assert from 'assert';
import test from 'node:test';
import { buildGreeksForRows, normalizeLeg } from '../../src/utils/black76-pricing.util.js';

/**
 * /optionchain with_greeks returns opengreeks' values in vollib units (IV %, vega per vol point).
 * The chain must use them as-is (converted to this app's IV-fraction / vega-per-1.00 scale) rather
 * than re-solving IV locally.
 */
const meta = { r: 0.0675, q: 0, T: 30 / 365, spot: 22000, atm_strike: 22000 };

test('server Greeks win over the local solver, converted to the chain units', () => {
  const leg = normalizeLeg({
    symbol: 'NIFTY30DEC2522000CE', ltp: 450,
    implied_volatility: 18, delta: 0.52, gamma: 0.0004, theta: -9.8, vega: 25.1,
  });
  const { rows } = buildGreeksForRows([{ strike: 22000, ce: leg, pe: null }], meta);
  assert.strictEqual(rows[0].ce.iv, 0.18);
  assert.deepStrictEqual(rows[0].ce.greeks, { delta: 0.52, gamma: 0, theta: -9.8, vega: 2510 });
});

test('a leg without server Greeks still gets the local fallback', () => {
  const leg = normalizeLeg({ symbol: 'NIFTY30DEC2522000CE', ltp: 450 });
  const { rows } = buildGreeksForRows([{ strike: 22000, ce: leg, pe: null }], meta);
  assert.ok(rows[0].ce.iv > 0.05 && rows[0].ce.iv < 0.5, `local IV ${rows[0].ce.iv}`);
  assert.ok(rows[0].ce.greeks.delta > 0);
});
