/**
 * Configuration Management
 * Loads settings from database with fallback to environment variables
 */

import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import settingsService from '../services/settings.service.js';
import { log } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
loadEnv({ path: join(__dirname, '../../.env') });

// Cache for database settings
let settingsCache = null;
let cacheTimestamp = 0;
const CACHE_DURATION = 5000; // 5 seconds cache

/**
 * Get setting from database or environment variable
 * Priority: Database settings > Environment variables > Default value
 */
async function getSetting(key, defaultValue = undefined, required = false) {
  try {
    // Check cache
    const now = Date.now();
    if (!settingsCache || (now - cacheTimestamp) > CACHE_DURATION) {
      settingsCache = await settingsService.getAllSettings();
      cacheTimestamp = now;
    }

    // Try to get from database settings
    for (const category in settingsCache) {
      if (settingsCache[category][key]) {
        const setting = settingsCache[category][key];
        return setting.rawValue || setting.value;
      }
    }

    // Fallback to environment variable
    const envValue = process.env[key.toUpperCase().replace(/\./g, '_')] || process.env[key];
    if (envValue) {
      return envValue;
    }

    // Use default value
    if (defaultValue !== undefined) {
      return defaultValue;
    }

    // Required but not found
    if (required) {
      throw new Error(`Missing required setting: ${key}`);
    }

    return null;
  } catch (error) {
    // If database is not available, fallback to env vars
    const envValue = process.env[key.toUpperCase().replace(/\./g, '_')] || process.env[key];
    if (envValue) {
      return envValue;
    }
    if (required) {
      throw error;
    }
    return defaultValue;
  }
}

/**
 * Get integer setting
 */
async function getSettingInt(key, defaultValue) {
  const value = await getSetting(key, defaultValue);
  if (value === null || value === undefined) return defaultValue;

  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`Setting ${key} must be a valid integer`);
  }

  return parsed;
}

/**
 * Get boolean setting
 */
async function getSettingBool(key, defaultValue) {
  const value = await getSetting(key, defaultValue);
  if (value === null || value === undefined) return defaultValue;

  return value.toString().toLowerCase() === 'true';
}

/**
 * Reload settings from database (for runtime updates)
 */
export async function reloadConfig() {
  settingsCache = null;
  cacheTimestamp = 0;
  return getSetting('server.port'); // Trigger cache reload
}

/**
 * Get environment variable with validation (legacy support)
 */
function getEnv(key, defaultValue = undefined, required = false) {
  const value = process.env[key] || defaultValue;

  if (required && !value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }

  return value;
}

/**
 * Parse integer from environment (legacy support)
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
 * Parse boolean from environment (legacy support)
 */
function getEnvBool(key, defaultValue = false) {
  const value = process.env[key];
  if (!value) return defaultValue;

  return value.toLowerCase() === 'true';
}

/**
 * Application Configuration
 * Loads from database with env var fallback
 */
class Config {
  constructor() {
    // Load from environment variables initially (sync)
    // Will be overridden by database settings when available
    this._loadFromEnv();
  }

  /**
   * Load configuration from environment variables (fallback)
   * @private
   */
  _loadFromEnv() {
    this.env = getEnv('NODE_ENV', 'development');
    this.isDev = this.env === 'development';
    this.isProd = this.env === 'production';
    this.isTest = this.env === 'test';

    this.port = getEnvInt('PORT', 3000);
    this.baseUrl = getEnv('BASE_URL', 'http://localhost:3000');

    this.database = {
      path: getEnv('DATABASE_PATH', './database/simplifyed.db'),
    };

    this.session = {
      secret: getEnv('SESSION_SECRET', 'dev-secret-change-in-production', true),
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    };

    this.google = {
      clientId: getEnv('GOOGLE_CLIENT_ID'),
      clientSecret: getEnv('GOOGLE_CLIENT_SECRET'),
      callbackUrl: getEnv('GOOGLE_CALLBACK_URL', 'http://localhost:3000/auth/google/callback'),
    };

    this.auth = {
      googleClientId: getEnv('GOOGLE_CLIENT_ID'),
      googleClientSecret: getEnv('GOOGLE_CLIENT_SECRET'),
    };

    this.cors = {
      origin: getEnv('CORS_ORIGIN', 'http://localhost:3000'),
      credentials: true,
    };

    this.testMode = {
      enabled: getEnvBool('TEST_MODE', false),
      userEmail: getEnv('TEST_USER_EMAIL', 'test@simplifyed.in'),
    };

    this.polling = {
      instanceInterval: getEnvInt('INSTANCE_POLL_INTERVAL_MS', 15000),
      marketDataInterval: getEnvInt('MARKET_DATA_POLL_INTERVAL_MS', 5000),
    };

    this.autoExit = {
      monitorIntervalMs: getEnvInt('AUTO_EXIT_MONITOR_INTERVAL_MS', 5000),
    };

    this.marketDataFeed = {
      quoteTtlMs: getEnvInt('MARKET_DATA_QUOTE_TTL_MS', 2500),
      positionTtlMs: getEnvInt('MARKET_DATA_POSITION_TTL_MS', 8000),
      fundsTtlMs: getEnvInt('MARKET_DATA_FUNDS_TTL_MS', 20000),
      orderbookTtlMs: getEnvInt('MARKET_DATA_ORDERBOOK_TTL_MS', 5000),
      websocketMode: getEnvInt('MARKET_DATA_WEBSOCKET_MODE', 2),
    };

    this.openalgo = {
      requestTimeout: getEnvInt('OPENALGO_REQUEST_TIMEOUT_MS', 15000),
      critical: {
        maxRetries: getEnvInt('OPENALGO_CRITICAL_MAX_RETRIES', 3),
        retryDelay: getEnvInt('OPENALGO_CRITICAL_RETRY_DELAY_MS', 500),
      },
      nonCritical: {
        maxRetries: getEnvInt('OPENALGO_NONCRITICAL_MAX_RETRIES', 1),
        retryDelay: getEnvInt('OPENALGO_NONCRITICAL_RETRY_DELAY_MS', 2000),
      },
    };

    this.logging = {
      level: getEnv('LOG_LEVEL', 'info'),
      file: getEnv('LOG_FILE', './logs/app.log'),
    };

    this.rateLimit = {
      windowMs: getEnvInt('RATE_LIMIT_WINDOW_MS', 60000),
      maxRequests: getEnvInt('RATE_LIMIT_MAX_REQUESTS', 100),
    };
  }

