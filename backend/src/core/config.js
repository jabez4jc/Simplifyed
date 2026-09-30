/**
 * Configuration Management
 *
 * Each value has exactly one source:
 *   - the environment, for deployment facts and secrets (port, JWT secret, tokens);
 *   - a fixed value below, for internal timing and rate tuning;
 *   - a Settings row (settings.service ESSENTIAL_SETTINGS), for the few values an operator
 *     edits - read by loadFromDatabase().
 * The timing values were once all three at once (env default, Settings > Advanced row, and a
 * hardcoded fallback), and the screen showed values the app was not using.
 */

import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import settingsService from '../services/settings.service.js';
import { settingDefault } from '../config/settings-registry.js';
import { log } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
loadEnv({ path: join(__dirname, '../../.env') });

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
 * Get environment variable with validation (legacy support)
 */
function getEnv(key, defaultValue = undefined, required = false) {
  const raw = process.env[key];

  // Check the raw env var, not raw||defaultValue - a defaultValue would otherwise make
  // `required` a no-op (e.g. JWT_SECRET silently falling back to a
  // hardcoded, publicly-known dev default instead of failing startup).
  if (required && !raw) {
    throw new Error(`Missing required environment variable: ${key}`);
  }

  return raw || defaultValue;
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
    // A label for logs and the startup banner - NOT a behaviour switch. Everything that used
    // to branch on it now derives from the thing it actually cares about: cookie security from
    // the BASE_URL scheme, the instruments bypass from ENABLE_TEST_MODE. The value defaults to
    // 'development', so anything gated on it fails open, which is the wrong direction for a
    // trading system.
    // The removed isDev/isProd/isTest companions had no consumers anywhere in the codebase.
    this.env = getEnv('NODE_ENV', 'development');

    this.port = getEnvInt('PORT', 3000);
    this.baseUrl = getEnv('BASE_URL', 'http://localhost:3000');

    // DATABASE_PATH is read by core/database.js and core/logger.js at connect time, not here.

    this.auth = {
      // The single switch that disables authentication. There were previously two independent
      // env vars for this (ENABLE_TEST_MODE and TEST_MODE) feeding three separate checks in
      // optionalAuth - so disabling auth had three ways to happen and one way to audit.
      // Read it through isTestMode() (exported below), never directly.
      enableTestMode: getEnvBool('ENABLE_TEST_MODE', false),
      jwtSecret: getEnv('JWT_SECRET', undefined, true),
    };

    this.cors = {
      origin: getEnv('CORS_ORIGIN', 'http://localhost:3000'),
    };

    // Fixed tuning (ms). Set to the values the app was actually running with on 2026-09-30.
    this.polling = {
      instanceInterval: 15000,
      marketDataInterval: 10000,
      healthCheckInterval: 60000,
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

    // "Idle" applies when no position is open, "active" while one is.
    this.marketDataFeed = {
      quoteTtlIdleMs: 12000,
      quoteTtlActiveMs: 7000,
      positionIntervalIdleMs: 20000,
      positionIntervalActiveMs: 8000,
      fundsIntervalMs: 180000,
      orderbookIntervalMs: 20000,
      tradebookIntervalIdleMs: 20000,
      tradebookIntervalActiveMs: 8000,
      multiquoteCooldownIdleMs: 15000,
      multiquoteCooldownActiveMs: 9000,
      orderQuoteStaleMs: 2000,
    };

    this.instanceHealth = {
      pingHealthyIntervalMs: 300000,
      pingUnhealthyIntervalMs: 180000, // first retry; doubles per failure up to 10 minutes
      analyzerCheckIntervalMs: 15000,
    };

    this.openalgo = {
      // Settings > Broker connection. Seeded with the default until loadFromDatabase() runs.
      requestTimeout: Number(settingDefault('openalgo.request_timeout_ms')),
      critical: { maxRetries: 3, retryDelay: 500 },    // orders and exits
      nonCritical: { maxRetries: 1, retryDelay: 2000 }, // quotes, books, everything else
    };

    // LOG_LEVEL / ENABLE_DEBUG_LOGS are read by core/logger.js at import.

    this.telegram = {
      botToken: getEnv('TELEGRAM_BOT_TOKEN', ''),
      botUsername: getEnv('TELEGRAM_BOT_USERNAME', ''),
      defaultChatId: getEnv('TELEGRAM_DEFAULT_CHAT_ID', '') || null,
      // Optional - if set, the webhook route requires Telegram's X-Telegram-Bot-Api-Secret-Token
      // header to match. Must also be passed as `secret_token` when calling Telegram's
      // setWebhook API, or Telegram won't send the header at all. Left optional (rather than
      // required) so existing bot setups that registered their webhook without a secret_token
      // keep working until the operator rotates it.
      webhookSecret: getEnv('TELEGRAM_WEBHOOK_SECRET', ''),
    };

    this.webhooks = {
      tradingviewBroadcast: {
        token: getEnv('WEBHOOK_TOKEN', ''),
        timeoutMs: getEnvInt('TRADINGVIEW_BROADCAST_TIMEOUT_MS', 3000),
        retries: getEnvInt('TRADINGVIEW_BROADCAST_RETRIES', 2),
        retryDelayMs: getEnvInt('TRADINGVIEW_BROADCAST_RETRY_DELAY_MS', 250),
        defaultRps: getEnvInt('TRADINGVIEW_BROADCAST_DEFAULT_RPS', 2),
        bufferPctDefault: getEnvFloat('TRADINGVIEW_BUFFER_PCT_DEFAULT', 0.5),
        bufferPctByStrategy: parseStrategyBufferConfig(getEnv('TRADINGVIEW_BUFFER_BY_STRATEGY', '{}')),
      },
    };
  }

  /**
   * Read the Settings rows config holds. Called at startup and again whenever one changes.
   * (The spread guard, brokerage and sessions are read from their rows at the point of use.)
   */
  async loadFromDatabase() {
    try {
      const timeout = Number(await settingsService.getRawValue('openalgo.request_timeout_ms'));
      if (Number.isFinite(timeout) && timeout > 0) this.openalgo.requestTimeout = timeout;

      // A rotated token is stored as a sensitive setting, which getSetting() returns masked -
      // loading that made every TradingView alert 401 after a restart. Read it unmasked.
      this.webhooks.tradingviewBroadcast.token =
        (await settingsService.getRawValue('webhooks.tradingview.token'))
        || this.webhooks.tradingviewBroadcast.token;

      log.info('Configuration loaded from database');
    } catch (error) {
      log.warn('Failed to load configuration from database', error.message);
    }
  }
}

/**
 * The one place that decides whether authentication is disabled.
 *
 * optionalAuth previously OR'd three conditions fed by two different environment variables
 * (ENABLE_TEST_MODE and TEST_MODE), so an auth bypass had three independent triggers and no
 * single place to audit. Lives here rather than in middleware because services need it too, and
 * a service importing from middleware is the wrong direction.
 *
 * Environment-only by design: a database row must never be able to switch off authentication.
 */
export function isTestMode() {
  return config.auth.enableTestMode === true || process.env.ENABLE_TEST_MODE === 'true';
}

export const config = new Config();

export default config;
