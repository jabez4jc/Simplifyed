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
 * A setting belongs here only if changing it at runtime actually does something. Two classes
 * of key are deliberately excluded:
 *
 *   1. Boot-only values - read once during module load or startup, so editing them silently
 *      does nothing until a restart (cors.*, server.port, logging.*, database.path).
 *   2. Secrets - session.secret and JWT_SECRET come from the environment only. A database row
 *      that overrides an env secret is a security regression, not a feature.
 *
 * Internal timing and rate tuning is not a setting either: it is a fixed value in core/config.js.
 * A value lives in exactly one of the two places.
 *
 * Groups are ordered by how often an operator touches them, not by internal module structure.
 */

/**
 * @typedef {Object} SettingField
 * @property {string}  key       Matches application_settings.key
 * @property {string}  label     Human label. No jargon, no "_ms".
 * @property {string}  help      What it does, in plain words.
 * @property {string[]} details  When to raise or lower it, with an example. Shown under the help.
 * @property {string}  [unit]    'ms' | 'percent' | 'time' | 'currency' - drives input rendering.
 * @property {number}  [min]     Inclusive bound, enforced server-side.
 * @property {number}  [max]     Inclusive bound, enforced server-side.
 */

export const SETTINGS_GROUPS = [
  {
    id: 'orders-costs',
    label: 'Orders & Costs',
    description:
      'A safety check applied before an order is sent, and the costs used to show your P&L '
      + 'after brokerage.',
    sections: [
      {
        id: 'execution',
        label: 'Order Safety',
        fields: [
          {
            key: 'market_data_feed.max_order_spread_pct',
            label: 'Maximum bid/ask spread',
            help:
              'Before sending a new order, the app compares the best buy price (bid) and best sell '
              + 'price (ask). If the gap is wider than this percentage of the price, the order is '
              + 'refused instead of being sent.',
            details: [
              'Example at 2%: an option quoted 100 / 103 has a 3% gap and is refused; 100 / 101.50 '
                + 'has a 1.5% gap and is sent.',
              'Lower it to avoid overpaying in thin markets, such as far out-of-the-money options. '
                + 'More orders will be refused.',
              'Raise it if orders are refused on contracts you know trade actively.',
              'Exits are never blocked by this check - a position can always be closed.',
            ],
            unit: 'percent', min: 0.001, max: 1,
          },
        ],
      },
      {
        id: 'brokerage',
        label: 'Brokerage',
        note:
          'Used only to show net P&L. Changing these does not change what your broker charges. '
          + 'The app adds 18% GST and exchange, SEBI and stamp charges on top by itself.',
        fields: [
          {
            key: 'brokerage.default',
            label: 'Default brokerage per order',
            help:
              'The brokerage charged on each executed order, for any broker not listed under '
              + 'Per-broker rates. A buy and its sell count as two orders.',
            details: ['Most discount brokers charge ₹20 per executed order. Use 0 for a zero-brokerage plan.'],
            unit: 'currency', min: 0, max: 10000,
          },
          {
            key: 'brokerage.by_broker',
            label: 'Per-broker rates',
            help: 'Brokerage per executed order for a specific broker. It replaces the default above for that broker.',
            details: ['Leave a broker out to use the default. Enter 0 for a zero-brokerage plan.'],
            editor: 'broker-map',
          },
          {
            key: 'brokerage.market_order_support',
            label: 'Market orders (crypto only)',
            help:
              'Whether an order with no price may be sent as a MARKET order. Only crypto brokers '
              + 'can use this; they are on unless switched off here.',
            details: [
              'On: a crypto order without a price fills at the best available price straight away.',
              'Off: it is sent as a LIMIT order priced from the order book.',
              'Indian exchanges (NSE, BSE, NFO, BFO, MCX, CDS) always get LIMIT orders, as SEBI '
                + 'requires for algo orders. This switch cannot change that.',
            ],
            editor: 'broker-flags',
          },
        ],
      },
    ],
  },

  {
    id: 'trading-hours',
    label: 'Trading Hours',
    description: 'How the trading day is divided for session P&L and loss limits.',
    sections: [
      {
        id: 'sessions',
        label: 'Trading Sessions',
        fields: [
          {
            key: 'trading_sessions',
            label: 'Session windows',
            help:
              'The parts of the day (IST, 24-hour HH:MM) over which each instance\'s session P&L, '
              + 'session target and session max loss are measured.',
            details: [
              'Session P&L starts again from zero at the start of each window.',
              'Reaching the session target or the session max loss switches that instance to '
                + 'analyzer mode.',
              'After a max-loss stop it goes back to live when the next window starts. After '
                + 'reaching the target it stays in analyzer mode until you switch it back.',
              'Outside every window, session limits are not checked.',
            ],
            editor: 'sessions',
          },
        ],
      },
    ],
  },

  {
    id: 'broker-connection',
    label: 'Broker Connection',
    description: 'Limits on how the app talks to your OpenAlgo instances. Each applies to every instance separately.',
    sections: [
      {
        id: 'broker-limits',
        label: 'Limits',
        fields: [
          {
            key: 'rate_limits.smart_orders_per_second',
            label: 'Orders per second',
            help:
              'The most orders the app sends to one instance in a second. Extra orders wait their '
              + 'turn - none are dropped.',
            details: [
              'OpenAlgo accepts 2 orders per second unless its server is set higher. Setting this '
                + 'above your OpenAlgo limit gets orders rejected.',
              'A higher value finishes multi-leg strategies, Close All and the kill switch sooner.',
              'SEBI requires an algo that sends more than 10 orders per second to be registered, '
                + 'so the maximum here is 10.',
            ],
            min: 1, max: 10,
          },
          {
            key: 'openalgo.request_timeout_ms',
            label: 'Broker response timeout',
            help: 'How long the app waits for an OpenAlgo instance to answer before treating the call as failed.',
            details: [
              'Raise it if you see timeouts at the market open, when brokers are slowest.',
              'Lower it to notice an unreachable instance sooner. Too low, and slow but working '
                + 'calls fail.',
              'A timed-out order is retried safely: the app\'s orders set a target position, so a '
                + 'retry cannot double it.',
            ],
            unit: 'ms', min: 3000, max: 60000,
          },
        ],
      },
    ],
  },
];

