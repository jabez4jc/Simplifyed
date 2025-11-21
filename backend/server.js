/**
 * Simplifyed Admin V2 - Server Entry Point
 * Complete rebuild with clean architecture
 */

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import passport from 'passport';
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

// Middleware
import { configureSession, configurePassport, requireAuth, optionalAuth } from './src/middleware/auth.js';
import { errorHandler, notFoundHandler } from './src/middleware/error-handler.js';
import { requestLogger, bodyParserErrorHandler } from './src/middleware/request-logger.js';
import { checkInstrumentsRefresh } from './src/middleware/instruments-refresh.middleware.js';

// Routes
import apiV1Routes from './src/routes/v1/index.js';

let servicesStarted = false;
const startPaused = process.env.START_PAUSED === 'true'; // default to false unless explicitly set

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

// Passport authentication
app.use(configurePassport());
app.use(passport.session());

// Optional auth (sets req.user in test mode)
app.use(optionalAuth);

// Instruments refresh check (runs in background after authentication)
app.use(checkInstrumentsRefresh);

/**
 * Routes
 */

// API v1
app.use('/api/v1', apiV1Routes);

// Google OAuth routes
app.get('/auth/google', passport.authenticate('google', {
  scope: ['profile', 'email'],
}));

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login' }),
  (req, res) => {
    res.redirect('/dashboard');
  }
);

// Logout
app.post('/auth/logout', (req, res) => {
  req.logout((err) => {
    if (err) {
      log.error('Logout error', err);
    }
    res.json({ status: 'success', message: 'Logged out successfully' });
  });
});

// Current user
app.get('/api/user', requireAuth, (req, res) => {
  res.json({
    status: 'success',
    data: {
      id: req.user.id,
      email: req.user.email,
      is_admin: req.user.is_admin,
    },
  });
});

// Static files (frontend)
app.use(express.static('public'));

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
        log.info('Test user created');
      }
    }

    // Start shared market data feed service (quotes/positions/funds cache)
    // Start background services unless paused
    if (startPaused) {
      log.warn('Server starting in PAUSED mode: background polling is not running until resumed');
    } else {
      await startBackgroundServices();
    }

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

      if (!config.auth.googleClientId) {
        console.log('⚠️  Running in TEST MODE (no Google OAuth configured)');
        console.log('   All requests will use test user: test@example.com');
        console.log('');
      }
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
