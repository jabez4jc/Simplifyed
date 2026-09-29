/**
 * A stand-in OpenAlgo broker, over real HTTP.
 *
 * The e2e app runs as its own process, so the in-process stubs the integration tests use
 * (Test/helpers/fake-openalgo.js) cannot reach it. Instances seeded for e2e point their
 * host_url at this server instead, so the dashboard gets plausible quotes, positions and order
 * responses without touching anyone's real broker account - and without the UI degrading into
 * error states that would make every assertion about the page ambiguous.
 */

import http from 'http';

const RESPONSES = {
  ping: { status: 'success', data: { broker: 'zerodha', message: 'pong' } },
  analyzer: { status: 'success', data: { mode: 'live', analyze_mode: false, total_logs: 0 } },
  'analyzer/toggle': { status: 'success', data: { mode: 'analyze', analyze_mode: true } },
  funds: {
    status: 'success',
    data: { availablecash: '250000.00', collateral: '0.00', m2mrealized: '1200.00', m2munrealized: '-300.00', utiliseddebits: '5000.00' },
  },
  orderbook: { status: 'success', data: { orders: [], statistics: {} } },
  tradebook: { status: 'success', data: [] },
  positionbook: { status: 'success', data: [] },
  holdings: { status: 'success', data: { holdings: [], statistics: {} } },
  openposition: { status: 'success', data: { quantity: 0 } },
  quotes: { status: 'success', data: { ltp: 1234.5, open: 1200, high: 1250, low: 1190, prev_close: 1210, volume: 98765, bid: 1234.4, ask: 1234.6 } },
  placesmartorder: { status: 'success', orderid: 'E2E-ORDER-1' },
  placeorder: { status: 'success', orderid: 'E2E-ORDER-1' },
  cancelorder: { status: 'success', orderid: 'E2E-ORDER-1' },
  history: { status: 'success', data: [] },
  intervals: { status: 'success', data: { seconds: [], minutes: ['1m', '5m'], days: ['D'] } },
};

export function startFakeBroker(port = 0) {
  const received = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const endpoint = req.url.replace(/^\/api\/v1\//, '').replace(/\?.*$/, '');
      received.push({ endpoint, body: safeParse(body) });

      const payload = RESPONSES[endpoint] ?? { status: 'success', data: {} };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, received });
    });
  });
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
