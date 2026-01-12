import db from '../core/database.js';

const SENSITIVE_KEYS = new Set([
  'api_key',
  'apikey',
  'secret',
  'password',
  'token',
  'authorization',
]);

function sanitizeValue(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => {
        if (SENSITIVE_KEYS.has(key.toLowerCase())) {
          return [key, '[redacted]'];
        }
        return [key, sanitizeValue(val)];
      })
    );
  }
  return value;
}

export function auditLogger(req, res, next) {
  const method = (req.method || '').toUpperCase();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    return next();
  }

  res.on('finish', () => {
    if (req.auditLogged) return;
    const status = res.statusCode || 0;
    const action = `${method} ${req.originalUrl || req.url || ''}`;
    const metadata = {
      status,
      params: sanitizeValue(req.params || {}),
      query: sanitizeValue(req.query || {}),
      body: sanitizeValue(req.body || {}),
      correlation_id: req.correlationId || null,
    };

    db.run(
      'INSERT INTO audit_logs (user_id, action, metadata) VALUES (?, ?, ?)',
      [req.user?.id || null, action, JSON.stringify(metadata)]
    ).catch(() => {});
  });

  next();
}
