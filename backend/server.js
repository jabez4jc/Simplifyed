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
import { config } from './src/core/config.js';
import { log } from './src/core/logger.js';
import db from './src/core/database.js';
import pollingService from './src/services/polling.service.js';
import marketDataFeedService from './src/services/market-data-feed.service.js';
import autoExitService from './src/services/auto-exit.service.js';
// Order monitor service removed - no longer needed after target/stoploss removal
// import orderMonitorService from './src/services/order-monitor.service.js';
import telegramService from './src/services/telegram.service.js';
import openalgoClient from './src/integrations/openalgo/client.js';
import settingsService from './src/services/settings.service.js';
import instanceHealthService, { isBlackout } from './src/services/instance-health.service.js';
import authLocalService from './src/services/auth-local.service.js';

// Middleware
import { configureSession, requireAuth, optionalAuth, getUserWithRole } from './src/middleware/auth.js';
import { errorHandler, notFoundHandler } from './src/middleware/error-handler.js';
import { requestLogger, bodyParserErrorHandler } from './src/middleware/request-logger.js';
import { checkInstrumentsRefresh } from './src/middleware/instruments-refresh.middleware.js';

// Routes
import apiV1Routes from './src/routes/v1/index.js';

let servicesStarted = false;

async function startBackgroundServices() {
  if (servicesStarted) return;
  await marketDataFeedService.start({
    quoteInterval: config.polling.marketDataInterval || undefined,
  });
  log.info('Market data feed service started');

  await autoExitService.start();
  log.info('Auto exit service started');

  await pollingService.start();
  log.info('Polling service started');

  await telegramService.startPolling();
  log.info('Telegram polling started');

  servicesStarted = true;
}

function stopBackgroundServices() {
  try {
    marketDataFeedService.stop && marketDataFeedService.stop();
    pollingService.stop && pollingService.stop();
    telegramService.stopPolling && telegramService.stopPolling();
  } catch (err) {
    log.warn('Error stopping background services', { error: err.message });
  }
  servicesStarted = false;
}

// Create Express app
const app = express();
app.locals.startServices = startBackgroundServices;

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

// Request logging
app.use(requestLogger);

// Session
app.use(configureSession());

// Optional auth (sets req.user in test mode)
app.use(optionalAuth);

// Instruments refresh check (runs in background after authentication)
app.use(checkInstrumentsRefresh);

/**
 * Routes
 */

// API v1
app.use('/api/v1', apiV1Routes);

// Auth routes (local)
app.post('/auth/signup', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const user = await authLocalService.createUser({ email, password });
    req.session.userId = user.id;
    req.user = user;
    await startBackgroundServices();
    res.json({ status: 'success', data: user });
  } catch (error) {
    next(error);
  }
});

app.post('/auth/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const user = await authLocalService.authenticate({ email, password });
    req.session.userId = user.id;
    req.user = user;
    await startBackgroundServices();
    res.json({ status: 'success', data: user });
  } catch (error) {
    next(error);
  }
});

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

// Blackout guard for API requests (01:00-08:00 IST)
app.use((req, res, next) => {
  if (req.path.startsWith('/api') && isBlackout()) {
    return res.status(503).json({
      status: 'error',
      code: 'MARKET_CLOSED',
      message: 'Market is closed (01:00-08:00 IST). Broker instances are paused.',
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

    // Initialize OpenAlgo client rate limits from database
    await openalgoClient.initializeRateLimits();
    log.info('OpenAlgo rate limits initialized');

    // Set up event-driven rate limit reload on settings change
    settingsService.on('settings:changed', async (data) => {
      if (data.category === 'rate_limits') {
        log.info('Rate limit settings changed, reloading...');
        await openalgoClient.reloadRateLimits();
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

    // Start HTTP server
    app.listen(config.port, () => {
      log.info('Server started', {
        port: config.port,
        env: config.env,
        baseUrl: config.baseUrl,
        testMode: !config.auth.googleClientId,
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
      console.log('║    - Telegram Polling:  Every 2s                           ║');
      console.log('║                                                            ║');
      console.log('╚════════════════════════════════════════════════════════════╝');
      console.log('');

      // Start instance health cron (every 3h from 08:00 IST)
      instanceHealthService.start();

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
    // Stop Telegram polling
    telegramService.stopPolling();
    log.info('Telegram polling stopped');

    // Order monitor service removed - no longer needed after target/stoploss removal
    // orderMonitorService.stop();
    // log.info('Order monitor service stopped');

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
