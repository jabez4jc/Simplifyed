/**
 * Builds an Express app matching server.js's request pipeline, minus the parts that are pure
 * transport concern (helmet/cors/compression/static) and would only slow tests down.
 *
 * The middleware that CAN change a response - body-parser error handling, optionalAuth, the
 * audit logger, the 404 and the error handler - is the real thing in the real order, so a route
 * test exercises the same stack production does. Getting this wrong is how a suite goes green
 * while the deployed app 500s.
 */

import express from 'express';
import { optionalAuth } from '../../src/middleware/auth.js';
import { errorHandler, notFoundHandler } from '../../src/middleware/error-handler.js';
import { bodyParserErrorHandler } from '../../src/middleware/request-logger.js';
import { auditLogger } from '../../src/middleware/audit-logger.js';
import { noStore } from '../../src/middleware/no-store.js';

/**
 * @param {object} router  Router to mount
 * @param {string} at      Mount path, e.g. '/api/v1/instances'
 */
export function buildApp(router, at = '/api/v1') {
  const app = express();

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(bodyParserErrorHandler);
  app.use('/api/v1', noStore);
  app.use(optionalAuth);
  app.use('/api/v1', auditLogger);
  app.use(at, router);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/**
 * Start a real, long-lived HTTP server for an app and return it.
 *
 * supertest normally calls app.listen(0) per request and closes it again. That is fine for a
 * handful of requests, but the contract sweep makes ~1000 in a tight loop, and when the whole
 * suite runs its files in parallel that server churn produced occasional responses that did not
 * match the request that asked for them - an anonymous call answered 404, a token-bearing call
 * answered 401. It reproduced only under parallel load: 1200+ sequential requests through the
 * identical code path never produced one.
 *
 * Binding once and reusing the connection removes the churn rather than papering over the
 * symptom with a retry, which would have hidden a genuine auth regression just as effectively.
 */
export function listen(app) {
  const server = app.listen(0);
  server.unref();
  return server;
}
