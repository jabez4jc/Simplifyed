import assert from 'assert';
import test, { before } from 'node:test';

import { useTestDb } from '../helpers/db.js';
import db from '../../src/core/database.js';
import instrumentsService from '../../src/services/instruments.service.js';
import instanceService from '../../src/services/instance.service.js';
import openalgoClient from '../../src/integrations/openalgo/client.js';

/** A failed exchange download leaves that exchange's cached instruments in place. */

before(async () => {
  await useTestDb('instruments-fetch');
  await db.run('DELETE FROM instruments');
  for (const [ex, sym] of [['NFO', 'OLDNFOFUT'], ['NSE', 'OLDNSE']]) {
    await db.run(
      "INSERT INTO instruments (symbol, name, exchange, lotsize, instrumenttype, created_at, updated_at) VALUES (?, ?, ?, 1, 'EQ', datetime('now'), datetime('now'))",
      [sym, sym, ex]
    );
  }
});

test('an NFO download that times out keeps the cached NFO rows; other exchanges are replaced', async () => {
  const realGet = openalgoClient.getInstruments;
  const realInstance = instanceService.getInstanceById;
  instanceService.getInstanceById = async () => ({ id: 6, name: 'Jz Fyers', broker: 'fyers', host_url: 'http://x', api_key: 'k' });
  openalgoClient.getInstruments = async (_inst, exchange) => {
    if (exchange === 'NFO') throw new Error('The operation was aborted due to timeout');
    if (exchange === 'NSE') return [{ symbol: 'NEWNSE', name: 'NEWNSE', exchange: 'NSE', lotsize: '1', instrumenttype: 'EQ' }];
    return [];
  };
  try {
    await instrumentsService.fetchFromInstance(6);
  } finally {
    openalgoClient.getInstruments = realGet;
    instanceService.getInstanceById = realInstance;
  }
  const rows = await db.all('SELECT exchange, symbol FROM instruments ORDER BY exchange');
  assert.deepStrictEqual(rows, [{ exchange: 'NFO', symbol: 'OLDNFOFUT' }, { exchange: 'NSE', symbol: 'NEWNSE' }]);
});
