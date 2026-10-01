import assert from 'assert';
import test from 'node:test';

import wsGatewayService from '../../src/services/ws-gateway.service.js';

// H11: events for every instance reach the browser, not just those with use_ws_quotes=1 at boot.
test('forwards positions:update for an instance that does not use WS quotes', async () => {
  const sent = [];
  const client = { readyState: 1, OPEN: 1, meta: { topics: new Set() }, send: (m) => sent.push(JSON.parse(m)) };
  wsGatewayService.wss = { clients: new Set([client]) };
  try {
    await wsGatewayService.broadcast('positions:update', { instanceId: 99, positions: [] });
    await wsGatewayService.broadcast('order_update', { instance_id: 123 });
  } finally {
    wsGatewayService.wss = null;
  }
  assert.deepStrictEqual(sent.map((m) => [m.topic, m.payload.instanceId ?? m.payload.instance_id]),
    [['positions:update', 99], ['order_update', 123]]);
  assert.ok(sent.every((m) => !('seq' in m)));
});
