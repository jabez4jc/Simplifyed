import cron from 'node-cron';
import { log } from '../core/logger.js';
import settingsService from './settings.service.js';
import instanceService from './instance.service.js';
import openalgoClient from '../integrations/openalgo/client.js';
import db from '../core/database.js';

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

const DEFAULT_TESTS = {
  quotes: [
    { symbol: 'SBIN', exchange: 'NSE' },
    { symbol: 'NIFTY', exchange: 'NSE_INDEX' },
  ],
  multiquotes: [
    { symbol: 'SBIN', exchange: 'NSE' },
    { symbol: 'NIFTY30DEC25FUT', exchange: 'NFO' },
    { symbol: 'INFY', exchange: 'BSE' },
  ],
  optionchain: [
    { underlying: 'NIFTY', exchange: 'NSE_INDEX', expiry_date: '30DEC25', strike_count: 5 },
    { underlying: 'NATURALGAS', exchange: 'MCX', expiry_date: '23DEC25', strike_count: 5 },
  ],
};

function getIstDate() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + 5.5 * 3600000);
}

function isBlackout() {
  const ist = getIstDate();
  const hour = ist.getHours();
  return hour >= 1 && hour < 8;
}

async function getTestConfig() {
  try {
    const setting = await settingsService.getSetting('instance_health_tests');
    const raw = setting?.value ?? setting?.rawValue;
    if (raw) return JSON.parse(raw);
  } catch (err) {
    log.warn('Using default instance health tests', { error: err.message });
  }
  return DEFAULT_TESTS;
}

async function persistTestConfig(cfg) {
  await settingsService.setSetting('instance_health_tests', cfg);
}

async function updateInstanceEndpoint(instance, endpoint, ok, reason = null) {
  const now = new Date().toISOString();
  const fields = {
    quotes: ['quotes_ok', 'quotes_checked_at', 'quotes_failure_reason'],
    multiquotes: ['multiquotes_ok', 'multiquotes_checked_at', 'multiquotes_failure_reason'],
    optionchain: ['optionchain_ok', 'optionchain_checked_at', 'optionchain_failure_reason'],
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
    for (const t of tests) {
      const res = await openalgoClient.getQuote(instance, t.symbol, t.exchange);
      const ltp = Number(res?.ltp || res?.last_price || 0);
      const close = Number(res?.close || 0);
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

async function testOptionChain(instance, test) {
  try {
    const res = await openalgoClient.getOptionChain(
      instance,
      test.underlying,
      test.expiry_date,
      test.exchange,
      { strikeCount: test.strike_count || 5, skipBackoff: true }
    );
    if (!res?.chain || !Array.isArray(res.chain) || !res.chain.length) throw new Error('Empty chain');
    const hasPrice = res.chain.some(
      (c) =>
        Number(c?.ce?.ltp || c?.ce?.bid || c?.ce?.ask || 0) > 0 ||
        Number(c?.pe?.ltp || c?.pe?.bid || c?.pe?.ask || 0) > 0
    );
    if (!hasPrice) throw new Error('Chain has no prices');
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
    // Every 3 hours from 08:00 IST: minute 0, second 0
    this.cron = cron.schedule('0 0 8-23/3 * * *', () => this.runHealthChecks(), {
      timezone: 'Asia/Kolkata',
    });
    log.info('Instance health check cron scheduled (every 3h from 08:00 IST)');
  }

  stop() {
    if (this.cron) this.cron.stop();
  }

  async runHealthChecks() {
    if (isBlackout()) {
      log.warn('Health checks skipped during blackout (01:00-08:00 IST)');
      return;
    }

    const cfg = await getTestConfig();
    const instances = await instanceService.getAllInstances({ is_active: true });

    for (const inst of instances) {
      const quoted = await testQuotes(inst, cfg.quotes || DEFAULT_TESTS.quotes);
      await updateInstanceEndpoint(inst, 'quotes', quoted.ok, quoted.reason);

      const mquoted = await testMultiQuotes(inst, cfg.multiquotes || DEFAULT_TESTS.multiquotes);
      await updateInstanceEndpoint(inst, 'multiquotes', mquoted.ok, mquoted.reason);

      const ocResults = [];
      for (const t of cfg.optionchain || DEFAULT_TESTS.optionchain) {
        const r = await testOptionChain(inst, t);
        ocResults.push(r);
      }
      const ocOk = ocResults.some((r) => r.ok);
      const ocReason = ocOk ? null : ocResults.map((r) => r.reason).join('; ');
      await updateInstanceEndpoint(inst, 'optionchain', ocOk, ocReason);
    }

    log.info('Instance health checks completed');
  }

  async updateTestConfig(cfg) {
    await persistTestConfig(cfg);
  }
}

export default new InstanceHealthService();
export { isBlackout };