/**
 * Every runtime-editable setting and its default. The database row is the only value the app
 * uses; this list seeds a missing row and is what the Settings screen shows as "Default".
 * Everything that is not a setting is a fixed value in core/config.js - never both.
 */
export const ESSENTIAL_SETTINGS = [
  {
    key: 'openalgo.request_timeout_ms',
    value: '15000',
    description: 'How long to wait for an OpenAlgo instance before a call fails (ms).',
    category: 'openalgo',
    dataType: 'number',
  },
  {
    key: 'rate_limits.smart_orders_per_second',
    value: '2',
    description: 'Most orders per second sent to one instance.',
    category: 'rate_limits',
    dataType: 'number',
  },
  {
    key: 'market_data_feed.max_order_spread_pct',
    value: '0.1',
    description: 'Largest bid/ask gap, as a fraction of price (0.1 = 10%), at which a new order is still sent.',
    category: 'market_data_feed',
    dataType: 'number',
  },
  {
    key: 'brokerage.default',
    value: '20',
    description: 'Brokerage per executed order for brokers without a specific rate.',
    category: 'brokerage',
    dataType: 'number',
  },
  {
    key: 'brokerage.by_broker',
    value: JSON.stringify({
      fivepaisa: 20,
      fivepaisax: 20,
      aliceblue: 20,
      angel: 20,
      compositedge: 25,
      dhan: 20,
      dhan_sandbox: 20,
      firstock: 20,
      flattrade: 0,
      fyers: 20,
      groww: 20,
      ibulls: 11,
      iifl: 20,
      indmoney: 20,
      kotak: 10,
      paytm: 20,
      pocketful: 20,
      shoonya: 5,
      tradejini: 20,
      upstox: 20,
      wisdom: 20,
      zebu: 20,
      zerodha: 20,
    }),
    description: 'Brokerage per trade mapped by broker key (lowercase).',
    category: 'brokerage',
    dataType: 'json',
  },
  {
    key: 'brokerage.market_order_support',
    value: JSON.stringify({}),
    description: 'Market order support mapped by broker key (lowercase).',
    category: 'brokerage',
    dataType: 'json',
  },
  {
    key: 'trading_sessions',
    value: JSON.stringify([
      { label: 'Session 1', start: '09:00', end: '11:30' },
      { label: 'Session 2', start: '12:30', end: '15:10' },
      { label: 'Session 3', start: '15:45', end: '19:00' },
      { label: 'Session 4', start: '20:30', end: '22:45' },
    ]),
    description: 'Session windows in IST used for session P&L baselines and auto cutoffs.',
    category: 'trading',
    dataType: 'json',
  },
];

export function settingDefault(key) {
  return ESSENTIAL_SETTINGS.find((setting) => setting.key === key)?.value;
}

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


/**
 * Range check for a value about to be written. Type coercion stays in settings.service; this
 * only enforces the bounds declared above, so a typo can't set a 5ms poll interval that
 * hammers a broker into a rate-limit ban.
 * @returns {string|null} error message, or null when acceptable
 */
export function validateValue(key, value) {
  const field = SETTINGS_FIELDS.get(key);
  if (!field) return `'${key}' is not a runtime-editable setting`;

  if (field.editor === 'sessions') {
    let sessions = value;
    if (typeof sessions === 'string') {
      try { sessions = JSON.parse(sessions); } catch { return `'${key}' must be a list of sessions`; }
    }
    if (!Array.isArray(sessions)) return `'${key}' must be a list of sessions`;
    const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
    for (const s of sessions) {
      if (!s || !hhmm.test(s.start) || !hhmm.test(s.end)) {
        return `'${key}': every session needs a start and an end as 24-hour HH:MM times`;
      }
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
