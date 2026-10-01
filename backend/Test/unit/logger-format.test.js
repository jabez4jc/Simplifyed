import assert from 'assert';
import test from 'node:test';
import { formatKv, sanitizeMeta } from '../../src/core/logger.js';

const line = (meta, message = 'x') => formatKv({ timestamp: 'T', level: 'info', message }, sanitizeMeta(meta));

test('every primitive meta key is printed and secrets are redacted', () => {
  const out = line({ foo: 1, api_key: 'sekret', webhookToken: 't0ken', id: 7, host_url: 'http://h', ok: false });
  assert.match(out, /foo=1/);
  assert.match(out, /id=7/);
  assert.match(out, /host_url=http:\/\/h/);
  assert.match(out, /ok=false/);
  assert.match(out, /api_key=\[REDACTED\]/);
  assert.match(out, /webhookToken=\[REDACTED\]/);
  assert.ok(!out.includes('sekret') && !out.includes('t0ken'));
});

test('an Error under err prints its message; objects are still dropped', () => {
  const out = line({ err: new Error('boom'), nested: { a: 1 } });
  assert.match(out, /err=boom/);
  assert.ok(!out.includes('nested'));
});

test('the message stays last and reserved keys cannot shadow the prefix', () => {
  const out = line({ msg: 'spoof', pid: 'spoof', a: 1 }, 'hello');
  assert.ok(out.endsWith('msg="hello"'));
  assert.ok(!out.includes('spoof'));
});
