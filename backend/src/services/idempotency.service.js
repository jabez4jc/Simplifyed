import crypto from 'crypto';
import db from '../core/database.js';
import { log } from '../core/logger.js';

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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
    const expiresAt = ttlMs ? new Date(Date.now() + ttlMs).toISOString() : null;

    try {
      await db.run(
        `INSERT INTO idempotency_keys (request_id, source, request_hash, status, expires_at)
         VALUES (?, ?, ?, 'pending', ?)`,
        [requestId, source, requestHash, expiresAt]
      );
    } catch (error) {
      log.warn('Idempotency insert failed, reloading record', {
        requestId,
        source,
        error: error.message,
      });
    }

    const record = await db.get(
      'SELECT * FROM idempotency_keys WHERE request_id = ? AND source = ?',
      [requestId, source]
    );

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
        new Date(Date.now() + DEFAULT_TTL_MS).toISOString(),
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
