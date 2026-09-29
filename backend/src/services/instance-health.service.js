import cron from 'node-cron';
import { log } from '../core/logger.js';
import settingsService from './settings.service.js';
import instanceService from './instance.service.js';
import openalgoClient from '../integrations/openalgo/client.js';
import db from '../core/database.js';
import { toISTISOString } from '../utils/time.js';
import marketCalendarService from './market-calendar.service.js';
import { isCryptoBroker, isCryptoExchange } from '../utils/broker-type.util.js';
import { ValidationError } from '../core/errors.js';

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
    { symbol: 'INFY', exchange: 'BSE' },
  ],
  // Expiries change continuously, so a fabricated default would report every healthy broker as
  // degraded once the contract expires. Admins can add current contracts from Settings.
  optionchain: [],
};

async function getTestConfig() {
  try {
    const setting = await settingsService.getSetting('instance_health_tests');
    const raw = setting?.value ?? setting?.rawValue;
    if (typeof raw === 'string' && raw) return JSON.parse(raw);
    if (raw && typeof raw === 'object') return raw;
  } catch (err) {
    if (!(err instanceof ValidationError)) {
      log.warn('Using default instance health tests', { error: err.message });
    }
  }
  return DEFAULT_TESTS;
}

async function persistTestConfig(cfg) {
  await db.run(
    `INSERT INTO application_settings (key, value, description, category, data_type)
     VALUES ('instance_health_tests', ?, 'Symbols used for endpoint capability tests', 'instance_health_tests', 'json')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    [JSON.stringify(cfg)]
  );
}

function validateTestConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new ValidationError('Health test config must be an object');
  }

  const validateList = (name, key) => {
    const rows = cfg[name];
    if (!Array.isArray(rows) || rows.length > 20) {
      throw new ValidationError(`${name} must be an array with at most 20 entries`);
    }
    for (const row of rows) {
      const symbol = row?.[key];
      if (typeof symbol !== 'string' || !symbol.trim() || typeof row.exchange !== 'string' || !row.exchange.trim()) {
        throw new ValidationError(`${name} entries require ${key} and exchange`);
      }
    }
  };

  validateList('quotes', 'symbol');
  validateList('multiquotes', 'symbol');
  validateList('optionchain', 'underlying');
  for (const row of cfg.optionchain) {
    if (typeof row.expiry_date !== 'string' || !/^\d{2}[A-Z]{3}\d{2}$/.test(row.expiry_date.toUpperCase())) {
      throw new ValidationError('optionchain expiry_date must use DDMMMYY format');
    }
    if (row.strike_count !== undefined && (!Number.isInteger(row.strike_count) || row.strike_count < 1 || row.strike_count > 50)) {
      throw new ValidationError('optionchain strike_count must be an integer from 1 to 50');
    }
  }

  return {
    quotes: cfg.quotes,
    multiquotes: cfg.multiquotes,
    optionchain: cfg.optionchain.map((row) => ({ ...row, expiry_date: row.expiry_date.toUpperCase() })),
  };
}

async function updateInstanceEndpoint(instance, endpoint, ok, reason = null) {
  const now = toISTISOString();
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
    const cfg = await getTestConfig();
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
      const quoteTests = forInstance(inst, await filterByOpenExchange(cfg.quotes || DEFAULT_TESTS.quotes));
      if (quoteTests.length > 0) {
        const quoted = await testQuotes(inst, quoteTests);
        await updateInstanceEndpoint(inst, 'quotes', quoted.ok, quoted.reason);
      }

      const multiTests = forInstance(inst, await filterByOpenExchange(cfg.multiquotes || DEFAULT_TESTS.multiquotes));
      if (multiTests.length > 0) {
        const mquoted = await testMultiQuotes(inst, multiTests);
        await updateInstanceEndpoint(inst, 'multiquotes', mquoted.ok, mquoted.reason);
      }

      const optionTests = forInstance(inst, await filterByOpenExchange(cfg.optionchain || DEFAULT_TESTS.optionchain));
      if (optionTests.length > 0) {
        const ocResults = [];
        for (const t of optionTests) {
          const r = await testOptionChain(inst, t);
          ocResults.push(r);
        }
        const ocOk = ocResults.some((r) => r.ok);
        const ocReason = ocOk ? null : ocResults.map((r) => r.reason).join('; ');
        await updateInstanceEndpoint(inst, 'optionchain', ocOk, ocReason);
      }
    }

    log.info('Instance health checks completed');
  }

  async updateTestConfig(cfg) {
    const validated = validateTestConfig(cfg);
    await persistTestConfig(validated);
  }

  async getTestConfig() {
    return getTestConfig();
  }
}

export default new InstanceHealthService();
