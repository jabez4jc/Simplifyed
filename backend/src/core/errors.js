/**
 * Custom Error Classes
 * Provides structured error handling throughout the application
 */

/**
 * Base application error
 */
export class AppError extends Error {
  constructor(message, statusCode = 500, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.name = this.constructor.name;

    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      status: 'error',
      message: this.message,
      statusCode: this.statusCode,
      ...(process.env.NODE_ENV === 'development' && { stack: this.stack }),
    };
  }
}

/**
 * Bad Request Error (400)
 */
export class BadRequestError extends AppError {
  constructor(message = 'Bad Request') {
    super(message, 400);
  }
}

/**
 * Unauthorized Error (401)
 */
export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401);
  }
}

/**
 * Forbidden Error (403)
 */
export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 403);
  }
}

/**
 * Not Found Error (404)
 */
export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, 404);
  }
}

/**
 * Conflict Error (409)
 */
export class ConflictError extends AppError {
  constructor(message = 'Resource already exists') {
    super(message, 409);
  }
}

/**
 * Validation Error (422)
 */
export class ValidationError extends AppError {
  constructor(message = 'Validation failed', errors = []) {
    super(message, 422);
    this.errors = errors;
  }

  toJSON() {
    return {
      status: 'error',
      message: this.message,
      statusCode: this.statusCode,
      errors: this.errors,
    };
  }
}

/**
 * Internal Server Error (500)
 */
export class InternalError extends AppError {
  constructor(message = 'Internal Server Error') {
    super(message, 500);
  }
}

/**
 * Database Error
 */
export class DatabaseError extends AppError {
  constructor(message = 'Database operation failed', originalError = null) {
    super(message, 500);
    this.originalError = originalError;
  }
}

/**
 * External API Error (for OpenAlgo)
 */
export class ExternalAPIError extends AppError {
  constructor(service, message = 'External API call failed', statusCode = 502) {
    super(`${service}: ${message}`, statusCode);
    this.service = service;
  }
}

/**
 * OpenAlgo specific error
 */
export class OpenAlgoError extends ExternalAPIError {
  constructor(message, endpoint = null, statusCode = 502) {
    super('OpenAlgo', message, statusCode);
    this.endpoint = endpoint;
  }

  toJSON() {
    return {
      status: 'error',
      message: this.message,
      service: 'OpenAlgo',
      endpoint: this.endpoint,
      statusCode: this.statusCode,
    };
  }
}

/**
 * Rate Limit Error (429)
 */
export class RateLimitError extends AppError {
  constructor(message = 'Too many requests', retryAfter = null) {
    super(message, 429);
    this.retryAfter = retryAfter;
  }

  toJSON() {
    return {
      status: 'error',
      message: this.message,
      statusCode: this.statusCode,
      retryAfter: this.retryAfter,
    };
  }
}
