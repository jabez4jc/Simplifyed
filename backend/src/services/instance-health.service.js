import cron from 'node-cron';
import { log } from '../core/logger.js';
import settingsService from './settings.service.js';
import config from '../core/config.js';
import instanceService from './instance.service.js';
import openalgoClient from '../integrations/openalgo/client.js';
import db from '../core/database.js';
import { toISTDate, toISTISOString } from '../utils/time.js';

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
  return toISTDate();
}

function _isWithinWindow(istDate, startHour, startMinute, endHour, endMinute) {
  const minutes = istDate.getHours() * 60 + istDate.getMinutes();
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;
  return minutes >= start && minutes < end;
}

function _parseTimeWindow(value, fallback) {
  if (!value || typeof value !== 'string') return fallback;
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return fallback;
  const hour = Math.min(23, Math.max(0, parseInt(match[1], 10)));
  const minute = Math.min(59, Math.max(0, parseInt(match[2], 10)));
  return { hour, minute };
}

function isQuoteEndpointBlackout() {
  const ist = getIstDate();
  const start = _parseTimeWindow(config.marketHours?.quoteBlackoutStart, { hour: 2, minute: 0 });
  const end = _parseTimeWindow(config.marketHours?.quoteBlackoutEnd, { hour: 8, minute: 45 });
  return _isWithinWindow(ist, start.hour, start.minute, end.hour, end.minute);
}

function isGeneralEndpointBlackout() {
  const ist = getIstDate();
  const start = _parseTimeWindow(config.marketHours?.generalBlackoutStart, { hour: 3, minute: 0 });
  const end = _parseTimeWindow(config.marketHours?.generalBlackoutEnd, { hour: 8, minute: 0 });
  return _isWithinWindow(ist, start.hour, start.minute, end.hour, end.minute);
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
    const res = await openalgoClient.getQuotes(instance, tests, { returnErrors: true });
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
    // Every 3 hours (skips blackout window inside runHealthChecks)
    this.cron = cron.schedule('0 0 */3 * * *', () => this.runHealthChecks(), {
      timezone: 'Asia/Kolkata',
    });
    log.info('Instance health check cron scheduled (every 3 hours)');
  }

  stop() {
    if (this.cron) this.cron.stop();
  }

  async runHealthChecks() {
    if (isQuoteEndpointBlackout()) {
      log.warn('Health checks skipped during quote blackout (02:00-08:45 IST)');
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
export { isQuoteEndpointBlackout, isGeneralEndpointBlackout };
