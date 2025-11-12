/**
 * Request Logger Middleware
 * Logs HTTP requests with timing information
 */

import { log } from '../core/logger.js';

/**
 * Request logger middleware
 * @param {Request} req - Express request
 * @param {Response} res - Express response
 * @param {Function} next - Next middleware
 */
export function requestLogger(req, res, next) {
  const startTime = Date.now();

  // Capture response finish event
  res.on('finish', () => {
    const duration = Date.now() - startTime;

    log.http(req, res, duration);
  });

  next();
}

/**
 * Body parser error handler
 * Handles JSON parsing errors
 */
export function bodyParserErrorHandler(err, req, res, next) {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({
      status: 'error',
      message: 'Invalid JSON in request body',
      code: 'INVALID_JSON',
    });
  }

  next(err);
}

export default {
  requestLogger,
  bodyParserErrorHandler,
};
