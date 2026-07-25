/**
 * Simplifyed Admin V2 - Server Entry Point
 * Complete rebuild with clean architecture
 */

// Force server timezone to IST for consistent timestamps across the app
process.env.TZ = 'Asia/Kolkata';

import express from 'express';
import fs from 'fs';
import path from 'path';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import http from 'http';
import session from 'express-session';
import connectSqlite3 from 'connect-sqlite3';
import signature from 'cookie-signature';
import { config } from './src/core/config.js';
import { log } from './src/core/logger.js';
import db from './src/core/database.js';
import pollingService from './src/services/polling.service.js';
import marketDataFeedService from './src/services/market-data-feed.service.js';
import autoExitService from './src/services/auto-exit.service.js';
import telegramService from './src/services/telegram.service.js';
import openalgoClient from './src/integrations/openalgo/client.js';
import settingsService from './src/services/settings.service.js';
import instanceHealthService, { isGeneralEndpointBlackout, isQuoteEndpointBlackout } from './src/services/instance-health.service.js';
import instrumentsService from './src/services/instruments.service.js';
import wsGatewayService from './src/services/ws-gateway.service.js';
import instanceService from './src/services/instance.service.js';
import tradingviewWebhookRoutes from './src/routes/tradingview-webhook.js';
import idempotencyService from './src/services/idempotency.service.js';

// Middleware
import { configureSession, requireAuth, optionalAuth, getUserWithRole } from './src/middleware/auth.js';
import { errorHandler, notFoundHandler } from './src/middleware/error-handler.js';
import { correlationId, requestLogger, bodyParserErrorHandler } from './src/middleware/request-logger.js';
import { checkInstrumentsRefresh } from './src/middleware/instruments-refresh.middleware.js';
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

    // Telegram integration is webhook-based (see routes/v1/telegram.js POST /webhook), not
    // polling-based - telegramService has no startPolling/stopPolling methods to call here.
  } catch (err) {
    servicesStarted = false;
    log.error('Failed to start background services', err);
    throw err;
  }
}

function stopBackgroundServices() {
  try {
    marketDataFeedService.stop && marketDataFeedService.stop();
    pollingService.stop && pollingService.stop();
  } catch (err) {
    log.warn('Error stopping background services', { error: err.message });
  }
  servicesStarted = false;
}

// Session-backed WS auth helpers
const SQLiteStore = connectSqlite3(session);
let wsSessionStore = null;

