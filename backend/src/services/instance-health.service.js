import cron from 'node-cron';
import { log } from '../core/logger.js';
import instanceService from './instance.service.js';
import openalgoClient from '../integrations/openalgo/client.js';
import db from '../core/database.js';
import { toISTISOString } from '../utils/time.js';
import marketCalendarService from './market-calendar.service.js';
import { isCryptoBroker, isCryptoExchange } from '../utils/broker-type.util.js';

async function createNotification(title, body, severity = 'warn') {
  try {
    await db.run(
      `INSERT INTO notifications (title, body, severity) VALUES (?, ?, ?)`,
      [title, body, severity]
    );
  } catch (err) {
    log.warn('Failed to create notification', { error: err.message, title });
  }
}

// Option-chain capability is not probed: expiries change continuously, so a fixed contract would
// report every healthy broker as degraded once it expires.
const TESTS = {
  quotes: [
    { symbol: 'SBIN', exchange: 'NSE' },
    { symbol: 'NIFTY', exchange: 'NSE_INDEX' },
  ],
  multiquotes: [
    { symbol: 'SBIN', exchange: 'NSE' },
    { symbol: 'INFY', exchange: 'BSE' },
  ],
};

async function updateInstanceEndpoint(instance, endpoint, ok, reason = null) {
  const now = toISTISOString();
  const fields = {
    quotes: ['quotes_ok', 'quotes_checked_at', 'quotes_failure_reason'],
    multiquotes: ['multiquotes_ok', 'multiquotes_checked_at', 'multiquotes_failure_reason'],
  }[endpoint];
  if (!fields) return;
  const [okField, atField, reasonField] = fields;
  const prevOk = instance[okField];
  await db.run(
    `UPDATE instances SET ${okField} = ?, ${atField} = ?, ${reasonField} = ? WHERE id = ?`,
    [ok ? 1 : 0, now, ok ? null : reason, instance.id]
  );
  if (prevOk && !ok) {
    const title = `Instance degraded: ${instance.name}`;
    const body = `${endpoint} failed: ${reason || 'Unknown error'}`;
    await createNotification(title, body, 'warn');
    log.warn(`Instance lost ${endpoint} capability`, { instance: instance.name, reason });
  }
}

async function testQuotes(instance, tests) {
  try {
    // Fetch in bulk to reduce calls; re-use existing getQuotes helper
    const res = await openalgoClient.getQuotes(instance, tests, { returnErrors: true, perSymbol: true });
    const quotes = res?.quotes || [];
    for (const t of tests) {
      const q = quotes.find((q) => q.symbol === t.symbol && q.exchange === t.exchange);
      const ltp = Number(q?.ltp || q?.last_price || 0);
      const close = Number(q?.close || 0);
      if (!(ltp > 0 || close > 0)) throw new Error(`Zero quote for ${t.symbol}:${t.exchange}`);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

async function testMultiQuotes(instance, symbols) {
  try {
    const res = await openalgoClient.getMultiQuotes(instance, symbols, { returnErrors: true });
    if (!res?.quotes || !Array.isArray(res.quotes)) throw new Error('No quotes array');
    for (const t of symbols) {
      const q = res.quotes.find((q) => q.symbol === t.symbol && q.exchange === t.exchange);
      const ltp = Number(q?.ltp || q?.last_price || 0);
      const close = Number(q?.close || 0);
      if (!(ltp > 0 || close > 0)) throw new Error(`Zero multiquote for ${t.symbol}:${t.exchange}`);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

class InstanceHealthService {
  constructor() {
    this.cron = null;
  }

  start() {
    // Every 3 hours (exchanges that are closed are skipped inside runHealthChecks)
    this.cron = cron.schedule('0 0 */3 * * *', () => this.runHealthChecks(), {
      timezone: 'Asia/Kolkata',
    });
    log.info('Instance health check cron scheduled (every 3 hours)');
  }

  stop() {
    if (this.cron) this.cron.stop();
  }

  async runHealthChecks() {
    const instances = await instanceService.getAllInstances({ is_active: true });
    const exchangeOpenCache = new Map();
    const isExchangeOpen = async (exchange) => {
      const ex = (exchange || '').toUpperCase();
      if (!ex) return false;
      if (!exchangeOpenCache.has(ex)) {
        exchangeOpenCache.set(ex, await marketCalendarService.isExchangeOpen(ex));
      }
      return exchangeOpenCache.get(ex);
    };
    const filterByOpenExchange = async (tests = []) => {
      const filtered = [];
      for (const t of tests) {
        const ex = t.exchange || t.brexchange || t.exch;
        if (!ex) continue;
        if (await isExchangeOpen(ex)) filtered.push(t);
      }
      return filtered;
    };

    // Probe each instance only with symbols from the segment its broker trades - Delta Exchange
    // probed with NSE:SBIN "failed" its quotes check every cycle, and an Indian broker would fail
    // a CRYPTO probe the same way. A segment with no applicable test is simply not probed.
    const forInstance = (inst, tests) => tests.filter((t) =>
      isCryptoBroker(inst.broker) === isCryptoExchange(t.exchange || t.brexchange || t.exch));

    for (const inst of instances) {
      const quoteTests = forInstance(inst, await filterByOpenExchange(TESTS.quotes));
      if (quoteTests.length > 0) {
        const quoted = await testQuotes(inst, quoteTests);
        await updateInstanceEndpoint(inst, 'quotes', quoted.ok, quoted.reason);
      }

      const multiTests = forInstance(inst, await filterByOpenExchange(TESTS.multiquotes));
      if (multiTests.length > 0) {
        const mquoted = await testMultiQuotes(inst, multiTests);
        await updateInstanceEndpoint(inst, 'multiquotes', mquoted.ok, mquoted.reason);
      }
    }

    log.info('Instance health checks completed');
  }
}

export default new InstanceHealthService();
