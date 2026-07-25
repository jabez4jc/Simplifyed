import crypto from 'crypto';
import db from '../core/database.js';
import { log } from '../core/logger.js';

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// cleanupExpired compares expires_at against SQLite's CURRENT_TIMESTAMP, which is UTC
// 'YYYY-MM-DD HH:MM:SS'. toISOString() is also UTC but formats as 'YYYY-MM-DDTHH:MM:SS.sssZ',
// and the string comparison put 'T' (0x54) above ' ' (0x20) - so keys expiring on the current
// date never got collected. Store the format the comparison actually expects.
function toSqliteUtc(ms) {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

class IdempotencyService {
  _hashPayload(payload) {
    const raw = typeof payload === 'string' ? payload : JSON.stringify(payload || {});
    return crypto.createHash('sha256').update(raw).digest('hex');
  }

  async getOrCreate({ requestId, source, payload, ttlMs = DEFAULT_TTL_MS }) {
    if (!requestId || !source) {
      return { hit: false, record: null, mismatch: false };
    }

    const existing = await db.get(
      'SELECT * FROM idempotency_keys WHERE request_id = ? AND source = ?',
      [requestId, source]
    );
    if (existing) {
      let mismatch = false;
      if (payload) {
        const requestHash = this._hashPayload(payload);
        mismatch = existing.request_hash && existing.request_hash !== requestHash;
        if (mismatch) {
          log.warn('Idempotency hash mismatch', { requestId, source });
        }
      }
      return { hit: true, record: existing, mismatch };
    }

    const requestHash = this._hashPayload(payload);
    const expiresAt = ttlMs ? toSqliteUtc(Date.now() + ttlMs) : null;

    // The INSERT is the lock. Two concurrent identical requests (a TradingView alert retry
    // racing the original) both miss the SELECT above, so only the UNIQUE(request_id, source)
    // constraint distinguishes them. OR IGNORE turns the violation into changes === 0 instead
    // of a throw, and the loser must report hit:true - previously the failure was swallowed and
    // both callers got hit:false, so both went on to place the order.
    const { changes } = await db.run(
      `INSERT OR IGNORE INTO idempotency_keys (request_id, source, request_hash, status, expires_at)
       VALUES (?, ?, ?, 'pending', ?)`,
      [requestId, source, requestHash, expiresAt]
    );

    const record = await db.get(
      'SELECT * FROM idempotency_keys WHERE request_id = ? AND source = ?',
      [requestId, source]
    );

    if (changes === 0) {
      const mismatch = Boolean(record?.request_hash && record.request_hash !== requestHash);
      log.warn('Idempotency insert lost the race, treating as duplicate', { requestId, source });
      return { hit: true, record, mismatch };
    }

    return { hit: false, record, mismatch: false };
  }

  async complete({ requestId, source, response, status = 'success', statusCode = null }) {
    if (!requestId || !source) return;
    const responseJson = response ? JSON.stringify(response) : null;
    await db.run(
      `UPDATE idempotency_keys
       SET response_json = ?, status = ?, status_code = ?, expires_at = COALESCE(expires_at, ?)
       WHERE request_id = ? AND source = ?`,
      [
        responseJson,
        status,
        statusCode,
        toSqliteUtc(Date.now() + DEFAULT_TTL_MS),
        requestId,
        source,
      ]
    );
  }

  async cleanupExpired() {
    try {
      await db.run(
        `DELETE FROM idempotency_keys
         WHERE expires_at IS NOT NULL AND expires_at < CURRENT_TIMESTAMP`
      );
    } catch (error) {
      log.warn('Failed to cleanup idempotency keys', { error: error.message });
    }
  }
}

const idempotencyService = new IdempotencyService();
export default idempotencyService;
