/**
 * Migration 061: Smart-order rate limit
 *
 * OpenAlgo caps /placesmartorder at 2 requests/sec - stricter than plain /placeorder's 10/sec.
 * Every order this app places goes through placesmartorder (order-placement.service.js always
 * reconciles against the open position via `position_size`), so the single existing
 * `rate_limits.orders_per_second` row (10) was being applied to endpoint traffic the broker
 * actually caps at a fifth of that. A burst - closing several positions, a fast quick-order
 * fan-out, a retry storm - could legally be throttled by this app slower than 10/sec and still
 * be rejected by the broker.
 *
 * `rate_limits.orders_per_second` is kept as-is (it still governs a future direct /placeorder
 * call, and existing operator tuning of it should not silently change meaning); this adds the
 * new, stricter figure alongside it. See client.js's `_throttle`, which picks between the two
 * by endpoint name.
 */

export const version = '061';
export const name = 'smart_order_rate_limit';

export async function up(db) {
  const existing = await db.get(
    `SELECT key FROM application_settings WHERE key = ?`,
    ['rate_limits.smart_orders_per_second']
  );
  if (existing) return;

  await db.run(
    `INSERT INTO application_settings (key, value, description, category, data_type)
     VALUES (?, ?, ?, ?, ?)`,
    [
      'rate_limits.smart_orders_per_second',
      '2',
      'Max placesmartorder requests per second (per instance/global) - OpenAlgo caps this endpoint stricter than plain placeorder',
      'rate_limits',
      'number',
    ]
  );
}

export async function down(db) {
  await db.run(
    `DELETE FROM application_settings WHERE key = ?`,
    ['rate_limits.smart_orders_per_second']
  );
}
