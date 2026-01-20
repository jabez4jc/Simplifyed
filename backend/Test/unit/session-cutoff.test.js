import assert from 'assert';
import test from 'node:test';
import instanceService from '../../src/services/instance.service.js';

function buildInstance(overrides = {}) {
  return {
    id: 1,
    is_analyzer_mode: 0,
    session_baseline_total_pnl: 0,
    session_baseline_at: null,
    session_pnl: 0,
    session_target_profit: null,
    session_max_loss: null,
    session_max_loss_hits: 0,
    session_max_loss_hits_date: null,
    last_live_total_pnl: null,
    last_live_total_pnl_at: null,
    multiplier: 1,
    ...overrides,
  };
}

test('session max-loss hits reset on new session key', async () => {
  const originalSessions = instanceService._getTradingSessions;
  const now = new Date(2025, 0, 1, 10, 0, 0);
  const today = instanceService._formatDateIST(now);

  try {
    instanceService._getTradingSessions = async () => [
      { label: 'Session 1', start: '00:00', end: '23:59' },
    ];

    const instance = buildInstance({
      session_max_loss_hits: 2,
      session_max_loss_hits_date: `${today}|Old Session`,
    });

    const result = await instanceService._computeSessionState(instance, 0, now);
    assert.equal(result.maxLossHits, 0);
  } finally {
    instanceService._getTradingSessions = originalSessions;
  }
});

test('session target respects multiplier', async () => {
  const originalSessions = instanceService._getTradingSessions;
  const now = new Date(2025, 0, 1, 10, 0, 0);
  const today = instanceService._formatDateIST(now);
  const sessionKey = `${today}|Session 1`;

  try {
    instanceService._getTradingSessions = async () => [
      { label: 'Session 1', start: '00:00', end: '23:59' },
    ];

    const instance = buildInstance({
      session_baseline_total_pnl: 0,
      session_baseline_at: sessionKey,
      session_target_profit: 100,
      multiplier: 2,
    });

    const result = await instanceService._computeSessionState(instance, 200, now);
    assert.equal(result.cutoffReason, 'SESSION_TARGET_PROFIT_REACHED');
  } finally {
    instanceService._getTradingSessions = originalSessions;
  }
});
