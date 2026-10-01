/**
 * The operator's REAL brokers, for the integration tests. There is no fake broker anywhere in
 * this suite: every broker call a route makes goes to a real OpenAlgo instance.
 *
 * - `realInstance(name)` copies one of the operator's instances (URL + key) from
 *   database/simplifyed.db into this file's test database. Only Jz Kotak, Jz Fyers and Jabez
 *   Crypto are used here - Maha and Ana are reserved for Test/live.
 * - `watchBroker()` records every call the app makes (so a test can assert "the broker was never
 *   asked" or "this is what it was sent") and passes each one through to the real broker behind
 *   a safety interlock: no test may switch an instance to live, and nothing that places, changes
 *   or cancels an order leaves the process until the broker itself confirms analyzer mode.
 * - `UNREACHABLE` is a real address nothing listens on, for "the broker is down" cases.
 * - `broker.flattenAll()` closes whatever a test opened, and reports anything it could not close.
 *
 * database/simplifyed.db is only ever read.
 */

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import db from '../../src/core/database.js';
import openalgoClient from '../../src/integrations/openalgo/client.js';
import { closeEverythingOpened } from '../live/cleanup.js';

const REAL_DB = join(dirname(fileURLToPath(import.meta.url)), '../../database/simplifyed.db');

export const KOTAK = 'Jz Kotak';
export const FYERS = 'Jz Fyers';
export const CRYPTO = 'Jabez Crypto';

/** The discard port: a real connection that is refused at once. */
export const UNREACHABLE = 'http://127.0.0.1:9';

const ORDER_ENDPOINT = /^(place|modify|cancel|split|basket|options)[a-z]*order$|^cancelallorder$|^closeposition$/;

async function readReal(sql, params = []) {
  await db.run('ATTACH DATABASE ? AS real', [REAL_DB]);
  try {
    return await db.all(sql, params);
  } finally {
    await db.run('DETACH DATABASE real');
  }
}

/** Credentials for a real instance, without copying it in - e.g. to add it through the API. */
export async function realCredentials(name) {
  const [row] = await readReal('SELECT name, host_url, api_key, broker FROM real.instances WHERE name = ?', [name]);
  if (!row) throw new Error(`${name} is not in database/simplifyed.db`);
  return row;
}

