import assert from 'assert';
import test from 'node:test';
import settingsService from '../../src/services/settings.service.js';
import { computeSessionState, formatDateIST, shouldAutoRevertToLive } from '../../src/utils/instance-session.util.js';

function buildInstance(overrides = {}) {
  return {
    id: 1,
    is_analyzer_mode: 0,
    session_baseline_total_pnl: 0,
    session_baseline_at: null,
    session_pnl: 0,
    session_target_profit: null,
    session_max_loss: null,
    last_live_total_pnl: null,
    last_live_total_pnl_at: null,
    multiplier: 1,
    ...overrides,
  };
}

// computeSessionState calls the module-level getTradingSessions(), which reads
// through settingsService.getSetting('trading_sessions') - stub that, not the
// (now-removed) instanceService wrapper methods.
function stubTradingSessions(sessions) {
  const original = settingsService.getSetting;
  settingsService.getSetting = async (key) =>
    key === 'trading_sessions' ? { value: sessions } : original.call(settingsService, key);
  return () => {
    settingsService.getSetting = original;
  };
}

test('session target respects multiplier', async () => {
  const now = new Date(2025, 0, 1, 10, 0, 0);
  const today = formatDateIST(now);
  const sessionKey = `${today}|Session 1`;
  const restore = stubTradingSessions([{ label: 'Session 1', start: '00:00', end: '23:59' }]);

  try {
    const instance = buildInstance({
      session_baseline_total_pnl: 0,
      session_baseline_at: sessionKey,
      session_target_profit: 100,
      multiplier: 2,
    });

    const result = await computeSessionState(instance, 200, now);
    assert.equal(result.cutoffReason, 'SESSION_TARGET_PROFIT_REACHED');
  } finally {
    restore();
  }
});

test('auto-revert to live only after a max-loss cutoff, in a later session, with no new breach', () => {
  const cutoff = { is_analyzer_mode: 1, session_cutoff_reason: 'SESSION_MAX_LOSS_BREACHED', session_baseline_at: '2026-10-01|S1' };
  const ctx = { currentSession: { name: 'S1' }, cutoffReason: null, sessionKey: '2026-10-02|S1' };
  assert.strictEqual(shouldAutoRevertToLive(cutoff, ctx), true);
  assert.strictEqual(shouldAutoRevertToLive(cutoff, { ...ctx, sessionKey: '2026-10-01|S1' }), false, 'same session');
  assert.strictEqual(shouldAutoRevertToLive({ ...cutoff, session_cutoff_reason: 'SESSION_TARGET_PROFIT_REACHED' }, ctx), false, 'target cutoff');
  assert.strictEqual(shouldAutoRevertToLive({ ...cutoff, session_cutoff_reason: 'SESSION_MAX_LOSS_BREACHED_X' }, ctx), false, 'exact match only');
  assert.strictEqual(shouldAutoRevertToLive(cutoff, { ...ctx, cutoffReason: 'SESSION_MAX_LOSS_BREACHED' }), false, 'still breached');
  assert.strictEqual(shouldAutoRevertToLive(cutoff, { ...ctx, currentSession: null }), false, 'outside a session');
  assert.strictEqual(shouldAutoRevertToLive({ ...cutoff, is_analyzer_mode: 0 }, ctx), false, 'already live');
});
