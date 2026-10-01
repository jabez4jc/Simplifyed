/**
 * The rupee max-loss backstop: exit ONE account's position in a contract once that account's UNREALIZED
 * loss on it reaches the cap. A standing rule - it stays until removed, so a later position in the same
 * contract is covered too. Checked every auto-exit cycle from the cached position books, only
 * while the exchange is open, after the loss has held for the confirmation window, and at most
 * one close attempt per account and contract per minute.
 */

import db from '../core/database.js';
import { log } from '../core/logger.js';
import { NotFoundError, ValidationError } from '../core/errors.js';
import { config } from '../core/config.js';
import marketDataFeedService from './market-data-feed.service.js';
import quickOrderService from './quick-order.service.js';
import levels, { CONFIRM_MS, upper, qtyOf } from './exit-levels.service.js';

const CAP_COOLDOWN_MS = 60000;

const num = (v) => (v == null || v === '' ? null : Number(v));

/** Unrealized P&L only: an explicit unrealized field wins, else the broker's total minus its realized part. */
export function unrealizedPnl(p) {
  const explicit = num(p.unrealized_pnl ?? p.unrealised_pnl ?? p.unrealizedPnl);
  if (Number.isFinite(explicit)) return explicit;
  const total = num(p.pnl ?? p.mtm);
  const realized = num(p.realized_pnl ?? p.realised_pnl ?? p.realizedPnl);
  return (Number.isFinite(total) ? total : 0) - (Number.isFinite(realized) ? realized : 0);
}

class ExitLossCapsService {
  constructor() {
    this.crossSince = new Map();
    this.capPendingUntil = new Map();
  }

  async createCap({ symbolId, exchange, symbol, maxLoss, instanceIds = null, userId = null }) {
    const row = await levels._row(symbolId);
    const cap = Number(maxLoss);
    if (!(cap > 0)) throw new ValidationError('maxLoss must be a positive rupee amount');
    const keys = await levels._keys(row);
    const cls = await levels._classify({ exchange, symbol }, keys, new Map());
    if (!cls) throw new ValidationError(`${symbol} is not on ${row.symbol} - a max loss belongs to a contract on this chart's underlying`);
    const ids = await levels._validInstanceIds(row.watchlist_id, instanceIds);
    const { lastID } = await db.run(
      'INSERT INTO exit_loss_caps (watchlist_id, exchange, symbol, max_loss, instance_ids, user_id) VALUES (?, ?, ?, ?, ?, ?)',
      [row.watchlist_id, upper(exchange), upper(symbol), cap, ids, userId]
    );
    return db.get('SELECT * FROM exit_loss_caps WHERE id = ?', [lastID]);
  }

  async cancelCap(id) {
    const res = await db.run(
      "UPDATE exit_loss_caps SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'ACTIVE'",
      [id]
    );
    if (!res.changes) throw new NotFoundError('Active max-loss');
    return { id, status: 'CANCELLED' };
  }

  async listCaps(symbolId) {
    const row = await levels._row(symbolId);
    const keys = await levels._keys(row);
    const caps = await db.all("SELECT * FROM exit_loss_caps WHERE watchlist_id = ? AND status = 'ACTIVE' ORDER BY symbol", [row.watchlist_id]);
    const cache = new Map();
    const out = [];
    for (const c of caps) if (await levels._classify(c, keys, cache)) out.push(c);
    return out;
  }

  /** Called every auto-exit cycle. Never throws. */
  async evaluate() {
    try {
      await this._evaluate();
    } catch (error) {
      log.error('Max-loss evaluation failed', error);
    }
  }

  async _evaluate() {
    const caps = await db.all("SELECT * FROM exit_loss_caps WHERE status = 'ACTIVE'").catch(() => []);
    for (const cap of caps) {
      if (!(await levels._isOpen(cap.exchange))) continue;
      const instances = await levels._instances(cap.watchlist_id, cap.instance_ids);
      for (const inst of instances) {
        const snap = marketDataFeedService.getPositionSnapshot(inst.id);
        const rows = (Array.isArray(snap?.data) ? snap.data : [])
          .filter((p) => upper(p.symbol || p.tradingsymbol) === cap.symbol && upper(p.exchange || p.exch) === cap.exchange && qtyOf(p));
        const pnl = rows.reduce((sum, p) => sum + unrealizedPnl(p), 0);
        const key = `cap${cap.id}|${inst.id}`;
        if (!rows.length || pnl > -cap.max_loss) { this.crossSince.delete(key); continue; }
        if ((this.capPendingUntil.get(key) || 0) > Date.now()) continue;
        const since = this.crossSince.get(key) || Date.now();
        this.crossSince.set(key, since);
        if (Date.now() - since < CONFIRM_MS) continue;
        this.crossSince.delete(key);
        this.capPendingUntil.set(key, Date.now() + CAP_COOLDOWN_MS);
        const cls = rows[0];
        let outcome;
        try {
          await quickOrderService.closePosition(inst, { symbol: cap.symbol, exchange: cap.exchange },
            { tradeMode: /(CE|PE)$/.test(cap.symbol) ? 'OPTIONS' : /FUT$/.test(cap.symbol) ? 'FUTURES' : 'EQUITY', product: cls.product, strategy: 'MAX_LOSS' });
          outcome = { instance: inst.name, ok: true, pnl };
        } catch (error) {
          outcome = { instance: inst.name, ok: false, pnl, error: error.message };
        }
        // Re-read: another account on this cap may have been recorded earlier in this pass.
        let history = [];
        const current = await db.get('SELECT result FROM exit_loss_caps WHERE id = ?', [cap.id]);
        try { history = JSON.parse(current?.result || '[]'); } catch (_) { history = []; }
        history.push({ at: new Date().toISOString(), ...outcome });
        await db.run('UPDATE exit_loss_caps SET result = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [JSON.stringify(history.slice(-20)), cap.id]);
        const text = `${cap.symbol} on ${inst.name}: loss ₹${Math.round(-pnl)} reached the ₹${cap.max_loss} max loss - ${outcome.ok ? 'closing' : `close failed (${outcome.error})`}`;
        log.warn('Max loss reached', { symbol: cap.symbol, exchange: cap.exchange, reason: text });
        if (config.telegram?.botToken) {
          const { default: telegramService } = await import('./telegram.service.js');
          await telegramService.broadcastText(`*MAX LOSS*\n${text}`).catch(() => {});
        }
      }
    }
  }
}

export default new ExitLossCapsService();
