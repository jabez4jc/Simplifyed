/**
 * HTTP status codes this app actually uses, named.
 *
 * VALIDATION is 422, not 400 - see ValidationError in src/core/errors.js. Worth a constant
 * because "400" is the reflex guess, and a suite that asserts the reflex instead of the contract
 * fails everywhere for no reason.
 *
 * UPSTREAM is 502: a broker's own 4xx is deliberately NOT passed through (see
 * Test/unit/auth-guards.test.js - a broker's 401 reaching the browser logs the operator out).
 */
export const STATUS = {
  OK: 200,
  CREATED: 201,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION: 422,
  RATE_LIMITED: 429,
  UPSTREAM: 502,
};

/** True for any client-error status - the assertion for "this must not be a 500". */
export const isClientError = (status) => status >= 400 && status < 500;
