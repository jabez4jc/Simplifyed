/**
 * Logging Service
 * Structured logging using Winston
 */

import winston from 'winston';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Ensure logs directory exists
const logsDir = join(__dirname, '../../logs');
if (!existsSync(logsDir)) {
  mkdirSync(logsDir, { recursive: true });
}

/**
 * Custom format for console output
 */
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let log = `${timestamp} [${level}] ${message}`;

    // Add metadata if present
    if (Object.keys(meta).length > 0) {
      log += ` ${JSON.stringify(meta)}`;
    }

    return log;
  })
);

/**
 * Custom format for file output
 */
const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

/**
 * Create logger instance
 */
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
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

/**
 * Helper methods for structured logging
 */
export const log = {
  /**
   * Log info message
   */
  info: (message, meta = {}) => {
    logger.info(message, meta);
  },

  /**
   * Log error message
   */
  error: (message, error = null, meta = {}) => {
    if (error instanceof Error) {
      logger.error(message, {
        ...meta,
        error: {
          message: error.message,
          stack: error.stack,
          name: error.name,
        },
      });
    } else {
      logger.error(message, { ...meta, error });
    }
  },

  /**
   * Log warning message
   */
  warn: (message, meta = {}) => {
    logger.warn(message, meta);
  },

  /**
   * Log debug message
   */
  debug: (message, meta = {}) => {
    logger.debug(message, meta);
  },

  /**
   * Log HTTP request
   */
  http: (req, res, duration) => {
    logger.info('HTTP Request', {
      method: req.method,
      url: req.url,
      status: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
  },

  /**
   * Log database query
   */
  query: (sql, params, duration) => {
    logger.debug('Database Query', {
      sql,
      params,
      duration: `${duration}ms`,
    });
  },

  /**
   * Log OpenAlgo API call
   */
  openalgo: (method, endpoint, duration, success) => {
    const level = success ? 'info' : 'error';
    logger[level]('OpenAlgo API Call', {
      method,
      endpoint,
      duration: `${duration}ms`,
      success,
    });
  },
};

export default logger;
