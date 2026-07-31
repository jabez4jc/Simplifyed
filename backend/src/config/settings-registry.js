/**
 * Settings Registry
 *
 * The single source of truth for which application settings may be changed at runtime, how they
 * are grouped, and how they are presented. Both the API and the Settings UI read from here:
 *
 *   - settings.service.updateSetting() refuses any key absent from this registry, so the
 *     allowlist is a real control rather than a cosmetic filter. (It previously lived only in
 *     the frontend, which meant anyone with `settings.manage` could still PUT any key in the
 *     table - including `test_mode.enabled`, which disables authentication process-wide.)
 *   - GET /api/v1/settings/schema serves this to the UI, so adding a setting here is the only
 *     step needed to surface it. No parallel list to keep in sync.
 *
 * A setting belongs here only if changing it at runtime actually does something. Three classes
 * of key are deliberately excluded:
 *
 *   1. Boot-only values - read once during module load or startup, so editing them silently
 *      does nothing until a restart (cors.*, server.port, logging.*, database.path).
 *   2. Secrets - session.secret and JWT_SECRET come from the environment only. A database row
 *      that overrides an env secret is a security regression, not a feature.
 *   3. Debug kill-switches - rate_limits.disabled and rate_limits.circuit_breaker_disabled turn
 *      off protections against overwhelming a live broker. They remain readable and functional
 *      for a developer who edits the row directly; they are not one mis-click away in a UI.
 *
 * Groups are ordered by how often an operator touches them, not by internal module structure.
 */

/**
 * @typedef {Object} SettingField
 * @property {string}  key       Matches application_settings.key
 * @property {string}  label     Human label. No jargon, no "_ms".
 * @property {string}  help      One sentence: what it does and what happens if you change it.
 * @property {string}  [unit]    'ms' | 'percent' | 'time' | 'currency' - drives input rendering.
 * @property {number}  [min]     Inclusive bound, enforced server-side.
 * @property {number}  [max]     Inclusive bound, enforced server-side.
 * @property {string}  [pair]    Fields sharing a pair id render side by side (idle vs active).
 * @property {boolean} [advanced] Hidden behind "Show advanced" - correct default, rarely touched.
 */

