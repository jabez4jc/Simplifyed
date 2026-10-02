import { test } from 'node:test';
import assert from 'node:assert/strict';
import telegramService from '../../src/services/telegram.service.js';

test('telegram send is a silent no-op when the bot token / chat is unset', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('must not be called'); };
  try {
    assert.deepEqual(await telegramService.broadcastText('hi'), []);
    assert.deepEqual(await telegramService.sendOrderNotification({ symbol: 'X', side: 'buy' }), []);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
