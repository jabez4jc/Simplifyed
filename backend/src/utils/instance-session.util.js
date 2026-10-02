/**
 * Instance Session Utility
 * Pure/near-pure trading-session and P&L-cutoff helpers shared by the analyzer-mode
 * service (session-reset fields on live-switch) and the P&L service (session baseline/
 * cutoff computation). Extracted from instance.service.js - none of these hold `this`
 * state, so they're plain exported functions rather than a class/singleton (mirrors
 * symbol-parsing.util.js).
 */

import { log } from '../core/logger.js';
import settingsService from '../services/settings.service.js';
import { toISTDate, toISTISOString } from './time.js';
import { parseFloatSafe } from './sanitizers.js';
import { settingDefault } from '../config/settings-registry.js';

export function nowInIST() {
  return toISTDate();
}

export function formatDateIST(date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseHmToMinutes(hm = '') {
  const [h, m] = hm.split(':').map((v) => parseInt(v, 10));
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

export function findCurrentSession(date, sessions = []) {
  const minutes = date.getHours() * 60 + date.getMinutes();
  return sessions.find((s) => {
    const start = parseHmToMinutes(s.start);
    const end = parseHmToMinutes(s.end);
    if (start === null || end === null) return false;
    return minutes >= start && minutes < end;
  });
}

export async function getTradingSessions() {
  try {
    const setting = await settingsService.getSetting('trading_sessions');
    const raw = setting?.value ?? setting?.rawValue;
    if (Array.isArray(raw)) {
      return raw;
    }
    if (typeof raw === 'string') {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    }
  } catch (error) {
    log.warn('Falling back to default trading sessions', { error: error.message });
  }
  return JSON.parse(settingDefault('trading_sessions'));
}

export async function computeSessionState(instance, totalPnl, now, { overrideAnalyzerMode = null } = {}) {
  const istNow = now || nowInIST();
  const todayIst = formatDateIST(istNow);
  const sessions = await getTradingSessions();
  const currentSession = findCurrentSession(istNow, sessions);

  let sessionBaseline = instance.session_baseline_total_pnl;
  let sessionBaselineAt = instance.session_baseline_at;
  let sessionPnl = instance.session_pnl;
  let cutoffReason = null;

  const sessionLabel = currentSession?.label || null;
  const sessionKey = currentSession ? `${todayIst}|${sessionLabel}` : null;

  const analyzerMode = overrideAnalyzerMode === null ? !!instance.is_analyzer_mode : !!overrideAnalyzerMode;
  const isLiveMode = !analyzerMode;

  let lastLiveTotalPnl = instance.last_live_total_pnl;
  let lastLiveTotalPnlAt = instance.last_live_total_pnl_at;
  if (isLiveMode) {
    lastLiveTotalPnl = totalPnl;
    lastLiveTotalPnlAt = toISTISOString();
  }

  const target = parseFloatSafe(instance.session_target_profit, null);
  const maxLoss = parseFloatSafe(instance.session_max_loss, null);
  const rawMultiplier = parseFloatSafe(instance.multiplier, 1);
  const multiplier = rawMultiplier > 0 ? rawMultiplier : 1;
  const effectiveTarget = target !== null ? target * multiplier : null;
  const effectiveMaxLoss = maxLoss !== null ? Math.abs(maxLoss) * multiplier : null;

  if (isLiveMode && currentSession) {
    if (sessionBaselineAt !== sessionKey || sessionBaseline === null || sessionBaseline === undefined) {
      sessionBaseline = totalPnl;
      sessionBaselineAt = sessionKey;
      sessionPnl = 0;
    } else {
      sessionPnl = totalPnl - sessionBaseline;
    }

    if (effectiveTarget !== null && sessionPnl >= effectiveTarget) {
      cutoffReason = 'SESSION_TARGET_PROFIT_REACHED';
    } else if (effectiveMaxLoss !== null && sessionPnl <= -effectiveMaxLoss) {
      cutoffReason = 'SESSION_MAX_LOSS_BREACHED';
    }
  }

  return {
    currentSession,
    sessionKey,
    sessionLabel,
    sessionBaseline,
    sessionBaselineAt,
    sessionPnl,
    cutoffReason,
    effectiveTarget,
    effectiveMaxLoss,
    lastLiveTotalPnl,
    lastLiveTotalPnlAt,
    isLiveMode,
  };
}