export const SETTINGS_GROUPS = [
  {
    id: 'market-data',
    label: 'Market Data',
    description:
      'How often the terminal pulls fresh data from your brokers. Lower values mean fresher '
      + 'numbers and more API calls; every broker enforces its own rate limits, so raising the '
      + 'frequency past what Broker Connection allows will simply queue requests.',
    sections: [
      {
        id: 'quotes',
        label: 'Quotes',
        note:
          'Two values per row: the first applies when you hold no open positions, the second '
          + 'when you do. The terminal switches automatically.',
        fields: [
          {
            key: 'market_data_feed.quote_ttl_idle_ms',
            label: 'Quote cache lifetime',
            help: 'How long a fetched price stays usable before it is refetched.',
            unit: 'ms', min: 1000, max: 120000, pair: 'quote-ttl', pairLabel: 'No positions',
          },
          {
            key: 'market_data_feed.quote_ttl_active_ms',
            label: 'Quote cache lifetime',
            help: 'Same, while you hold open positions. Usually shorter.',
            unit: 'ms', min: 1000, max: 120000, pair: 'quote-ttl', pairLabel: 'Holding positions',
          },
          {
            key: 'market_data_feed.multiquote_cooldown_idle_ms',
            label: 'Minimum gap between batch quote calls',
            help: 'Floor between MultiQuotes requests. Raise it if a broker rate-limits you.',
            unit: 'ms', min: 1000, max: 120000, pair: 'multiquote', pairLabel: 'No positions',
          },
          {
            key: 'market_data_feed.multiquote_cooldown_active_ms',
            label: 'Minimum gap between batch quote calls',
            help: 'Same, while you hold open positions.',
            unit: 'ms', min: 1000, max: 120000, pair: 'multiquote', pairLabel: 'Holding positions',
          },
        ],
      },
      {
        id: 'positions',
        label: 'Positions & Trades',
        fields: [
          {
            key: 'market_data_feed.position_interval_idle_ms',
            label: 'Position refresh',
            help: 'How often the position book is re-read from the broker.',
            unit: 'ms', min: 2000, max: 300000, pair: 'position', pairLabel: 'No positions',
          },
          {
            key: 'market_data_feed.position_interval_active_ms',
            label: 'Position refresh',
            help: 'Same, while you hold open positions.',
            unit: 'ms', min: 2000, max: 300000, pair: 'position', pairLabel: 'Holding positions',
          },
          {
            key: 'market_data_feed.tradebook_interval_idle_ms',
            label: 'Trade book refresh',
            help: 'How often filled trades are re-read. Drives realised P&L.',
            unit: 'ms', min: 2000, max: 300000, pair: 'tradebook', pairLabel: 'No positions',
          },
          {
            key: 'market_data_feed.tradebook_interval_active_ms',
            label: 'Trade book refresh',
            help: 'Same, while you hold open positions.',
            unit: 'ms', min: 2000, max: 300000, pair: 'tradebook', pairLabel: 'Holding positions',
          },
          {
            key: 'market_data_feed.orderbook_interval_ms',
            label: 'Order book refresh',
            help: 'How often pending and completed orders are re-read.',
            unit: 'ms', min: 2000, max: 300000,
          },
        ],
      },
      {
        id: 'account',
        label: 'Account',
        fields: [
          {
            key: 'market_data_feed.funds_interval_ms',
            label: 'Balance refresh',
            help: 'How often available margin is re-read. Rarely needs to be frequent.',
            unit: 'ms', min: 10000, max: 900000,
          },
          {
            key: 'polling.instance_interval_ms',
            label: 'Instance P&L refresh',
            help: 'How often per-instance P&L totals on the dashboard are recalculated.',
            unit: 'ms', min: 5000, max: 300000,
          },
          {
            key: 'polling.market_data_interval_ms',
            label: 'Background feed tick',
            help: 'Base cadence of the shared market-data loop that serves every open session.',
            unit: 'ms', min: 1000, max: 60000, advanced: true,
          },
        ],
      },
    ],
  },

  {
    id: 'trading-hours',
    label: 'Trading Hours',
    description:
      'When the terminal is allowed to call your brokers, and how the trading day is divided '
      + 'for P&L. Crypto brokers trade 24/7 and are exempt from the blackout windows below.',
    sections: [
      {
        id: 'blackout',
        label: 'Blackout Windows (IST)',
        note:
          'Broker calls are paused inside these windows - useful overnight, when Indian '
          + 'exchanges are closed and brokers expire sessions. Set start and end to the same '
          + 'value to disable a window.',
        fields: [
          {
            key: 'market_hours.quote_blackout_start',
            label: 'Pause quotes from',
            help: 'Quotes, MultiQuotes and OptionChain stop being requested at this time.',
            unit: 'time', pair: 'quote-blackout', pairLabel: 'From',
          },
          {
            key: 'market_hours.quote_blackout_end',
            label: 'Resume quotes at',
            help: 'Quote endpoints become available again at this time.',
            unit: 'time', pair: 'quote-blackout', pairLabel: 'Until',
          },
          {
            key: 'market_hours.general_blackout_start',
            label: 'Pause all other calls from',
            help: 'Orders, positions, funds and the rest pause at this time.',
            unit: 'time', pair: 'general-blackout', pairLabel: 'From',
          },
          {
            key: 'market_hours.general_blackout_end',
            label: 'Resume all other calls at',
            help: 'Everything resumes at this time.',
            unit: 'time', pair: 'general-blackout', pairLabel: 'Until',
          },
        ],
      },
      {
        id: 'sessions',
        label: 'Trading Sessions',
        fields: [
          {
            key: 'trading_sessions',
            label: 'Session windows',
            help:
              'Windows used as P&L baselines and auto-exit cutoffs. Each entry needs a label, '
              + 'a start and an end in IST.',
            editor: 'sessions',
          },
        ],
      },
    ],
  },

  {
    id: 'broker-connection',
    label: 'Broker Connection',
    description:
      'Timeouts, retries and request ceilings for calls to your OpenAlgo instances. These exist '
      + 'to stay inside broker limits - raising them past what your broker permits gets requests '
      + 'rejected, not served faster.',
    sections: [
      {
        id: 'limits',
        label: 'Request Limits',
        note: 'Applied per instance. Match these to your broker\'s published rate limits.',
        fields: [
          {
            key: 'rate_limits.rps_per_instance',
            label: 'Requests per second',
            help: 'Ceiling on calls per second to a single instance.',
            min: 1, max: 100,
          },
          {
            key: 'rate_limits.rpm_per_instance',
            label: 'Requests per minute',
            help: 'Ceiling on calls per minute to a single instance.',
            min: 10, max: 6000,
          },
          {
            key: 'rate_limits.orders_per_second',
            label: 'Orders per second (placeorder)',
            help: 'Ceiling for the plain order-placement endpoint. Not currently exercised - '
              + 'every order this app sends goes through the stricter smart-order endpoint below.',
            min: 1, max: 100,
            advanced: true,
          },
          {
            key: 'rate_limits.smart_orders_per_second',
            label: 'Orders per second (smart order)',
            help: 'Ceiling on placesmartorder calls, the endpoint every order in this app '
              + 'actually uses. OpenAlgo caps this stricter than plain order placement - '
              + 'raise it only if your broker plugin is confirmed to allow more.',
            min: 1, max: 100,
          },
          {
            key: 'rate_limits.max_concurrent_tasks',
            label: 'Concurrent requests',
            help: 'How many broker calls may be in flight at once across all instances.',
            min: 1, max: 100, advanced: true,
          },
        ],
      },
      {
        id: 'retries',
        label: 'Timeouts & Retries',
        note:
          'Order placement and exits count as critical; quotes and book refreshes do not. '
          + 'Critical calls retry harder because a dropped exit is worse than a stale price.',
        fields: [
          {
            key: 'openalgo.request_timeout_ms',
            label: 'Request timeout',
            help: 'How long to wait for an instance before giving up on a call.',
            unit: 'ms', min: 1000, max: 60000,
          },
          {
            key: 'openalgo.critical.max_retries',
            label: 'Retries — critical calls',
            help: 'Retry attempts for order placement and exits.',
            min: 0, max: 10, pair: 'critical', pairLabel: 'Attempts',
          },
          {
            key: 'openalgo.critical.retry_delay_ms',
            label: 'Retry delay — critical calls',
            help: 'Wait between those retries.',
            unit: 'ms', min: 100, max: 30000, pair: 'critical', pairLabel: 'Delay',
          },
          {
            key: 'openalgo.non_critical.max_retries',
            label: 'Retries — everything else',
            help: 'Retry attempts for quotes, books and other non-order calls.',
            min: 0, max: 10, pair: 'non-critical', pairLabel: 'Attempts', advanced: true,
          },
          {
            key: 'openalgo.non_critical.retry_delay_ms',
            label: 'Retry delay — everything else',
            help: 'Wait between those retries.',
            unit: 'ms', min: 100, max: 30000, pair: 'non-critical', pairLabel: 'Delay', advanced: true,
          },
        ],
      },
      {
        id: 'health',
        label: 'Health Checks',
        fields: [
          {
            key: 'instance_health.ping_healthy_interval_ms',
            label: 'Check healthy instances every',
            help: 'How often a known-good instance is re-checked.',
            unit: 'ms', min: 30000, max: 3600000,
          },
          {
            key: 'instance_health.ping_unhealthy_interval_ms',
            label: 'Retry unhealthy instances every',
            help: 'How often an instance that failed its last check is retried.',
            unit: 'ms', min: 30000, max: 3600000,
          },
          {
            key: 'instance_health.ping_unhealthy_max_attempts',
            label: 'Give up after',
            help:
              'Consecutive failures before the terminal stops auto-retrying and waits for a '
              + 'manual refresh.',
            unit: 'attempts', min: 1, max: 50,
          },
          {
            key: 'instance_health.analyzer_check_interval_ms',
            label: 'Analyzer-mode check every',
            help: 'How often the terminal re-reads whether an instance is in analyzer mode.',
            unit: 'ms', min: 5000, max: 600000, advanced: true,
          },
        ],
      },
    ],
  },

  {
    id: 'orders-costs',
    label: 'Orders & Costs',
    description:
      'Guardrails applied when placing orders, and the brokerage assumptions used to turn raw '
      + 'fills into net P&L.',
    sections: [
      {
        id: 'execution',
        label: 'Execution Guardrails',
        fields: [
          {
            key: 'market_data_feed.max_order_spread_pct',
            label: 'Maximum bid/ask spread',
            help:
              'Orders are held back when the spread is wider than this, as a share of price '
              + '(0.01 = 1%). Protects against filling into an illiquid book.',
            unit: 'percent', min: 0, max: 1,
          },
        ],
      },
      {
        id: 'brokerage',
        label: 'Brokerage',
        note: 'Used for net P&L only. It does not change what your broker actually charges.',
        fields: [
          {
            key: 'brokerage.default',
            label: 'Default brokerage per trade',
            help: 'Applied to any broker without a specific rate below.',
            unit: 'currency', min: 0, max: 10000,
          },
          {
            key: 'brokerage.by_broker',
            label: 'Per-broker rates',
            help: 'Overrides the default for named brokers.',
            editor: 'broker-map',
          },
          {
            key: 'brokerage.market_order_support',
            label: 'Market order support',
            help:
              'Which brokers accept market orders. Those that do not are sent a limit order '
              + 'priced at the touch instead.',
            editor: 'broker-flags',
          },
        ],
      },
    ],
  },
];

