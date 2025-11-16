/**
 * Configuration Management
 * Loads and validates environment variables
 */

import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
loadEnv({ path: join(__dirname, '../../.env') });

/**
 * Get environment variable with validation
 */
function getEnv(key, defaultValue = undefined, required = false) {
  const value = process.env[key] || defaultValue;

  if (required && !value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }

  return value;
}

/**
 * Parse integer from environment
 */
function getEnvInt(key, defaultValue) {
  const value = process.env[key];
  if (!value) return defaultValue;

  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`Environment variable ${key} must be a valid integer`);
  }

  return parsed;
}

/**
 * Parse boolean from environment
 */
function getEnvBool(key, defaultValue = false) {
  const value = process.env[key];
  if (!value) return defaultValue;

  return value.toLowerCase() === 'true';
}

/**
 * Application Configuration
 */
export const config = {
  // Environment
  env: getEnv('NODE_ENV', 'development'),
  isDev: getEnv('NODE_ENV') === 'development',
  isProd: getEnv('NODE_ENV') === 'production',
  isTest: getEnv('NODE_ENV') === 'test',

  // Server
  port: getEnvInt('PORT', 3000),
  baseUrl: getEnv('BASE_URL', 'http://localhost:3000'),

  // Database
  database: {
    path: getEnv('DATABASE_PATH', './database/simplifyed.db'),
  },

  // Session
  session: {
    secret: getEnv('SESSION_SECRET', 'dev-secret-change-in-production', true),
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },

  // Google OAuth
  google: {
    clientId: getEnv('GOOGLE_CLIENT_ID'),
    clientSecret: getEnv('GOOGLE_CLIENT_SECRET'),
    callbackUrl: getEnv('GOOGLE_CALLBACK_URL', 'http://localhost:3000/auth/google/callback'),
  },

  // Authentication
  auth: {
    googleClientId: getEnv('GOOGLE_CLIENT_ID'),
    googleClientSecret: getEnv('GOOGLE_CLIENT_SECRET'),
  },

  // CORS
  cors: {
    origin: getEnv('CORS_ORIGIN', 'http://localhost:3000'),
    credentials: true,
  },

  // Test Mode
  testMode: {
    enabled: getEnvBool('TEST_MODE', false),
    userEmail: getEnv('TEST_USER_EMAIL', 'test@simplifyed.in'),
  },

  // Polling Configuration
  polling: {
    instanceInterval: getEnvInt('INSTANCE_POLL_INTERVAL_MS', 15000),
    marketDataInterval: getEnvInt('MARKET_DATA_POLL_INTERVAL_MS', 5000),
  },

  // OpenAlgo
  openalgo: {
    requestTimeout: getEnvInt('OPENALGO_REQUEST_TIMEOUT_MS', 15000),
    // Critical operations (orders, cancellations) - fast retries
    critical: {
      maxRetries: getEnvInt('OPENALGO_CRITICAL_MAX_RETRIES', 3),
      retryDelay: getEnvInt('OPENALGO_CRITICAL_RETRY_DELAY_MS', 500),
    },
    // Non-critical operations (polling, quotes) - slower retries
    nonCritical: {
      maxRetries: getEnvInt('OPENALGO_NONCRITICAL_MAX_RETRIES', 1),
      retryDelay: getEnvInt('OPENALGO_NONCRITICAL_RETRY_DELAY_MS', 2000),
    },
  },

  // Logging
  logging: {
    level: getEnv('LOG_LEVEL', 'info'),
    file: getEnv('LOG_FILE', './logs/app.log'),
  },

  // Rate Limiting
  rateLimit: {
    windowMs: getEnvInt('RATE_LIMIT_WINDOW_MS', 60000),
    maxRequests: getEnvInt('RATE_LIMIT_MAX_REQUESTS', 100),
  },

  // Feature Flags (Watchlist Trading Spec v3)
  // Conservative approach: All features disabled by default
  features: {
    // Phase 2: Settings Service
    enableSettingsHierarchy: getEnvBool('ENABLE_SETTINGS_HIERARCHY', true), // Safe to enable (read-only hierarchy)

    // Phase 3: Risk Engine
    enableRiskEngine: getEnvBool('ENABLE_RISK_ENGINE', false), // Disabled by default
    enableFillAggregator: getEnvBool('ENABLE_FILL_AGGREGATOR', false),
    enableQuoteRouter: getEnvBool('ENABLE_QUOTE_ROUTER', false),
    enableTSLTrailing: getEnvBool('ENABLE_TSL_TRAILING', false),
    enableScopeExits: getEnvBool('ENABLE_SCOPE_EXITS', false),

    // Phase 4: Enhanced Orders
    enableTradeIntents: getEnvBool('ENABLE_TRADE_INTENTS', false), // Disabled by default
    enableServerResolution: getEnvBool('ENABLE_SERVER_RESOLUTION', false),
    enableDeltaCalculation: getEnvBool('ENABLE_DELTA_CALCULATION', false),
    enablePyramiding: getEnvBool('ENABLE_PYRAMIDING', false),

    // Emergency kill switches
    killRiskExits: getEnvBool('KILL_RISK_EXITS', false), // Emergency stop for all risk exits
    killAutoTrading: getEnvBool('KILL_AUTO_TRADING', false), // Emergency stop for all automated trading
  },
};

export default config;
