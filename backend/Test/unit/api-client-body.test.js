import assert from 'assert';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// api.request replaced settings-core.authFetch (F5), so it has to carry FormData uploads and
// CSV downloads as well as JSON.
const dir = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(dir, '../../public/js/api-client.js'), 'utf8');

function client(fetchImpl) {
  const sandbox = {
    fetch: fetchImpl,
    localStorage: { getItem: () => 'tok', removeItem() {} },
    window: { location: {} },
    FormData,
  };
  const keys = Object.keys(sandbox);
  return new Function(...keys, `${src}\nreturn api;`)(...keys.map((k) => sandbox[k]));
}

const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('a FormData body is sent as-is, with no JSON content type', async () => {
  let seen;
  const api = client(async (url, cfg) => { seen = cfg; return jsonRes({ status: 'success' }); });
  const fd = new FormData();
  fd.append('file', 'x');
  await api.request('/instruments/upload', { method: 'POST', body: fd });
  assert.equal(seen.body, fd);
  assert.equal(seen.headers['Content-Type'], undefined);
  assert.equal(seen.headers.Authorization, 'Bearer tok');
});

test('a JSON body is stringified; blob:true returns the file, and errors still throw', async () => {
  let seen;
  const csv = () => new Response('a,b\n1,2', { headers: { 'content-type': 'text/csv' } });
  let reply = csv;
  const api = client(async (url, cfg) => { seen = cfg; return reply(); });
  await assert.rejects(api.request('/x', { method: 'PUT', body: { a: 1 } }), /Non-JSON/);
  assert.equal(seen.body, '{"a":1}');
  assert.equal(seen.headers['Content-Type'], 'application/json');

  const blob = await api.request('/instances/export/csv', { blob: true });
  assert.equal(await blob.text(), 'a,b\n1,2');

  reply = () => jsonRes({ message: 'nope' }, 422);
  await assert.rejects(api.request('/x', { blob: true }), /nope/);
});