/** Flat key -> field lookup, with group/section attached. Built once at import. */
export const SETTINGS_FIELDS = new Map();
for (const group of SETTINGS_GROUPS) {
  for (const section of group.sections) {
    for (const field of section.fields) {
      if (SETTINGS_FIELDS.has(field.key)) {
        throw new Error(`Duplicate setting key in registry: ${field.key}`);
      }
      SETTINGS_FIELDS.set(field.key, {
        ...field,
        groupId: group.id,
        groupLabel: group.label,
        sectionId: section.id,
        sectionLabel: section.label,
      });
    }
  }
}

export function isEditable(key) {
  return SETTINGS_FIELDS.has(key);
}

export function getField(key) {
  return SETTINGS_FIELDS.get(key) || null;
}

/**
 * Range check for a value about to be written. Type coercion stays in settings.service; this
 * only enforces the bounds declared above, so a typo can't set a 5ms poll interval that
 * hammers a broker into a rate-limit ban.
 * @returns {string|null} error message, or null when acceptable
 */
export function validateValue(key, value) {
  const field = SETTINGS_FIELDS.get(key);
  if (!field) return `'${key}' is not a runtime-editable setting`;

  if (field.unit === 'time') {
    if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
      return `'${key}' must be a 24-hour time in HH:MM format`;
    }
    return null;
  }

  if (field.min !== undefined || field.max !== undefined) {
    const num = Number(value);
    if (!Number.isFinite(num)) return `'${key}' must be a number`;
    if (field.min !== undefined && num < field.min) {
      return `'${key}' must be at least ${field.min}`;
    }
    if (field.max !== undefined && num > field.max) {
      return `'${key}' must be at most ${field.max}`;
    }
  }

  return null;
}

export default { SETTINGS_GROUPS, SETTINGS_FIELDS, isEditable, getField, validateValue };
