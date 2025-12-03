/**
 * Logging Service
 * Structured logging using Winston
 */

import winston from 'winston';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import sqlite3 from 'sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Ensure logs directory exists
const logsDir = join(__dirname, '../../logs');
if (!existsSync(logsDir)) {
  mkdirSync(logsDir, { recursive: true });
}

const enableDebug = process.env.ENABLE_DEBUG_LOGS === 'true';
const logNotifications = process.env.LOG_NOTIFICATIONS === 'true';

// Notification writer (direct sqlite, avoid core db circular deps)
let notifDb = null;
let notifDbReady = false;
let notifDbFailed = false;
const dbPath = join(__dirname, '../../', process.env.DATABASE_PATH || './database/simplifyed.db');

function ensureNotifDb() {
  if (notifDbFailed || notifDbReady) return notifDbReady;
  try {
    notifDb = new sqlite3.Database(dbPath);
    // Make sure table exists (no migration dependency here)
    notifDb.run(
      `CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        body TEXT,
        severity TEXT DEFAULT 'info',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        read INTEGER DEFAULT 0
      )`
    );
    notifDbReady = true;
    return true;
  } catch (err) {
    notifDbFailed = true;
    // Avoid recursion into logger; emit to stderr once
    console.error('LOG_NOTIFICATIONS init failed:', err?.message || err);
    return false;
  }
}

function pushNotification(level, message, meta = {}) {
  if (!logNotifications) return;
  if (!ensureNotifDb()) return;
  try {
    const severity = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'debug';
    const context = sanitizeMeta(meta);
    const bodyParts = [];
    Object.entries(context).forEach(([k, v]) => {
      if (v !== undefined && v !== null) bodyParts.push(`${k}=${v}`);
    });
    const body = bodyParts.length ? `${message} | ${bodyParts.join(' ')}` : message;
    notifDb.run(
      `INSERT INTO notifications (title, body, severity) VALUES (?, ?, ?)` ,
      [`[${severity}]`, body.slice(0, 500), severity],
      () => {}
    );
  } catch (err) {
    // Avoid recursion into logger; emit once and disable further attempts
    notifDbFailed = true;
    console.error('LOG_NOTIFICATIONS insert failed:', err?.message || err);
  }
}

// Structured, high-signal formatter (key=value, stable field order)
const allowedMetaKeys = new Set([
  'trace_id', 'user_id', 'instance_id', 'instance_name', 'order_id', 'event', 'status',
  'duration_ms', 'endpoint', 'method', 'path', 'symbol', 'exchange',
  'error_code', 'reason', 'count', 'size', 'host', 'port', 'chat_id'
]);

const kvFormatter = winston.format.printf(({ timestamp, level, message, ...rest }) => {
  const meta = rest[Symbol.for('splat')]?.[0] || {};
  const fields = [];
  fields.push(`ts=${timestamp}`);
  fields.push(`lvl=${level.toUpperCase()}`);
  if (meta.service || rest.service) fields.push(`svc=${meta.service || rest.service}`);
  // Append meta in deterministic order, only allowed keys to avoid bloat
  const keys = Object.keys(meta).filter((k) => allowedMetaKeys.has(k));
  keys.sort();
  for (const k of keys) {
    const v = meta[k];
    if (v === undefined || v === null) continue;
    fields.push(`${k}=${v}`);
  }
  // Message last for grep-friendliness
  if (message) fields.push(`msg="${String(message)}"`);
  return fields.join(' ');
});

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
      filename: join(logsDir, 'error.log'),
      level: 'error',
      format: fileFormat,
    }),

    // File transport for all logs
    new winston.transports.File({
      filename: join(logsDir, 'combined.log'),
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
      writeFileSync(join(logsDir, 'combined.log'), '');
      writeFileSync(join(logsDir, 'error.log'), '');
    } catch {
      // ignore cleanup errors
    }
    scheduleDailyTruncate();
  }, delay);
  if (timer.unref) timer.unref();
}
scheduleDailyTruncate();

const sanitizeMeta = (meta = {}) => {
  // Keep only primitive values; drop objects/arrays to prevent noisy logs
  return Object.fromEntries(
    Object.entries(meta).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v))
  );
};

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
    // Do not push info to notifications to avoid noise
  },

  /**
   * Log error message
   */
  error: (message, error = null, meta = {}) => {
    const payload = sanitizeMeta(meta);
    if (error instanceof Error) {
      payload.error = { message: error.message };
    } else if (error) {
      payload.error = error;
    }
    logger.error(message, payload);
    pushNotification('error', message, payload);
  },

  /**
   * Log warning message
   */
  warn: (message, meta = {}) => {
    const payload = sanitizeMeta(meta);
    logger.warn(message, payload);
    pushNotification('warn', message, payload);
  },

  /**
   * Log debug message
   */
  debug: (message, meta = {}) => {
    if (enableDebug) {
      const payload = sanitizeMeta(meta);
      logger.debug(message, payload);
      pushNotification('debug', message, payload);
    }
  },

  /**
   * Log HTTP request
   */
  http: (req, res, duration) => {
    logger.info('http_request', sanitizeMeta({
      method: req.method,
      path: req.url,
      status: res.statusCode,
      duration_ms: duration,
      trace_id: req.headers['x-request-id'],
    }));
  },

  /**
   * Log database query
   */
  query: (sql, params, duration) => {
    if (enableDebug) {
      logger.debug('db_query', sanitizeMeta({ duration_ms: duration, sql: sql?.slice(0, 200), param_count: Array.isArray(params) ? params.length : 0 }));
    }
  },

  /**
   * Log OpenAlgo API call
   */
  openalgo: (method, endpoint, duration, success) => {
    const level = success ? 'info' : 'error';
    logger[level]('openalgo_call', sanitizeMeta({ method, endpoint, duration_ms: duration, status: success ? 'success' : 'failure' }));
  },
};

export default logger;
