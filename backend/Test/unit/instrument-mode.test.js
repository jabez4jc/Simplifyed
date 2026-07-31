import assert from 'assert';
import test from 'node:test';
import riskControlsService from '../../src/services/risk-controls.service.js';

/**
 * _determineMode picks which risk-column set auto-exit reads
 * (target_points_<mode> / stoploss_points_<mode>), and the chart uses it to decide whether an
 * order is sized in lots or units. Getting it wrong is silent: stops configured on one tab are
 * simply never consulted.
 */

const mode = (symbol, entry = {}) => riskControlsService._determineMode(entry, symbol);

test('symbol_type is authoritative and wins over the name', () => {
  assert.strictEqual(mode('RELIANCE', { symbol_type: 'EQUITY' }), 'direct');
  assert.strictEqual(mode('ANYTHING', { symbol_type: 'OPTIONS' }), 'options');
  assert.strictEqual(mode('ANYTHING', { symbol_type: 'FUTURES' }), 'futures');
  assert.strictEqual(mode('SENSEX', { symbol_type: 'INDEX' }), 'futures');
});

test('equities containing CE or PE in their name are not options', () => {
  // The regression this guards: `symbol.includes('CE')` matched RELIAN-CE, so every one of
  // these was classified 'options' and had its Direct-tab stops silently ignored.
  for (const sym of ['RELIANCE', 'CESC', 'CEATLTD', 'PEL', 'ACE', 'PERSISTENT', 'PETRONET']) {
    assert.strictEqual(mode(sym), 'direct', `${sym} must be direct/equity`);
  }
});

test('real option symbols are still detected without a symbol_type', () => {
  for (const sym of ['NIFTY26JUL24000CE', 'BANKNIFTY26JUL52000PE', 'NATGASMINI24JUL26280CE']) {
    assert.strictEqual(mode(sym), 'options', `${sym} must be options`);
  }
});

test('futures are detected by an anchored FUT suffix', () => {
  assert.strictEqual(mode('NATGASMINI28JUL26FUT'), 'futures');
  assert.strictEqual(mode('BTCUSDFUT'), 'futures');
  // "FUT" appearing mid-name must not make an equity a future.
  assert.strictEqual(mode('FUTURAPLY'), 'direct');
});

test('unknown input degrades to direct rather than throwing', () => {
  assert.strictEqual(mode(''), 'direct');
  assert.strictEqual(mode(null), 'direct');
  assert.strictEqual(mode(undefined, undefined), 'direct');
});
