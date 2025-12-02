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

// Minimal console formatter: HH:mm:ss level message (meta trimmed)
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level}] ${message}`)
);

// Compact JSON for files (no stacks to keep logs short)
const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.printf(({ timestamp, level, message }) =>
    JSON.stringify({ t: timestamp, lvl: level, msg: message })
  )
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

const compactMeta = (meta = {}) => {
  // Only keep a few keys to avoid noisy logs
  const allow = ['context', 'id', 'instanceId', 'status', 'duration'];
  return Object.fromEntries(
    Object.entries(meta).filter(([key]) => allow.includes(key))
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
    logger.info(message, compactMeta(meta));
  },

  /**
   * Log error message
   */
  error: (message, error = null, meta = {}) => {
    const payload = compactMeta(meta);
    if (error instanceof Error) {
      payload.error = { message: error.message };
    } else if (error) {
      payload.error = error;
    }
    logger.error(message, payload);
  },

  /**
   * Log warning message
   */
  warn: (message, meta = {}) => {
    logger.warn(message, compactMeta(meta));
  },

  /**
   * Log debug message
   */
  debug: (message, meta = {}) => {
    if (enableDebug) {
      logger.debug(message, meta);
    }
  },

  /**
   * Log HTTP request
   */
  http: (req, res, duration) => {
    logger.info('HTTP', {
      method: req.method,
      url: req.url,
      status: res.statusCode,
      duration: `${duration}ms`,
    });
  },

  /**
   * Log database query
   */
  query: (sql, params, duration) => {
    if (enableDebug) {
      logger.debug('DB', { sql, params, duration: `${duration}ms` });
    }
  },

  /**
   * Log OpenAlgo API call
   */
  openalgo: (method, endpoint, duration, success) => {
    const level = success ? 'info' : 'error';
    logger[level]('OpenAlgo', {
      method,
      endpoint,
      duration: `${duration}ms`,
      success,
    });
  },
};

export default logger;
