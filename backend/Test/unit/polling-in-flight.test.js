import assert from 'assert';
import test from 'node:test';

import pollingService from '../../src/services/polling.service.js';
import instanceService from '../../src/services/instance.service.js';
import orderService from '../../src/services/order.service.js';
import marketCalendarService from '../../src/services/market-calendar.service.js';

// H16: a slow broker must not let poll cycles pile up on one instance.
test('pollInstance called twice concurrently runs the work once', async () => {
  const real = {
    get: instanceService.getInstanceById,
    analyzer: instanceService.refreshAnalyzerStatus,
    pnl: instanceService.updatePnLData,
    open: marketCalendarService.isInstanceMarketOpen,
    sync: orderService.syncOrderStatus,
  };
  let pnlRuns = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  instanceService.getInstanceById = async (id) => ({ id, is_active: 1, health_status: 'healthy' });
  instanceService.refreshAnalyzerStatus = async () => {};
  instanceService.updatePnLData = async () => { pnlRuns += 1; await gate; };
  marketCalendarService.isInstanceMarketOpen = async () => true;
  orderService.syncOrderStatus = async () => {};
  try {
    const first = pollingService.pollInstance(501);
    const second = await pollingService.pollInstance(501);
    assert.deepStrictEqual(second, { skipped: true, reason: 'in_flight' });
    release();
    await first;
    assert.strictEqual(pnlRuns, 1);

    // Once the first cycle is done the instance can be polled again.
    await pollingService.pollInstance(501);
    assert.strictEqual(pnlRuns, 2);
  } finally {
    instanceService.getInstanceById = real.get;
    instanceService.refreshAnalyzerStatus = real.analyzer;
    instanceService.updatePnLData = real.pnl;
    marketCalendarService.isInstanceMarketOpen = real.open;
    orderService.syncOrderStatus = real.sync;
  }
});
