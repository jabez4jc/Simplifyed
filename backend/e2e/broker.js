/**
 * Talks to the REAL brokers from the test process, beside the app under test.
 *
 * The specs drive the dashboard; this is how they check what actually happened at the broker and
 * how they guarantee nothing is left open. It reads the e2e copy of the database (never
 * database/simplifyed.db) for each instance's URL and key.
 *
 * Rules every spec that orders follows:
 *   - assertAnalyzer() before the first order - the broker, not our database, must confirm it;
 *   - flatten() in afterAll for every symbol it ordered, which fails if anything stays open.
 */

import 'dotenv/config';

process.env.DATABASE_PATH = './database/e2e.db';

const { default: db } = await import('../src/core/database.js');
const { default: openalgoClient } = await import('../src/integrations/openalgo/client.js');
const { closeEverythingOpened } = await import('../Test/live/cleanup.js');

let connecting;
async function ready() {
  connecting = connecting || db.connect();
  await connecting;
}

export async function instance(name) {
  await ready();
  const row = await db.get('SELECT * FROM instances WHERE name = ?', [name]);
  if (!row) throw new Error(`instance ${name} is not in the e2e database`);
  return row;
}

export async function assertAnalyzer(name) {
  const inst = await instance(name);
  const status = await openalgoClient.getAnalyzerStatus(inst);
  const on = status?.analyze_mode === true || status?.mode === 'analyze' || status?.mode === 'analyzer';
  if (!on) throw new Error(`REFUSING TO TRADE: ${name} did not confirm analyzer mode at the broker`);
}

/** Net quantity for a symbol across every product row (a book holds one row per product). */
export async function netPosition(name, symbol) {
  const inst = await instance(name);
  const book = await openalgoClient.getPositionBook(inst);
  return (Array.isArray(book) ? book : [])
    .filter((p) => (p.symbol || p.tradingsymbol) === symbol)
    .reduce((sum, p) => sum + Number(p.quantity ?? p.netqty ?? 0), 0);
}

/** Poll until the broker reports `want` (fills in analyzer mode land within a few seconds). */
export async function waitForNet(name, symbol, want, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  let net;
  do {
    net = await netPosition(name, symbol);
    if (net === want) return net;
    await new Promise((r) => setTimeout(r, 1500));
  } while (Date.now() < until);
  return net;
}

/** Cancel and close whatever is open on these symbols; returns what could not be closed. */
export async function flatten(entries) {
  const byInstance = new Map();
  const instances = [];
  for (const { name, symbol, exchange } of entries) {
    const inst = await instance(name);
    if (!byInstance.has(inst.id)) {
      byInstance.set(inst.id, new Map());
      instances.push(inst);
    }
    byInstance.get(inst.id).set(symbol, exchange);
  }
  return closeEverythingOpened(instances, byInstance, () => {}, { includePast: false });
}

/** The TradingView webhook token, from the environment the app also reads. Never print it. */
export function webhookToken() {
  const token = process.env.WEBHOOK_TOKEN;
  if (!token) throw new Error('WEBHOOK_TOKEN is not set - the webhook specs need it');
  return token;
}
