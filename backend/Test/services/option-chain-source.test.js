import assert from 'assert';
import test, { before, afterEach } from 'node:test';

import { useTestDb } from '../helpers/db.js';
import db from '../../src/core/database.js';
import openalgoClient from '../../src/integrations/openalgo/client.js';
import marketDataInstanceService from '../../src/services/market-data-instance.service.js';
import optionsResolutionService from '../../src/services/options-resolution.service.js';
import optionChainService from '../../src/services/option-chain.service.js';
import instrumentsService from '../../src/services/instruments.service.js';

/**
 * P3-6: the strike list has one source, the instruments table. The broker /optionchain only adds
 * quotes and Greeks to those rows. No broker is reached.
 */

const EXPIRY = '2099-12-29';
const STRIKES = [22300, 22400, 22500, 22600, 22700];
const sym = (strike, type) => `NIFTY29DEC99${strike}${type}`;

const stubs = [];
function stub(obj, key, fn) {
  stubs.push([obj, key, obj[key]]);
  obj[key] = fn;
}
afterEach(() => { while (stubs.length) { const [o, k, v] = stubs.pop(); o[k] = v; } });

before(async () => {
  await useTestDb('option-chain-source');
  const insert = (symbol, exchange, type, key, expiry, strike) => db.run(
    'INSERT INTO instruments (symbol, name, exchange, instrumenttype, underlying_key, expiry, strike, lotsize, tick_size) VALUES (?, ?, ?, ?, ?, ?, ?, 75, 0.05)',
    [symbol, key || symbol, exchange, type, key, expiry, strike]
  );
  await insert('NIFTY', 'NSE_INDEX', 'INDEX', null, null, null);
  for (const strike of STRIKES) {
    await insert(sym(strike, 'CE'), 'NFO', 'CE', 'NIFTY', EXPIRY, strike);
    await insert(sym(strike, 'PE'), 'NFO', 'PE', 'NIFTY', EXPIRY, strike);
  }
  await insert('CRUDEOILM19DEC996000CE', 'MCX', 'CE', 'CRUDEOILM', EXPIRY, 6000);
});

test('order strike resolution never asks the broker chain, even when the instance supports it', async () => {
  let brokerCalls = 0;
  stub(openalgoClient, 'getOptionChain', async () => { brokerCalls += 1; throw new Error('must not be called'); });

  const resolved = await optionsResolutionService.resolveOptionSymbol({
    underlying: 'NIFTY', exchange: 'NFO', expiry: EXPIRY, optionType: 'CE', strikeOffset: 'ATM', ltp: 22510,
    instance: { id: 1, supports_option_chain: 1 },
  });

  assert.strictEqual(brokerCalls, 0);
  assert.strictEqual(resolved.symbol, sym(22500, 'CE'));
});

test('the chart chain keeps the instruments strikes and only takes quotes from the broker chain', async () => {
  stub(marketDataInstanceService, 'getPoolForEndpoint', async () => [
    { id: 1, name: 't', broker: 'kotak', health_status: 'healthy', supports_multiquotes: 1 },
  ]);
  stub(openalgoClient, 'getOptionChain', async () => ({
    quotes_included: true,
    underlying_ltp: 22510,
    atm_strike: 22500,
    chain: [
      { strike: 22500, ce: { symbol: sym(22500, 'CE'), ltp: 120 }, pe: { symbol: sym(22500, 'PE'), ltp: 110 } },
      { strike: 99999, ce: { symbol: 'NIFTY29DEC9999999CE', ltp: 1 }, pe: null },
    ],
  }));
  stub(openalgoClient, 'getQuotes', async () => ({ quotes: [{ ltp: 22510 }] }));
  stub(openalgoClient, 'getMultiQuotes', async () => { throw new Error('quotes_included: no multiquotes call'); });

  const chain = await optionChainService.getOptionChain('NIFTY', EXPIRY, null, true);

  assert.deepStrictEqual(chain.rows.map((r) => r.strike), STRIKES);
  const atm = chain.rows.find((r) => r.strike === 22500);
  assert.strictEqual(atm.ce.ltp, 120);
  assert.strictEqual(atm.pe.ltp, 110);
  assert.strictEqual(atm.ce.lotsize, 75, 'lot size comes from instruments');
  assert.strictEqual(chain.atm_strike, 22500);
});

test('buildOptionChain matches the underlying key exactly, never a symbol prefix', async () => {
  const chain = await instrumentsService.buildOptionChain('CRUDE', EXPIRY, 'MCX');
  assert.deepStrictEqual(chain.strikes, []);
});