/** Copy a real instance into this test database (once) and return its row here. */
export async function realInstance(name, overrides = {}) {
  let row = await db.get('SELECT * FROM instances WHERE name = ?', [name]);
  if (!row) {
    const cols = (await db.all('PRAGMA table_info(instances)')).map((c) => c.name).filter((c) => c !== 'id');
    const [real] = await readReal('SELECT * FROM real.instances WHERE name = ?', [name]);
    if (!real) throw new Error(`${name} is not in database/simplifyed.db`);
    const shared = cols.filter((c) => c in real);
    await db.run(
      `INSERT INTO instances (${shared.join(', ')}) VALUES (${shared.map(() => '?').join(', ')})`,
      shared.map((c) => real[c])
    );
    await db.run("UPDATE instances SET is_active = 1, health_status = 'healthy' WHERE name = ?", [name]);
    row = await db.get('SELECT * FROM instances WHERE name = ?', [name]);
    // truncate() restarts ids, so this row may inherit the circuit breaker an unreachable fixture
    // tripped under the same id earlier in the file.
    openalgoClient.forceResetInstanceHealth(row.id);
  }
  const keys = Object.keys(overrides);
  if (keys.length) {
    await db.run(`UPDATE instances SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => overrides[k]), row.id]);
    row = await db.get('SELECT * FROM instances WHERE id = ?', [row.id]);
  }
  return row;
}

/**
 * Copy real instruments (e.g. "exchange = 'CRYPTO' AND name = 'BTC'") into this test database,
 * so symbols resolve exactly as they do in production. Returns how many were copied.
 */
export async function copyRealInstruments(where, params = []) {
  const cols = (await db.all('PRAGMA table_info(instruments)')).map((c) => c.name).filter((c) => c !== 'id');
  await db.run('ATTACH DATABASE ? AS real', [REAL_DB]);
  try {
    const { changes } = await db.run(
      `INSERT INTO instruments (${cols.join(', ')}) SELECT ${cols.join(', ')} FROM real.instruments WHERE ${where}`,
      params
    );
    return changes;
  } finally {
    await db.run('DETACH DATABASE real');
  }
}

async function analyzerOn(instance, request) {
  const res = await request(instance, 'analyzer', {}, 'POST');
  const d = res?.data || res;
  return d?.analyze_mode === true || d?.mode === 'analyze' || d?.mode === 'analyzer';
}


/**
 * Record every broker call and pass it through to the real broker, behind the interlock.
 * Covers both paths out of the app: openalgoClient.request and the global fetch the TradingView
 * broadcast uses. Call restore() in after().
 */
export function watchBroker() {
  const originalRequest = openalgoClient.request;
  const originalFetch = globalThis.fetch;
  const calls = [];
  const fetches = [];
  const confirmed = new Set();
  const send = (...args) => originalRequest.apply(openalgoClient, args);

  async function guard(instance, endpoint, data) {
    if (endpoint === 'analyzer/toggle' && data?.mode !== true) {
      throw new Error('test interlock: tests never switch an instance to live');
    }
    // Switching analyzer ON is allowed only as a no-op: a test never changes a real account's mode.
    if ((endpoint === 'analyzer/toggle' || ORDER_ENDPOINT.test(endpoint)) && !confirmed.has(`${instance.host_url}|${instance.api_key}`)) {
      // A key the broker refuses cannot trade either - hand back the broker's own refusal, which
      // is exactly what the order would have got.
      let on;
      try {
        on = await analyzerOn(instance, send);
      } catch (error) {
        if ([401, 403].includes(error.statusCode)) throw error;
        throw new Error(`test interlock: could not confirm analyzer mode for ${instance.name || instance.host_url} - ${error.message}`);
      }
      if (!on) {
        throw new Error(`test interlock: ${instance.name || instance.host_url} is not in analyzer mode - refusing ${endpoint}`);
      }
      confirmed.add(`${instance.host_url}|${instance.api_key}`);
    }
  }

  openalgoClient.request = async (instance, endpoint, data = {}, method = 'POST', options = {}) => {
    const call = { instance, endpoint, data, method, options, accepted: false };
    calls.push(call);
    await guard(instance, endpoint, data);
    const result = await send(instance, endpoint, data, method, options);
    call.accepted = true; // a rejected order opened nothing, so only these need closing
    return result;
  };

  globalThis.fetch = async (url, options = {}) => {
    const text = String(url);
    const endpoint = (text.match(/\/api\/v1\/([a-z/]+)/) || [])[1] || '';
    const entry = { url: text, endpoint, method: options.method || 'GET', body: parse(options.body), ok: false };
    fetches.push(entry);
    if (ORDER_ENDPOINT.test(endpoint)) {
      const instance = await db.get('SELECT * FROM instances WHERE ? LIKE host_url || \'%\'', [text]);
      if (!instance) throw new Error(`test interlock: ${endpoint} to an unknown host`);
      await guard(instance, endpoint, {});
    }
    const res = await originalFetch(url, options);
    entry.ok = res.ok;
    return res;
  };

  return {
    calls,
    fetches,
    callsTo: (endpoint) => calls.filter((c) => c.endpoint === endpoint),
    countOf(endpoint) { return this.callsTo(endpoint).length; },
    /** Orders sent over either path, as { instance, endpoint, data }. */
    orders() {
      return [
        ...calls.filter((c) => ORDER_ENDPOINT.test(c.endpoint)),
        ...fetches.filter((f) => ORDER_ENDPOINT.test(f.endpoint)).map((f) => ({ endpoint: f.endpoint, data: f.body })),
      ];
    },
    /**
     * Close everything this process ordered since the last reset, and return what is still
     * open. Call it before truncate() - closing reads the instance rows.
     */
    async flattenAll() {
      const entries = [];
      for (const c of calls.filter((x) => x.accepted && /^(place|split|basket|options)[a-z]*order$/.test(x.endpoint))) {
        const rows = c.endpoint === 'basketorder' ? (c.data?.orders || []) : [c.data];
        for (const r of rows) if (r?.symbol) entries.push({ instance: c.instance, symbol: r.symbol, exchange: r.exchange });
      }
      for (const f of fetches.filter((x) => x.ok && /^place[a-z]*order$/.test(x.endpoint) && x.body?.symbol)) {
        const instance = await db.get("SELECT * FROM instances WHERE ? LIKE host_url || '%'", [f.url]);
        if (instance) entries.push({ instance, symbol: f.body.symbol, exchange: f.body.exchange });
      }
      const live = [];
      for (const e of entries) {
        if (await db.get('SELECT id FROM instances WHERE id = ?', [e.instance.id])) live.push(e);
      }
      return flatten(live);
    },
    reset() { calls.length = 0; fetches.length = 0; return this; },
    restore() {
      openalgoClient.request = originalRequest;
      globalThis.fetch = originalFetch;
    },
  };
}

function parse(body) {
  try { return typeof body === 'string' ? JSON.parse(body) : body; } catch { return body; }
}

/**
 * Close everything the listed orders opened. `entries` is [{ instance, symbol, exchange }].
 * Returns what is still open - assert it is empty.
 */
async function flatten(entries) {
  const byInstance = new Map();
  const instances = [];
  for (const { instance, symbol, exchange } of entries) {
    if (!byInstance.has(instance.id)) {
      byInstance.set(instance.id, new Map());
      instances.push(instance);
    }
    byInstance.get(instance.id).set(symbol, exchange);
  }
  if (!instances.length) return [];
  return closeEverythingOpened(instances, byInstance, () => {}, { includePast: false });
}

/** Net position the broker reports for a symbol, across products. */
export async function netPosition(instance, symbol) {
  const book = await openalgoClient.getPositionBook(instance);
  return (Array.isArray(book) ? book : [])
    .filter((p) => (p.symbol || p.tradingsymbol) === symbol)
    .reduce((sum, p) => sum + Number(p.quantity ?? p.netqty ?? 0), 0);
}

/** Poll until the broker reports `want` - analyzer fills land within a few seconds. */
export async function waitForNet(instance, symbol, want, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  let net;
  do {
    net = await netPosition(instance, symbol);
    if (net === want) return net;
    await new Promise((r) => setTimeout(r, 1500));
  } while (Date.now() < until);
  return net;
}

/** IST clock checks, for steps a closed exchange cannot run. */
function ist() {
  const now = new Date(Date.now() + 5.5 * 3600 * 1000);
  return { day: now.getUTCDay(), minutes: now.getUTCHours() * 60 + now.getUTCMinutes() };
}
const weekday = () => ist().day >= 1 && ist().day <= 5;
export const nseOpen = () => weekday() && ist().minutes >= 9 * 60 + 20 && ist().minutes <= 15 * 60 + 10;
export const mcxOpen = () => weekday() && ist().minutes >= 9 * 60 + 5 && ist().minutes <= 23 * 60 + 20;