function getWsSessionStore() {
  if (wsSessionStore) return wsSessionStore;

  const dataDir = path.join(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  wsSessionStore = new SQLiteStore({
    db: 'sessions.db',
    dir: dataDir,
    table: 'sessions',
    concurrentDB: true,
  });

  return wsSessionStore;
}

function parseCookies(cookieHeader = '') {
  return cookieHeader.split(';').reduce((acc, part) => {
    const [key, ...rest] = part.trim().split('=');
    if (!key) return acc;
    acc[key] = decodeURIComponent(rest.join('=') || '');
    return acc;
  }, {});
}

async function validateWsSessionFromRequest(req) {
  try {
    const cookies = parseCookies(req.headers?.cookie || '');
    const raw = cookies['connect.sid'];
    if (!raw) return false;

    // Express-session cookies are signed: s:<value>.signature
    const unsigned = signature.unsign(raw.startsWith('s:') ? raw.slice(2) : raw, config.session.secret);
    if (!unsigned) return false;

    const store = getWsSessionStore();
    return await new Promise((resolve) => {
      store.get(unsigned, (err, sess) => {
        if (err) {
          log.warn('WS session lookup failed', { error: err.message });
          return resolve(false);
        }
        if (!sess) return resolve(false);
        const expires = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : null;
        if (expires && expires < Date.now()) return resolve(false);
        return resolve(true);
      });
    });
  } catch (err) {
    log.warn('WS session validation error', { error: err.message });
    return false;
  }
}

// Create Express app
const app = express();
const server = http.createServer(app);
app.locals.startServices = startBackgroundServices;
app.set('trust proxy', 1);

/**
 * Middleware Setup
 */

// Security
app.use(helmet({
  contentSecurityPolicy: false, // Disable for development
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

// Session
app.use(configureSession());

// Optional auth (sets req.user in test mode)
app.use(optionalAuth);

// Instruments refresh check (runs in background after authentication)
app.use(checkInstrumentsRefresh);

// Audit logger for mutating API requests
app.use('/api/v1', auditLogger);

/**
 * Routes
 */

// TradingView broadcast webhook (public token auth)
app.use('/webhook/tradingview', tradingviewWebhookRoutes);
app.use('/webhook/tradingview', auditLogger);

// API v1
app.use('/api/v1', apiV1Routes);

// Auth: login/register/change-password are local email+password (see public/login.html and
// src/routes/v1/auth.js) - this endpoint just clears the separate local session cookie used
// for WS gateway auth.
app.post('/auth/logout', (req, res, next) => {
  try {
    const sessionId = req.sessionID;
    req.session.destroy(() => {
      // Explicitly clear the session cookie so the browser stops sending it
      res.clearCookie('connect.sid', {
        httpOnly: true,
        secure: config.env === 'production',
        sameSite: 'lax',
      });
      log.info('Session destroyed on logout', { sessionId });
      res.json({ status: 'success', message: 'Logged out successfully' });
    });
  } catch (error) {
    next(error);
  }
});

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

// Blackout guard for API requests (quote vs general windows)
app.use((req, res, next) => {
  if (!req.path.startsWith('/api')) {
    return next();
  }

  const path = req.path.toLowerCase();
  const isQuoteRequest = path.includes('quotes') || path.includes('optionchain') || path.includes('ltp');

  if (isQuoteRequest && isQuoteEndpointBlackout()) {
    return res.status(503).json({
      status: 'error',
      code: 'MARKET_CLOSED',
      message: 'Market is closed for quotes (02:00-08:45 IST). Broker instances are paused.',
    });
  }

  if (!isQuoteRequest && isGeneralEndpointBlackout()) {
    return res.status(503).json({
      status: 'error',
      code: 'MARKET_CLOSED',
      message: 'Market is closed (03:00-08:00 IST). Broker instances are paused.',
    });
  }
  next();
});

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

    // Load configuration from database
    await config.loadFromDatabase();
    log.info('Configuration loaded from database');

    // Clean up expired idempotency keys on boot and every 6 hours
    await idempotencyService.cleanupExpired();
    setInterval(() => {
      idempotencyService.cleanupExpired().catch(() => {});
    }, 6 * 60 * 60 * 1000);

    // Initialize OpenAlgo client rate limits from database
    await openalgoClient.initializeRateLimits();
    log.info('OpenAlgo rate limits initialized');

    // Set up event-driven rate limit reload on settings change
    settingsService.on('settings:changed', async (data) => {
      if (data.category === 'rate_limits') {
        log.info('Rate limit settings changed, reloading...');
        await openalgoClient.reloadRateLimits();
      }

      const needsReload = ['polling', 'market_data_feed', 'instance_health', 'market_hours'].includes(data.category);
      if (needsReload) {
        await config.loadFromDatabase();
        marketDataFeedService.applyConfig(config);
        pollingService.applyConfig(config);
      }
    });

    // Ensure test user exists in development
    if (config.env === 'development' && !config.auth.googleClientId) {
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

    // Do not start background services until user logs in (lazy start)

    // Resolve WS-capable instances once at boot (safe fallback)
    let websocketCapableInstanceIds = [];
    if (config.wsGateway?.enabled) {
      try {
        websocketCapableInstanceIds = await instanceService.getWebsocketCapableInstanceIds();
      } catch (err) {
        log.warn('Failed to resolve websocket-capable instances', { error: err.message });
      }
    }

    // Start WebSocket gateway (opt-in, session-authenticated)
    wsGatewayService.start(server, {
      enabled: config.wsGateway?.enabled,
      path: config.wsGateway?.path,
      tokenValidator: async (_token, req) => validateWsSessionFromRequest(req),
      instanceFilter: () => websocketCapableInstanceIds,
    });

    // Start HTTP server
    server.listen(config.port, () => {
      log.info('Server started', {
        port: config.port,
        env: config.env,
        baseUrl: config.baseUrl,
        testMode: !config.auth.googleClientId,
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
      console.log(`║  Test Mode:    ${String(!config.auth.googleClientId ? 'Yes' : 'No').padEnd(43)} ║`);
      console.log('║                                                            ║');
      console.log('╠════════════════════════════════════════════════════════════╣');
      console.log('║  API Endpoints:                                            ║');
      console.log('║    - GET  /api/v1/health                                   ║');
      console.log('║    - GET  /api/v1/instances                                ║');
      console.log('║    - GET  /api/v1/watchlists                               ║');
      console.log('║    - GET  /api/v1/orders                                   ║');
      console.log('║    - GET  /api/v1/positions/:instanceId                    ║');
      console.log('║    - GET  /api/v1/symbols/search                           ║');
      console.log('║    - GET  /api/v1/polling/status                           ║');
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

      // Start crypto instruments daily refresh cron (17:31 IST)
      instrumentsService.startCryptoDailyRefresh();

      // Removed legacy Google OAuth test mode banner
    });
  } catch (error) {
    log.error('Failed to start server', error);
    process.exit(1);
  }
}

/**
 * Graceful Shutdown
 */
async function shutdown() {
  log.info('Shutting down server...');

  try {
    // Telegram is webhook-based, not polling-based - no stopPolling method to call here
    // (see the matching note at startup, ~line 66).

    // Stop polling service
    pollingService.stop();
    log.info('Polling service stopped');

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

// Start server
startServer();