  /**
   * Load configuration from database (async)
   * Call this after database connection is established
   */
  async loadFromDatabase() {
    try {
      const dbSettings = await settingsService.getAllSettings();

      // Apply database settings with fallback to current values
      this.env = getSetting('server.node_env', this.env);
      this.isDev = this.env === 'development';
      this.isProd = this.env === 'production';
      this.isTest = this.env === 'test';

      this.port = await getSettingInt('server.port', this.port);
      this.baseUrl = getSetting('server.node_env', this.baseUrl);

      this.database.path = getSetting('database.path', this.database.path);
      this.session.secret = getSetting('session.secret', this.session.secret);
      this.session.maxAge = await getSettingInt('session.max_age_ms', this.session.maxAge);

      this.google.clientId = getSetting('oauth.google.client_id', this.google.clientId);
      this.google.clientSecret = getSetting('oauth.google.client_secret', this.google.clientSecret);
      this.google.callbackUrl = getSetting('oauth.google.callback_url', this.google.callbackUrl);

      this.auth.googleClientId = this.google.clientId;
      this.auth.googleClientSecret = this.google.clientSecret;

      this.cors.origin = getSetting('cors.origin', this.cors.origin);
      this.cors.credentials = await getSettingBool('cors.credentials', this.cors.credentials);

      this.testMode.enabled = await getSettingBool('test_mode.enabled', this.testMode.enabled);
      this.testMode.userEmail = getSetting('test_mode.user_email', this.testMode.userEmail);

      this.polling.instanceInterval = await getSettingInt('polling.instance_interval_ms', this.polling.instanceInterval);
      this.polling.marketDataInterval = await getSettingInt('polling.market_data_interval_ms', this.polling.marketDataInterval);
      this.marketDataFeed.quoteTtlMs = await getSettingInt('market_data_feed.quote_ttl_ms', this.marketDataFeed.quoteTtlMs);
      this.marketDataFeed.positionTtlMs = await getSettingInt('market_data_feed.position_ttl_ms', this.marketDataFeed.positionTtlMs);
      this.marketDataFeed.fundsTtlMs = await getSettingInt('market_data_feed.funds_ttl_ms', this.marketDataFeed.fundsTtlMs);
      this.marketDataFeed.orderbookTtlMs = await getSettingInt('market_data_feed.orderbook_ttl_ms', this.marketDataFeed.orderbookTtlMs);
      this.marketDataFeed.websocketMode = await getSettingInt('market_data_feed.websocket_mode', this.marketDataFeed.websocketMode);
      this.autoExit.monitorIntervalMs = await getSettingInt('auto_exit.monitor_interval_ms', this.autoExit.monitorIntervalMs);

      this.openalgo.requestTimeout = await getSettingInt('openalgo.request_timeout_ms', this.openalgo.requestTimeout);
      this.openalgo.critical.maxRetries = await getSettingInt('openalgo.critical.max_retries', this.openalgo.critical.maxRetries);
      this.openalgo.critical.retryDelay = await getSettingInt('openalgo.critical.retry_delay_ms', this.openalgo.critical.retryDelay);
      this.openalgo.nonCritical.maxRetries = await getSettingInt('openalgo.non_critical.max_retries', this.openalgo.nonCritical.maxRetries);
      this.openalgo.nonCritical.retryDelay = await getSettingInt('openalgo.non_critical.retry_delay_ms', this.openalgo.nonCritical.retryDelay);

      this.logging.level = getSetting('logging.level', this.logging.level);
      this.logging.file = getSetting('logging.file', this.logging.file);

      this.rateLimit.windowMs = await getSettingInt('rate_limit.window_ms', this.rateLimit.windowMs);
      this.rateLimit.maxRequests = await getSettingInt('rate_limit.max_requests', this.rateLimit.maxRequests);

      log.info('Configuration loaded from database');
    } catch (error) {
      log.warn('Failed to load configuration from database, using environment variables', error.message);
    }
  }
}

export const config = new Config();

export default config;
