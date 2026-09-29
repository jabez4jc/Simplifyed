import assert from 'assert';
import test, { before, beforeEach } from 'node:test';

import { useTestDb, truncate } from '../helpers/db.js';
import { computeSessionState, formatDateIST } from '../../src/utils/instance-session.util.js';

/**
 * Session-level risk: the automatic cutoff that takes an account out of live trading when it
 * hits its profit target or loses more than the operator allowed.
 *
 * This is the last line of defence in the whole application. If it fires when it should not, a
 * profitable account stops trading; if it fails to fire, losses keep running with nobody
 * watching. Both directions are tested, along with the boundaries and the reset behaviour that
 * decides whether a limit carries across sessions.
 *
 * Time is always passed in explicitly - a risk rule that behaves differently depending on when
 * the suite runs is a risk rule nobody can trust.
 */

before(async () => {
  await useTestDb('session-risk');
});
beforeEach(async () => {
  await truncate();
});

/** Inside the default 'Session 2' window (12:30-15:10 IST). */
const duringSession = () => new Date('2026-03-10T13:00:00+05:30');
/** Between the default sessions - 11:30 to 12:30 IST is a gap. */
const betweenSessions = () => new Date('2026-03-10T11:45:00+05:30');

function instance(overrides = {}) {
  return {
    id: 1,
    is_analyzer_mode: 0,
    session_baseline_total_pnl: null,
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

/** An instance already trading in the current session, with a known baseline. */
function withBaseline(now, overrides = {}) {
  const key = `${formatDateIST(now)}|Session 2`;
  return instance({ session_baseline_at: key, session_baseline_total_pnl: 0, ...overrides });
}

// ---------------------------------------------------------------------------
// The baseline
// ---------------------------------------------------------------------------

test('the first reading of a session becomes its baseline, not an instant profit or loss', async () => {
  // An account carrying +50,000 from earlier in the day must not be read as having made 50,000
  // this session and immediately hit its target.
  const now = duringSession();
  const state = await computeSessionState(instance({ session_target_profit: 10000 }), 50000, now);

  assert.strictEqual(state.sessionBaseline, 50000, 'the opening figure is the baseline');
  assert.strictEqual(state.sessionPnl, 0, 'a session starts flat');
  assert.strictEqual(state.cutoffReason, null, 'no cutoff on the first reading of a session');
});

test('session P&L is measured from the baseline, not from zero', async () => {
  const now = duringSession();
  const state = await computeSessionState(
    withBaseline(now, { session_baseline_total_pnl: 50000 }),
    62000,
    now
  );
  assert.strictEqual(state.sessionPnl, 12000);
});

test('a new session re-baselines rather than carrying the previous session forward', async () => {
  const now = duringSession();
  const state = await computeSessionState(
    instance({ session_baseline_at: '2026-03-09|Session 2', session_baseline_total_pnl: 1000 }),
    9000,
    now
  );
  assert.strictEqual(state.sessionBaseline, 9000, "yesterday's baseline must not apply to today");
  assert.strictEqual(state.sessionPnl, 0);
});

// ---------------------------------------------------------------------------
// The profit target
// ---------------------------------------------------------------------------

test('the profit target fires at the threshold and not one rupee before', async () => {
  const now = duringSession();
  const config = { session_target_profit: 10000 };

  const justUnder = await computeSessionState(withBaseline(now, config), 9999, now);
  assert.strictEqual(justUnder.cutoffReason, null);

  const exactly = await computeSessionState(withBaseline(now, config), 10000, now);
  assert.strictEqual(exactly.cutoffReason, 'SESSION_TARGET_PROFIT_REACHED', 'the target is inclusive');

  const over = await computeSessionState(withBaseline(now, config), 25000, now);
  assert.strictEqual(over.cutoffReason, 'SESSION_TARGET_PROFIT_REACHED');
});

// ---------------------------------------------------------------------------
// The maximum loss
// ---------------------------------------------------------------------------

test('the max loss fires at the threshold, whichever sign it was configured with', async () => {
  // An operator may type 5000 or -5000 for "I am willing to lose five thousand". Reading the
  // sign literally would mean a positive limit never triggers, and the account keeps losing.
  const now = duringSession();

  for (const configured of [5000, -5000]) {
    const config = { session_max_loss: configured };

    const under = await computeSessionState(withBaseline(now, config), -4999, now);
    assert.strictEqual(under.cutoffReason, null, `${configured}: -4999 is inside the limit`);

    const at = await computeSessionState(withBaseline(now, config), -5000, now);
    assert.strictEqual(at.cutoffReason, 'SESSION_MAX_LOSS_BREACHED', `${configured}: the limit is inclusive`);

    const beyond = await computeSessionState(withBaseline(now, config), -20000, now);
    assert.ok(beyond.cutoffReason, `${configured}: a gap through the limit must still trigger`);
  }
});

test('the third max-loss breach escalates from a pause to a hard stop', async () => {
  const now = duringSession();
  const key = `${formatDateIST(now)}|Session 2`;
  const config = { session_max_loss: 5000, session_baseline_at: key, session_baseline_total_pnl: 0 };

  const first = await computeSessionState(instance({ ...config, session_max_loss_hits: 0, session_max_loss_hits_date: key }), -6000, now);
  assert.strictEqual(first.cutoffReason, 'SESSION_MAX_LOSS_BREACHED');
  assert.strictEqual(first.maxLossHits, 1);

  const second = await computeSessionState(instance({ ...config, session_max_loss_hits: 1, session_max_loss_hits_date: key }), -6000, now);
  assert.strictEqual(second.cutoffReason, 'SESSION_MAX_LOSS_BREACHED');
  assert.strictEqual(second.maxLossHits, 2);

  const third = await computeSessionState(instance({ ...config, session_max_loss_hits: 2, session_max_loss_hits_date: key }), -6000, now);
  assert.strictEqual(third.cutoffReason, 'SESSION_MAX_LOSS_LIMIT_REACHED', 'the third breach is the hard stop');
  assert.strictEqual(third.maxLossHits, 3);
});

test('the breach counter resets for a new session but not within one', async () => {
  const now = duringSession();
  const todayKey = `${formatDateIST(now)}|Session 2`;
  const config = { session_max_loss: 5000, session_baseline_at: todayKey, session_baseline_total_pnl: 0 };

  const carriedOver = await computeSessionState(
    instance({ ...config, session_max_loss_hits: 2, session_max_loss_hits_date: '2026-03-09|Session 2' }),
    -6000,
    now
  );
  assert.strictEqual(carriedOver.maxLossHits, 1, "yesterday's breaches must not count toward today's hard stop");

  const sameSession = await computeSessionState(
    instance({ ...config, session_max_loss_hits: 2, session_max_loss_hits_date: todayKey }),
    -6000,
    now
  );
  assert.strictEqual(sameSession.maxLossHits, 3, 'breaches within one session accumulate');
});

// ---------------------------------------------------------------------------
// The multiplier
// ---------------------------------------------------------------------------

test('limits scale with the instance multiplier, in both directions', async () => {
  // An instance trading 5x the base size must be allowed 5x the rupee swing, or it trips its
  // limit on a move that is proportionally identical to a 1x instance sitting well inside it.
  const now = duringSession();
  const config = { session_target_profit: 10000, session_max_loss: 5000, multiplier: 5 };

  const belowScaledTarget = await computeSessionState(withBaseline(now, config), 40000, now);
  assert.strictEqual(belowScaledTarget.cutoffReason, null, '40,000 is inside a 5x target of 50,000');
  assert.strictEqual(belowScaledTarget.effectiveTarget, 50000);

  const atScaledTarget = await computeSessionState(withBaseline(now, config), 50000, now);
  assert.strictEqual(atScaledTarget.cutoffReason, 'SESSION_TARGET_PROFIT_REACHED');

  const insideScaledLoss = await computeSessionState(withBaseline(now, config), -24000, now);
  assert.strictEqual(insideScaledLoss.cutoffReason, null, '-24,000 is inside a 5x loss limit of 25,000');
  assert.strictEqual(insideScaledLoss.effectiveMaxLoss, 25000);

  const atScaledLoss = await computeSessionState(withBaseline(now, config), -25000, now);
  assert.strictEqual(atScaledLoss.cutoffReason, 'SESSION_MAX_LOSS_BREACHED');
});

test('a missing or nonsensical multiplier falls back to 1 rather than disabling the limits', async () => {
  // A multiplier of 0 must not multiply the limit to zero - that would cut off instantly - and
  // must not be read as "no limit" either.
  const now = duringSession();

  for (const multiplier of [0, -3, null, undefined, 'abc']) {
    const state = await computeSessionState(
      withBaseline(now, { session_target_profit: 10000, multiplier }),
      10000,
      now
    );
    assert.strictEqual(state.effectiveTarget, 10000, `multiplier ${JSON.stringify(multiplier)} must fall back to 1`);
    assert.strictEqual(state.cutoffReason, 'SESSION_TARGET_PROFIT_REACHED');
  }
});

// ---------------------------------------------------------------------------
// When the rules do not apply
// ---------------------------------------------------------------------------

test('an instance already in analyzer mode is never cut off again', async () => {
  // Analyzer mode is where a cut-off instance lands. Re-triggering there would keep rewriting
  // the cutoff reason for simulated P&L that risks nothing.
  const now = duringSession();
  const state = await computeSessionState(
    withBaseline(now, { is_analyzer_mode: 1, session_target_profit: 1000, session_max_loss: 1000 }),
    -999999,
    now
  );
  assert.strictEqual(state.isLiveMode, false);
  assert.strictEqual(state.cutoffReason, null);
});

test('outside a trading session nothing is cut off', async () => {
  const now = betweenSessions();
  const state = await computeSessionState(
    instance({ session_target_profit: 1000, session_max_loss: 1000 }),
    -999999,
    now
  );
  assert.strictEqual(state.currentSession, undefined, '11:45 IST falls between the default sessions');
  assert.strictEqual(state.cutoffReason, null);
});

test('an instance with no limits configured is never cut off', async () => {
  const now = duringSession();
  const state = await computeSessionState(withBaseline(now), -999999, now);
  assert.strictEqual(state.cutoffReason, null);
  assert.strictEqual(state.effectiveTarget, null);
  assert.strictEqual(state.effectiveMaxLoss, null);
});

test('a profit is never mistaken for a loss breach, nor a loss for a target', async () => {
  const now = duringSession();
  const config = { session_target_profit: 10000, session_max_loss: 5000 };

  const bigProfit = await computeSessionState(withBaseline(now, config), 50000, now);
  assert.strictEqual(bigProfit.cutoffReason, 'SESSION_TARGET_PROFIT_REACHED');

  // A single breach is a pause, however large it is - the hard stop is about REPEATED breaches,
  // not about the size of any one of them.
  const bigLoss = await computeSessionState(withBaseline(now, config), -50000, now);
  assert.strictEqual(bigLoss.cutoffReason, 'SESSION_MAX_LOSS_BREACHED');
});

test('live P&L is recorded on every live reading, and left alone in analyzer mode', async () => {
  // last_live_total_pnl is what the app reconciles against when an instance is switched back to
  // live. Overwriting it with simulated analyzer P&L would corrupt that starting point.
  const now = duringSession();

  const live = await computeSessionState(withBaseline(now), 1234, now);
  assert.strictEqual(live.lastLiveTotalPnl, 1234);

  const analyzer = await computeSessionState(
    withBaseline(now, { is_analyzer_mode: 1, last_live_total_pnl: 999 }),
    -5555,
    now
  );
  assert.strictEqual(analyzer.lastLiveTotalPnl, 999, 'simulated P&L must not overwrite the real figure');
});
