import assert from 'assert';
import test from 'node:test';
import {
  SETTINGS_GROUPS,
  SETTINGS_FIELDS,
  isEditable,
  validateValue,
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

test('the trading knobs an operator actually needs are editable', () => {
  for (const key of [
    'market_data_feed.quote_ttl_idle_ms',
    'market_data_feed.position_interval_active_ms',
    'market_data_feed.max_order_spread_pct',
    'market_hours.quote_blackout_start',
    'rate_limits.rps_per_instance',
    'openalgo.request_timeout_ms',
    'instance_health.ping_healthy_interval_ms',
    'brokerage.default',
    'trading_sessions',
  ]) {
    assert.ok(isEditable(key), `${key} should be editable`);
  }
});

test('numeric bounds reject values that would hammer a broker', () => {
  // A 5ms position poll would issue ~200 broker calls a second and earn a rate-limit ban.
  assert.ok(validateValue('market_data_feed.position_interval_idle_ms', 5));
  assert.ok(validateValue('rate_limits.rps_per_instance', 0));
  assert.ok(validateValue('rate_limits.rps_per_instance', 10000));
  assert.strictEqual(validateValue('rate_limits.rps_per_instance', 5), null);
});

test('blackout windows must be 24-hour HH:MM', () => {
  assert.strictEqual(validateValue('market_hours.quote_blackout_start', '08:45'), null);
  assert.strictEqual(validateValue('market_hours.quote_blackout_start', '00:00'), null);
  assert.strictEqual(validateValue('market_hours.quote_blackout_start', '23:59'), null);
  for (const bad of ['8:45', '24:00', '08:60', 'morning', '', '0845']) {
    assert.ok(
      validateValue('market_hours.quote_blackout_start', bad),
      `${JSON.stringify(bad)} must be rejected`
    );
  }
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
