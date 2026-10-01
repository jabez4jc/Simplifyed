import test from 'node:test';
import assert from 'node:assert/strict';
import openalgoClient from '../../src/integrations/openalgo/client.js';
import { getLivePosition } from '../../src/utils/order-helpers.js';

const instance = { id: 1, name: 'T' };
const params = { symbol: 'NIFTY28OCT2625000CE', exchange: 'NFO', product: 'MIS' };

async function withPositionBook(fn, run) {
  const orig = openalgoClient.getPositionBook;
  openalgoClient.getPositionBook = fn;
  try { return await run(); } finally { openalgoClient.getPositionBook = orig; }
}

test('an empty positionbook is a flat account: 0, not null', async () => {
  assert.equal(await withPositionBook(async () => [], () => getLivePosition(instance, params)), 0);
});

test('a failed positionbook read is null, so the caller refuses to size the order', async () => {
  const res = await withPositionBook(async () => { throw new Error('boom'); }, () => getLivePosition(instance, params));
  assert.equal(res, null);
});

test('returns the held quantity for the matching symbol/exchange/product only', async () => {
  const book = [
    { symbol: 'OTHER', exchange: 'NFO', product: 'MIS', quantity: '75' },
    { symbol: params.symbol, exchange: 'NFO', product: 'NRML', quantity: '150' },
    { symbol: params.symbol, exchange: 'NFO', product: 'MIS', quantity: '-50' },
  ];
  assert.equal(await withPositionBook(async () => book, () => getLivePosition(instance, params)), -50);
});
