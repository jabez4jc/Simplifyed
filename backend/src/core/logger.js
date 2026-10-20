/**
 * Logging Service
 * Structured logging using Winston
 */

import winston from 'winston';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync, writeFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Ensure logs directory exists
const logsDir = join(__dirname, '../../logs');
if (!existsSync(logsDir)) {
  mkdirSync(logsDir, { recursive: true });
}

const enableDebug = process.env.ENABLE_DEBUG_LOGS === 'true';

// Test processes (node --test sets NODE_TEST_CONTEXT) log to test-*.log, so their deliberate
// failures never mix with the running app's error.log.
export const LOG_PREFIX = process.env.NODE_TEST_CONTEXT ? 'test-' : '';

// Keys that never print their value. Matched as substrings so apiKey, webhook_token and the like
// are caught too (rule: secrets are never logged).
const SECRET_KEY = /token|api_?key|password|secret|authorization/i;
// Written by the formatter itself - a meta key of the same name must not duplicate or shadow them.
const RESERVED_KEYS = new Set(['ts', 'lvl', 'svc', 'pid', 'msg', 'service']);

/**
 * One key=value log line: every primitive meta key is printed (sanitizeMeta has already dropped
 * objects), in sorted order after the fixed prefix, with the message last for grep-friendliness.
 */
// A broker's multi-line error (SQLAlchemy appends a "Background on this error" line) would
// otherwise split one record across several lines.
const oneLine = (v) => String(v).replace(/\s*\n\s*/g, ' | ');

// Instance names by id, kept current by instance.service on every read. Lets the formatter print
// `instance="Jabez Crypto (26)"` where a call site logged only `instanceId=26` - people reading
// the log know their instances by name, not by row id.
const instanceNames = new Map();
export function rememberInstanceNames(rows = []) {
  for (const row of rows) if (row?.id && row.name) instanceNames.set(Number(row.id), row.name);
}

const INSTANCE_ID_KEYS = ['instanceId', 'instance_id', 'targetInstanceId'];
const INSTANCE_NAME_KEYS = ['instanceName', 'instance_name'];

/** Fold the id/name keys a call site used for an instance into one readable `instance` field. */
function withInstanceName(meta) {
  if (meta.instance !== undefined) return meta; // the call site already chose what to print
  const idKey = INSTANCE_ID_KEYS.find((k) => meta[k] !== undefined && meta[k] !== null);
  const nameKey = INSTANCE_NAME_KEYS.find((k) => meta[k]);
  if (!idKey && !nameKey) return meta;
  const id = idKey ? meta[idKey] : undefined;
  const name = nameKey ? meta[nameKey] : instanceNames.get(Number(id));
  const out = { ...meta };
  for (const k of [...INSTANCE_ID_KEYS, ...INSTANCE_NAME_KEYS]) delete out[k];
  out.instance = `"${name ?? 'unknown'}${id !== undefined ? ` (${id})` : ''}"`;
  return out;
}

export function formatKv({ timestamp, level, message, service }, meta = {}) {
  meta = withInstanceName(meta);
  const fields = [`ts=${timestamp}`, `lvl=${level.toUpperCase()}`];
  if (meta.service || service) fields.push(`svc=${meta.service || service}`);
  // Several processes write one log (the app, a test run, a script): without this nobody can say
  // whose rate-limit and pause lines they are.
  fields.push(`pid=${process.pid}`);
  for (const k of Object.keys(meta).sort()) {
    const v = meta[k];
    if (v === undefined || v === null || RESERVED_KEYS.has(k)) continue;
    fields.push(`${k}=${SECRET_KEY.test(k) ? '[REDACTED]' : oneLine(v)}`);
  }
  if (message) fields.push(`msg="${oneLine(message)}"`);
  return fields.join(' ');
}

const kvFormatter = winston.format.printf(({ timestamp, level, message, ...rest }) =>
  formatKv({ timestamp, level, message, service: rest.service }, rest[Symbol.for('splat')]?.[0] || {}));

