import assert from 'assert';
import test from 'node:test';
import express from 'express';
import request from 'supertest';
import authRoutes from '../../src/routes/v1/auth.js';
import { errorHandler } from '../../src/middleware/error-handler.js';
import instanceHealthService from '../../src/services/instance-health.service.js';

function authApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth', authRoutes);
  return app;
}

test('auth endpoints reject non-string credentials as client errors', async () => {
  const app = authApp();

  const login = await request(app)
    .post('/api/v1/auth/login')
    .send({ email: { value: 'admin@example.com' }, password: ['password'] });
  assert.equal(login.status, 400);

  const register = await request(app)
    .post('/api/v1/auth/register')
    .send({ email: 42, password: true });
  assert.equal(register.status, 400);
});

test('new passwords cannot exceed bcrypt\'s 72-byte input boundary', async () => {
  const response = await request(authApp())
    .post('/api/v1/auth/register')
    .send({ email: 'admin@example.com', password: 'é'.repeat(37) });

  assert.equal(response.status, 400);
  assert.match(response.body.message, /72 bytes/);
});

test('oversized uploads return 413 instead of an internal-server error', () => {
  const captured = {};
  const response = {
    status(code) { captured.status = code; return this; },
    json(body) { captured.body = body; return this; },
  };
  const error = Object.assign(new Error('File too large'), {
    name: 'MulterError',
    code: 'LIMIT_FILE_SIZE',
  });

  errorHandler(error, { path: '/import', method: 'POST' }, response, () => {});
  assert.equal(captured.status, 413);
  assert.equal(captured.body.code, 'LIMIT_FILE_SIZE');
});

test('instance health configuration rejects malformed or unbounded test lists', async () => {
  await assert.rejects(
    instanceHealthService.updateTestConfig({ quotes: [], multiquotes: [], optionchain: [{}] }),
    /require underlying and exchange/
  );

  await assert.rejects(
    instanceHealthService.updateTestConfig({
      quotes: Array.from({ length: 21 }, () => ({ symbol: 'SBIN', exchange: 'NSE' })),
      multiquotes: [],
      optionchain: [],
    }),
    /at most 20 entries/
  );
});
