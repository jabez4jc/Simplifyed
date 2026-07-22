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
let settingsCacheDurationMs = getEnvInt('SETTINGS_CACHE_DURATION_MS', 5000); // 5 seconds cache

function parseStrategyBufferConfig(rawValue) {
  if (!rawValue) return {};
  try {
    const parsed = typeof rawValue === 'string' ? JSON.parse(rawValue) : rawValue;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.entries(parsed).reduce((acc, [key, value]) => {
      const pct = parseFloat(value);
      if (Number.isFinite(pct) && pct >= 0) {
        acc[String(key)] = pct;
      }
      return acc;
    }, {});
  } catch (err) {
    log.warn('Invalid TRADINGVIEW_BUFFER_BY_STRATEGY JSON, ignoring', { error: err.message });
    return {};
  }
}

/**
 * Get setting from database or environment variable
 * Priority: Database settings > Environment variables > Default value
 */
async function getSetting(key, defaultValue = undefined, required = false) {
  try {
    // Check cache
    const now = Date.now();
    if (!settingsCache || (now - cacheTimestamp) > settingsCacheDurationMs) {
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
 * Get float setting
 */
async function getSettingFloat(key, defaultValue) {
  const value = await getSetting(key, defaultValue);
  if (value === null || value === undefined) return defaultValue;

  const parsed = parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Setting ${key} must be a valid number`);
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
 * Parse float from environment (legacy support)
 */
function getEnvFloat(key, defaultValue) {
  const value = process.env[key];
  if (!value) return defaultValue;

  const parsed = parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${key} must be a valid number`);
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
      clientId: null,
      clientSecret: null,
      callbackUrl: getEnv('GOOGLE_CALLBACK_URL', 'http://localhost:3000/auth/google/callback'),
    };

    this.auth = {
      googleClientId: null,
      googleClientSecret: null,
      enableTestMode: getEnvBool('ENABLE_TEST_MODE', false),
      jwtSecret: getEnv('JWT_SECRET', 'dev-jwt-secret-change-in-production', true),
      supabaseUrl: getEnv('SUPABASE_URL', ''),
      supabaseAnonKey: getEnv('SUPABASE_ANON_KEY', ''),
      supabaseJwtSecret: getEnv('SUPABASE_JWT_SECRET', ''),
      supabaseAudience: getEnv('SUPABASE_JWT_AUD', ''),
      supabaseIssuer: getEnv('SUPABASE_JWT_ISS', ''),
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
      healthCheckInterval: getEnvInt('HEALTH_CHECK_INTERVAL_MS', 60000),
    };

    this.wsGateway = {
      enabled: getEnvBool('WS_GATEWAY_ENABLED', true),
      path: getEnv('WS_GATEWAY_PATH', '/stream'),
    };

    this.autoExit = {
      monitorIntervalMs: getEnvInt('AUTO_EXIT_MONITOR_INTERVAL_MS', 5000),
      pendingExitCooldownMs: getEnvInt('AUTO_EXIT_PENDING_COOLDOWN_MS', 30000),
      provisionalEntryGraceMs: getEnvInt('AUTO_EXIT_PROVISIONAL_ENTRY_GRACE_MS', 20000),
      confirmationWindowMs: getEnvInt('AUTO_EXIT_CONFIRMATION_WINDOW_MS', 0),
    };

    this.marketDataFeed = {
      quoteTtlMs: getEnvInt('MARKET_DATA_QUOTE_TTL_MS', 15000),
      quoteTtlIdleMs: getEnvInt('MARKET_DATA_QUOTE_TTL_IDLE_MS', 15000),
      quoteTtlActiveMs: getEnvInt('MARKET_DATA_QUOTE_TTL_ACTIVE_MS', 10000),
      positionTtlMs: getEnvInt('MARKET_DATA_POSITION_TTL_MS', 30000),
      positionIntervalIdleMs: getEnvInt('MARKET_DATA_POSITION_INTERVAL_IDLE_MS', 30000),
      positionIntervalActiveMs: getEnvInt('MARKET_DATA_POSITION_INTERVAL_ACTIVE_MS', 8000),
      fundsTtlMs: getEnvInt('MARKET_DATA_FUNDS_TTL_MS', 180000),
      fundsIntervalMs: getEnvInt('MARKET_DATA_FUNDS_INTERVAL_MS', 180000),
      orderbookTtlMs: getEnvInt('MARKET_DATA_ORDERBOOK_TTL_MS', 30000),
      orderbookIntervalMs: getEnvInt('MARKET_DATA_ORDERBOOK_INTERVAL_MS', 30000),
      tradebookTtlMs: getEnvInt('MARKET_DATA_TRADEBOOK_TTL_MS', 30000),
      tradebookIntervalIdleMs: getEnvInt('MARKET_DATA_TRADEBOOK_INTERVAL_IDLE_MS', 30000),
      tradebookIntervalActiveMs: getEnvInt('MARKET_DATA_TRADEBOOK_INTERVAL_ACTIVE_MS', 8000),
      multiquoteCooldownIdleMs: getEnvInt('MARKET_DATA_MULTIQ_COOLDOWN_IDLE_MS', 15000),
      multiquoteCooldownActiveMs: getEnvInt('MARKET_DATA_MULTIQ_COOLDOWN_ACTIVE_MS', 10000),
      orderQuoteStaleMs: getEnvInt('MARKET_DATA_ORDER_QUOTE_STALE_MS', 2000),
      maxOrderSpreadPct: getEnvFloat('MARKET_DATA_MAX_ORDER_SPREAD_PCT', 0.005),
    };

    this.instanceHealth = {
      pingHealthyIntervalMs: getEnvInt('INSTANCE_HEALTH_PING_HEALTHY_MS', 300000),
      pingUnhealthyIntervalMs: getEnvInt('INSTANCE_HEALTH_PING_UNHEALTHY_MS', 180000),
      pingUnhealthyMaxAttempts: getEnvInt('INSTANCE_HEALTH_PING_UNHEALTHY_MAX', 5),
      analyzerCheckIntervalMs: getEnvInt('INSTANCE_HEALTH_ANALYZER_CHECK_MS', 15000),
    };

    this.marketHours = {
      quoteBlackoutStart: getEnv('MARKET_BLACKOUT_QUOTES_START', '02:00'),
      quoteBlackoutEnd: getEnv('MARKET_BLACKOUT_QUOTES_END', '08:45'),
      generalBlackoutStart: getEnv('MARKET_BLACKOUT_GENERAL_START', '03:00'),
      generalBlackoutEnd: getEnv('MARKET_BLACKOUT_GENERAL_END', '08:00'),
    };

    this.openalgo = {
      requestTimeout: getEnvInt('OPENALGO_REQUEST_TIMEOUT_MS', 5000),
      critical: {
        maxRetries: getEnvInt('OPENALGO_CRITICAL_MAX_RETRIES', 2),
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

    this.telegram = {
      botToken: getEnv('TELEGRAM_BOT_TOKEN', ''),
      botUsername: getEnv('TELEGRAM_BOT_USERNAME', ''),
      defaultChatId: getEnv('TELEGRAM_DEFAULT_CHAT_ID', '') || null,
    };

    this.webhooks = {
      tradingviewBroadcast: {
        token: getEnv('WEBHOOK_TOKEN', ''),
        timeoutMs: getEnvInt('TRADINGVIEW_BROADCAST_TIMEOUT_MS', 3000),
        retries: getEnvInt('TRADINGVIEW_BROADCAST_RETRIES', 2),
        retryDelayMs: getEnvInt('TRADINGVIEW_BROADCAST_RETRY_DELAY_MS', 250),
        defaultRps: getEnvInt('TRADINGVIEW_BROADCAST_DEFAULT_RPS', 2),
        bufferPctDefault: getEnvFloat('TRADINGVIEW_BUFFER_PCT_DEFAULT', 0.5),
        bufferPctByStrategyRaw: getEnv('TRADINGVIEW_BUFFER_BY_STRATEGY', '{}'),
      },
    };
    this.webhooks.tradingviewBroadcast.bufferPctByStrategy = parseStrategyBufferConfig(
      this.webhooks.tradingviewBroadcast.bufferPctByStrategyRaw
    );
  }

  /**
   * Load configuration from database (async)
   * Call this after database connection is established
   */
  async loadFromDatabase() {
    try {
      const dbSettings = await settingsService.getAllSettings();

      // Apply database settings with fallback to current values
      this.env = await getSetting('server.node_env', this.env);
      this.isDev = this.env === 'development';
      this.isProd = this.env === 'production';
      this.isTest = this.env === 'test';

      this.port = await getSettingInt('server.port', this.port);
      this.baseUrl = await getSetting('server.base_url', this.baseUrl);

      this.database.path = await getSetting('database.path', this.database.path);
      this.session.secret = await getSetting('session.secret', this.session.secret);
      this.session.maxAge = await getSettingInt('session.max_age_ms', this.session.maxAge);
      settingsCacheDurationMs = await getSettingInt(
        'settings.cache_duration_ms',
        settingsCacheDurationMs
      );

      this.google.clientId = await getSetting('oauth.google.client_id', this.google.clientId);
      this.google.clientSecret = await getSetting('oauth.google.client_secret', this.google.clientSecret);
      this.google.callbackUrl = await getSetting('oauth.google.callback_url', this.google.callbackUrl);

      this.auth.googleClientId = this.google.clientId;
      this.auth.googleClientSecret = this.google.clientSecret;

      this.cors.origin = await getSetting('cors.origin', this.cors.origin);
      this.cors.credentials = await getSettingBool('cors.credentials', this.cors.credentials);

      this.testMode.enabled = await getSettingBool('test_mode.enabled', this.testMode.enabled);
      this.testMode.userEmail = await getSetting('test_mode.user_email', this.testMode.userEmail);

      this.polling.instanceInterval = await getSettingInt('polling.instance_interval_ms', this.polling.instanceInterval);
      this.polling.marketDataInterval = await getSettingInt('polling.market_data_interval_ms', this.polling.marketDataInterval);
      this.polling.healthCheckInterval = await getSettingInt('polling.health_check_interval_ms', this.polling.healthCheckInterval);
      this.marketDataFeed.quoteTtlMs = await getSettingInt('market_data_feed.quote_ttl_ms', this.marketDataFeed.quoteTtlMs);
      this.marketDataFeed.quoteTtlIdleMs = await getSettingInt('market_data_feed.quote_ttl_idle_ms', this.marketDataFeed.quoteTtlIdleMs);
      this.marketDataFeed.quoteTtlActiveMs = await getSettingInt('market_data_feed.quote_ttl_active_ms', this.marketDataFeed.quoteTtlActiveMs);
      this.marketDataFeed.positionTtlMs = await getSettingInt('market_data_feed.position_ttl_ms', this.marketDataFeed.positionTtlMs);
      this.marketDataFeed.positionIntervalIdleMs = await getSettingInt('market_data_feed.position_interval_idle_ms', this.marketDataFeed.positionIntervalIdleMs);
      this.marketDataFeed.positionIntervalActiveMs = await getSettingInt('market_data_feed.position_interval_active_ms', this.marketDataFeed.positionIntervalActiveMs);
      this.marketDataFeed.fundsTtlMs = await getSettingInt('market_data_feed.funds_ttl_ms', this.marketDataFeed.fundsTtlMs);
      this.marketDataFeed.fundsIntervalMs = await getSettingInt('market_data_feed.funds_interval_ms', this.marketDataFeed.fundsIntervalMs);
      this.marketDataFeed.orderbookTtlMs = await getSettingInt('market_data_feed.orderbook_ttl_ms', this.marketDataFeed.orderbookTtlMs);
      this.marketDataFeed.orderbookIntervalMs = await getSettingInt('market_data_feed.orderbook_interval_ms', this.marketDataFeed.orderbookIntervalMs);
      this.marketDataFeed.tradebookTtlMs = await getSettingInt('market_data_feed.tradebook_ttl_ms', this.marketDataFeed.tradebookTtlMs);
      this.marketDataFeed.tradebookIntervalIdleMs = await getSettingInt('market_data_feed.tradebook_interval_idle_ms', this.marketDataFeed.tradebookIntervalIdleMs);
      this.marketDataFeed.tradebookIntervalActiveMs = await getSettingInt('market_data_feed.tradebook_interval_active_ms', this.marketDataFeed.tradebookIntervalActiveMs);
      this.marketDataFeed.multiquoteCooldownIdleMs = await getSettingInt('market_data_feed.multiquote_cooldown_idle_ms', this.marketDataFeed.multiquoteCooldownIdleMs);
      this.marketDataFeed.multiquoteCooldownActiveMs = await getSettingInt('market_data_feed.multiquote_cooldown_active_ms', this.marketDataFeed.multiquoteCooldownActiveMs);
      this.marketDataFeed.orderQuoteStaleMs = await getSettingInt('market_data_feed.order_quote_stale_ms', this.marketDataFeed.orderQuoteStaleMs);
      this.marketDataFeed.maxOrderSpreadPct = await getSettingFloat('market_data_feed.max_order_spread_pct', this.marketDataFeed.maxOrderSpreadPct);

      this.instanceHealth.pingHealthyIntervalMs = await getSettingInt('instance_health.ping_healthy_interval_ms', this.instanceHealth.pingHealthyIntervalMs);
      this.instanceHealth.pingUnhealthyIntervalMs = await getSettingInt('instance_health.ping_unhealthy_interval_ms', this.instanceHealth.pingUnhealthyIntervalMs);
      this.instanceHealth.pingUnhealthyMaxAttempts = await getSettingInt('instance_health.ping_unhealthy_max_attempts', this.instanceHealth.pingUnhealthyMaxAttempts);
      this.instanceHealth.analyzerCheckIntervalMs = await getSettingInt('instance_health.analyzer_check_interval_ms', this.instanceHealth.analyzerCheckIntervalMs);

      this.marketHours.quoteBlackoutStart = await getSetting('market_hours.quote_blackout_start', this.marketHours.quoteBlackoutStart);
      this.marketHours.quoteBlackoutEnd = await getSetting('market_hours.quote_blackout_end', this.marketHours.quoteBlackoutEnd);
      this.marketHours.generalBlackoutStart = await getSetting('market_hours.general_blackout_start', this.marketHours.generalBlackoutStart);
      this.marketHours.generalBlackoutEnd = await getSetting('market_hours.general_blackout_end', this.marketHours.generalBlackoutEnd);
      this.autoExit.monitorIntervalMs = await getSettingInt('auto_exit.monitor_interval_ms', this.autoExit.monitorIntervalMs);
      this.autoExit.pendingExitCooldownMs = await getSettingInt('auto_exit.pending_cooldown_ms', this.autoExit.pendingExitCooldownMs);
      this.autoExit.provisionalEntryGraceMs = await getSettingInt('auto_exit.provisional_entry_grace_ms', this.autoExit.provisionalEntryGraceMs);
      this.autoExit.confirmationWindowMs = await getSettingInt('auto_exit.confirmation_window_ms', this.autoExit.confirmationWindowMs);

      this.openalgo.requestTimeout = await getSettingInt('openalgo.request_timeout_ms', this.openalgo.requestTimeout);
      this.openalgo.critical.maxRetries = await getSettingInt('openalgo.critical.max_retries', this.openalgo.critical.maxRetries);
      this.openalgo.critical.retryDelay = await getSettingInt('openalgo.critical.retry_delay_ms', this.openalgo.critical.retryDelay);
      this.openalgo.nonCritical.maxRetries = await getSettingInt('openalgo.non_critical.max_retries', this.openalgo.nonCritical.maxRetries);
      this.openalgo.nonCritical.retryDelay = await getSettingInt('openalgo.non_critical.retry_delay_ms', this.openalgo.nonCritical.retryDelay);

      this.logging.level = getSetting('logging.level', this.logging.level);
      this.logging.file = getSetting('logging.file', this.logging.file);

      this.rateLimit.windowMs = await getSettingInt('rate_limit.window_ms', this.rateLimit.windowMs);
      this.rateLimit.maxRequests = await getSettingInt('rate_limit.max_requests', this.rateLimit.maxRequests);

      this.webhooks.tradingviewBroadcast.token = getSetting(
        'webhooks.tradingview.token',
        this.webhooks.tradingviewBroadcast.token
      );
      const bufferDefault = await getSettingFloat(
        'webhooks.tradingview.buffer_pct_default',
        this.webhooks.tradingviewBroadcast.bufferPctDefault
      );
      this.webhooks.tradingviewBroadcast.bufferPctDefault = bufferDefault;
      const bufferByStrategyRaw = await getSetting(
        'webhooks.tradingview.buffer_pct_by_strategy',
        this.webhooks.tradingviewBroadcast.bufferPctByStrategyRaw
      );
      this.webhooks.tradingviewBroadcast.bufferPctByStrategyRaw = bufferByStrategyRaw;
      this.webhooks.tradingviewBroadcast.bufferPctByStrategy = parseStrategyBufferConfig(bufferByStrategyRaw);

      log.info('Configuration loaded from database');
    } catch (error) {
      log.warn('Failed to load configuration from database, using environment variables', error.message);
    }
  }
}

export const config = new Config();

export default config;