const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
  kvFormatter
);

const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  kvFormatter
);

/**
 * Create logger instance
 */
const logger = winston.createLogger({
  level: enableDebug ? 'debug' : process.env.LOG_LEVEL || 'info',
  defaultMeta: { service: 'simplifyed-admin' },
  transports: [
    // Console transport
    new winston.transports.Console({
      format: consoleFormat,
    }),

    // File transport for errors
    new winston.transports.File({
      filename: join(logsDir, `${LOG_PREFIX}error.log`),
      level: 'error',
      format: fileFormat,
    }),

    // File transport for all logs
    new winston.transports.File({
      filename: join(logsDir, `${LOG_PREFIX}combined.log`),
      format: fileFormat,
    }),
  ],
});

// Daily truncate at 07:00 (timer is unref'd so it doesn't hold the event loop)
function scheduleDailyTruncate() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(7, 0, 0, 0);
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }
  const delay = next.getTime() - now.getTime();
  const timer = setTimeout(() => {
    try {
      writeFileSync(join(logsDir, `${LOG_PREFIX}combined.log`), '');
      writeFileSync(join(logsDir, `${LOG_PREFIX}error.log`), '');
    } catch {
      // ignore cleanup errors
    }
    scheduleDailyTruncate();
  }, delay);
  if (timer.unref) timer.unref();
}
scheduleDailyTruncate();

export const sanitizeMeta = (meta = {}) => {
  // Keep only primitive values; drop objects/arrays to prevent noisy logs. An Error is kept as
  // its message, so `{ err }` prints instead of vanishing.
  return Object.fromEntries(
    Object.entries(meta)
      .map(([k, v]) => [k, v instanceof Error ? v.message : v])
      .filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v))
  );
};

// The TradingView webhook takes its trading token as ?token= or ?t= (TradingView cannot send a
// header), so a request URL is never logged with those values in it.
export const redactUrl = (url = '') => url.replace(/([?&](?:token|t)=)[^&#]*/gi, '$1[redacted]');

/**
 * Helper methods for structured logging
 */
export const log = {
  /**
   * Log info message
   */
  info: (message, meta = {}) => {
    const clean = sanitizeMeta(meta);
    logger.info(message, clean);
  },

  /**
   * Log error message
   */
  error: (message, error = null, meta = {}) => {
    const payload = sanitizeMeta(meta);
    if (error instanceof Error) {
      payload.error_message = error.message;
    } else if (error) {
      payload.error_message = String(error);
    }
    logger.error(message, payload);
  },

  /**
   * Log warning message
   */
  warn: (message, meta = {}) => {
    const payload = sanitizeMeta(meta);
    logger.warn(message, payload);
  },

  /**
   * Log debug message
   */
  debug: (message, meta = {}) => {
    if (enableDebug) {
      const payload = sanitizeMeta(meta);
      logger.debug(message, payload);
    }
  },

  /**
   * Log HTTP request
   */
  http: (req, res, duration) => {
    const meta = sanitizeMeta({
      method: req.method,
      path: redactUrl(req.url),
      status: res.statusCode,
      duration_ms: duration,
      trace_id: req.correlationId || req.headers['x-request-id'],
    });
    // Routine successful requests (2xx/3xx - the overwhelming majority of traffic on a
    // frequently-polling dashboard) are debug-level noise, not troubleshooting signal - only
    // client/server errors are logged at a visible level by default.
    if (res.statusCode >= 500) {
      logger.error('http_request', meta);
    } else if (res.statusCode >= 400) {
      logger.warn('http_request', meta);
    } else {
      logger.debug('http_request', meta);
    }
  },

  /**
   * Log database query
   */
  query: (sql, params, duration) => {
    if (enableDebug) {
      logger.debug('db_query', sanitizeMeta({ duration_ms: duration, sql: sql?.slice(0, 200), param_count: Array.isArray(params) ? params.length : 0 }));
    }
  },
};

