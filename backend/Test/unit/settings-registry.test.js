import assert from 'assert';
import test from 'node:test';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import {
  SETTINGS_GROUPS,
  SETTINGS_FIELDS,
  isEditable,
  validateValue,
  ESSENTIAL_SETTINGS,
  settingDefault,
} from '../../src/config/settings-registry.js';

// The registry is the allowlist the API enforces. These keys can disable authentication,
// remove broker rate-limit protection, or override an env secret - a regression that lets any
// of them back into the editable set is the kind that only surfaces after someone clicks it.
const MUST_NOT_BE_EDITABLE = [
  'test_mode.enabled',
  'test_mode.user_email',
  'session.secret',
  'session.max_age_ms',
  'rate_limits.disabled',
  'rate_limits.circuit_breaker_disabled',
  // Fixed tuning in core/config.js - a Settings row for these would be a second source.
  'rate_limits.rps_per_instance',
  'market_data_feed.quote_ttl_idle_ms',
  'instance_health.ping_healthy_interval_ms',
  'openalgo.critical.max_retries',
  'server.port',
  'server.node_env',
  'database.path',
  'cors.origin',
  'cors.credentials',
  'logging.level',
  'logging.file',
  'oauth.google.client_id',
  'oauth.google.client_secret',
];

test('settings that disable auth, safety limits, or come from env are not editable', () => {
  for (const key of MUST_NOT_BE_EDITABLE) {
    assert.strictEqual(isEditable(key), false, `${key} must never be runtime-editable`);
    assert.ok(validateValue(key, 'anything'), `${key} must fail validation`);
  }
});

test('the settings an operator actually needs are editable, and each has one default', () => {
  const editable = [
    'market_data_feed.max_order_spread_pct',
    'brokerage.default',
    'brokerage.by_broker',
    'brokerage.market_order_support',
    'trading_sessions',
    'openalgo.request_timeout_ms',
    'rate_limits.smart_orders_per_second',
    'futures.roll_days_before_expiry',
  ];
  assert.deepStrictEqual([...SETTINGS_FIELDS.keys()].sort(), [...editable].sort());
  for (const key of editable) {
    assert.ok(settingDefault(key) !== undefined, `${key} needs a default in ESSENTIAL_SETTINGS`);
  }
  assert.deepStrictEqual(ESSENTIAL_SETTINGS.map((s) => s.key).sort(), [...editable].sort(),
    'a default for something that is not a setting would be a second source');
});

test('numeric bounds reject values that would hammer a broker', () => {
  assert.ok(validateValue('rate_limits.smart_orders_per_second', 0));
  assert.ok(validateValue('rate_limits.smart_orders_per_second', 11), 'above SEBI\'s 10/s algo threshold');
  assert.strictEqual(validateValue('rate_limits.smart_orders_per_second', 2), null);
  assert.ok(validateValue('openalgo.request_timeout_ms', 100));
});

test('every field is well-formed and uniquely keyed', () => {
  let counted = 0;
  for (const group of SETTINGS_GROUPS) {
    assert.ok(group.id && group.label, 'group needs id and label');
    for (const section of group.sections) {
      assert.ok(section.id && section.label, `section in ${group.id} needs id and label`);
      for (const field of section.fields) {
        counted += 1;
        assert.ok(field.key, 'field needs a key');
        assert.ok(field.label, `${field.key} needs a label`);
        assert.ok(field.help, `${field.key} needs help text - it is what makes it usable`);
        assert.ok(field.details?.length, `${field.key} needs details: when to raise or lower it`);
        if (field.min !== undefined && field.max !== undefined) {
          assert.ok(field.min < field.max, `${field.key} has an inverted range`);
        }
      }
    }
  }
  // The flat map throws on duplicate keys at import, so equal counts prove uniqueness too.
  assert.strictEqual(counted, SETTINGS_FIELDS.size);
});

test('paired fields come in complete, labelled pairs', () => {
  for (const group of SETTINGS_GROUPS) {
    for (const section of group.sections) {
      const pairs = new Map();
      for (const f of section.fields.filter((x) => x.pair)) {
        if (!pairs.has(f.pair)) pairs.set(f.pair, []);
        pairs.get(f.pair).push(f);
      }
      for (const [pairId, fields] of pairs) {
        assert.strictEqual(fields.length, 2, `pair '${pairId}' must have exactly 2 fields`);
        for (const f of fields) {
          assert.ok(f.pairLabel, `${f.key} is paired and needs a pairLabel to disambiguate it`);
        }
      }
    }
  }
});

// P3-4: the JSON editors are shape-checked on the server, not just by the UI.
test('trading sessions must start before they end and must not overlap', () => {
  const s = (...list) => JSON.stringify(list.map(([start, end]) => ({ start, end })));
  assert.strictEqual(validateValue('trading_sessions', s(['09:00', '11:30'], ['11:30', '15:10'])), null, 'touching is not overlapping');
  assert.match(validateValue('trading_sessions', s(['11:30', '09:00'])), /before it ends/);
  assert.match(validateValue('trading_sessions', s(['09:00', '09:00'])), /before it ends/);
  assert.match(validateValue('trading_sessions', s(['12:00', '15:00'], ['09:00', '12:30'])), /overlap/, 'order does not hide an overlap');
});

test('broker rate and flag maps need the right shape', () => {
  const rates = (v) => validateValue('brokerage.by_broker', JSON.stringify(v));
  assert.strictEqual(rates({ zerodha: 20, kotak: 0 }), null);
  assert.match(rates({ zerodha: -1 }), /0 or more/);
  assert.match(rates({ zerodha: '20' }), /number/);
  assert.match(rates({ Zerodha: 20 }), /not a broker key/);
  assert.match(rates([20]), /map of broker/);

  const flags = (v) => validateValue('brokerage.market_order_support', JSON.stringify(v));
  assert.strictEqual(flags({}), null);
  assert.strictEqual(flags({ deltaexchange: false }), null);
  assert.match(flags({ deltaexchange: 'no' }), /true or false/);
  assert.match(flags({ zerodha: true }), /not a crypto broker/, 'an Indian broker can never take MARKET (SEBI)');
});

test('no unfiltered SELECT on application_settings in src (it holds the webhook token)', () => {
  const hits = [];
  const walk = (dir) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!p.endsWith('.js')) continue;
      const src = readFileSync(p, 'utf8');
      for (const m of src.matchAll(/SELECT[^`'"]*?FROM application_settings([^`'"]*)/g)) {
        if (!/WHERE/i.test(m[1])) hits.push(`${p}: ${m[0].slice(0, 80)}`);
      }
    }
  };
  walk(new URL('../../src', import.meta.url).pathname);
  assert.deepStrictEqual(hits, []);
});
