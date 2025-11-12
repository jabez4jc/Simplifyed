/**
 * Global Error Handler Middleware
 * Handles all errors and sends consistent error responses
 */

import { log } from '../core/logger.js';
import {
  AppError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  ValidationError,
  RateLimitError,
  DatabaseError,
  ExternalAPIError,
  OpenAlgoError,
} from '../core/errors.js';

/**
 * Error handler middleware
 * @param {Error} err - Error object
 * @param {Request} req - Express request
 * @param {Response} res - Express response
 * @param {Function} next - Next middleware
 */
export function errorHandler(err, req, res, next) {
  // Log error
  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      log.error('Server error', err, {
        path: req.path,
        method: req.method,
        statusCode: err.statusCode,
      });
    } else {
      log.warn('Client error', {
        message: err.message,
        path: req.path,
        method: req.method,
        statusCode: err.statusCode,
      });
    }
  } else {
    log.error('Unexpected error', err, {
      path: req.path,
      method: req.method,
    });
  }

  // Handle known error types
  if (err instanceof ValidationError) {
    return res.status(err.statusCode).json({
      status: 'error',
      message: err.message,
      errors: err.errors || [],
      code: 'VALIDATION_ERROR',
    });
  }

  if (err instanceof NotFoundError) {
    return res.status(err.statusCode).json({
      status: 'error',
      message: err.message,
      code: 'NOT_FOUND',
    });
  }

  if (err instanceof ConflictError) {
    return res.status(err.statusCode).json({
      status: 'error',
      message: err.message,
      code: 'CONFLICT',
    });
  }

  if (err instanceof UnauthorizedError) {
    return res.status(err.statusCode).json({
      status: 'error',
      message: err.message,
      code: 'UNAUTHORIZED',
    });
  }

  if (err instanceof ForbiddenError) {
    return res.status(err.statusCode).json({
      status: 'error',
      message: err.message,
      code: 'FORBIDDEN',
    });
  }

  if (err instanceof RateLimitError) {
    return res.status(err.statusCode).json({
      status: 'error',
      message: err.message,
      code: 'RATE_LIMIT_EXCEEDED',
    });
  }

  if (err instanceof OpenAlgoError) {
    return res.status(err.statusCode).json({
      status: 'error',
      message: err.message,
      code: 'OPENALGO_ERROR',
      details: err.details,
    });
  }

  if (err instanceof ExternalAPIError) {
    return res.status(err.statusCode).json({
      status: 'error',
      message: err.message,
      code: 'EXTERNAL_API_ERROR',
    });
  }

  if (err instanceof DatabaseError) {
    return res.status(500).json({
      status: 'error',
      message: 'Database error occurred',
      code: 'DATABASE_ERROR',
    });
  }

  if (err instanceof BadRequestError) {
    return res.status(err.statusCode).json({
      status: 'error',
      message: err.message,
      code: 'BAD_REQUEST',
    });
  }

  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      status: 'error',
      message: err.message,
      code: err.code || 'APP_ERROR',
    });
  }

  // Handle unknown errors
  return res.status(500).json({
    status: 'error',
    message: 'An unexpected error occurred',
    code: 'INTERNAL_SERVER_ERROR',
  });
}

/**
 * 404 Not Found handler
 * @param {Request} req - Express request
 * @param {Response} res - Express response
 */
export function notFoundHandler(req, res) {
  res.status(404).json({
    status: 'error',
    message: `Route ${req.method} ${req.path} not found`,
    code: 'ROUTE_NOT_FOUND',
  });
}

export default {
  errorHandler,
  notFoundHandler,
};
