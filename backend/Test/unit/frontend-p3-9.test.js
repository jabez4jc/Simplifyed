import assert from 'assert';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(dir, '../../public', rel), 'utf8');

/** settings-general.js extends SettingsHandler.prototype; give it a bare class and a fake api. */
function settingsHandler(apiReply) {
  const toasts = [];
  const SettingsHandler = class {};
  const sandbox = {
    SettingsHandler,
    Utils: { showToast: (...args) => toasts.push(args) },
    api: { request: async () => apiReply },
    window: {},
    document: { querySelector: () => null },
    console: { error() {}, log() {} },
  };
  const keys = Object.keys(sandbox);
  new Function(...keys, read('js/settings-general.js'))(...keys.map((k) => sandbox[k]));
  const h = new SettingsHandler();
  Object.assign(h, {
    settings: { general: { 'risk.max_loss': { pendingValue: '5', rawValue: '1', dataType: 'number' } } },
    canEditApplicationSettings: () => true,
    updateSaveButton() {},
    parseValue: (v) => Number(v),
    refreshSettings: async () => {},
  });
  return { h, toasts };
}

test('a partial settings save is an error toast naming each rejected key and why', async () => {
  const { h, toasts } = settingsHandler({
    data: { summary: { successful: 1, total: 2 }, errors: [{ key: 'risk.max_loss', error: 'must be >= 0' }] },
  });
  await h.saveSettings();
  assert.strictEqual(toasts.length, 1);
  const [message, type] = toasts[0];
  assert.strictEqual(type, 'error');
  assert.match(message, /1 of 2 settings saved/);
  assert.match(message, /risk\.max_loss: must be >= 0/);
});

test('a clean settings save is still a success toast', async () => {
  const { h, toasts } = settingsHandler({ data: { summary: { successful: 1, total: 1 }, errors: [] } });
  await h.saveSettings();
  assert.deepStrictEqual(toasts[0].slice(0, 2), ['Successfully updated 1 of 1 settings', 'success']);
});

test('search renders the settings once per keystroke', () => {
  const renders = [];
  const { h } = settingsHandler({});
  h.refreshApplicationSettings = () => renders.push(1);
  h.handleSearch(' NIFTY ');
  assert.strictEqual(h.searchQuery, 'nifty');
  assert.strictEqual(renders.length, 1);
});

test('mark-all-read is one request, not one per row', async () => {
  const calls = [];
  const api = (() => {
    const sandbox = {
      fetch: async (url, cfg) => { calls.push([url, cfg.method]); return new Response('{"status":"success"}', { headers: { 'content-type': 'application/json' } }); },
      localStorage: { getItem: () => 'tok', removeItem() {} },
      window: { location: {} },
      FormData,
    };
    const keys = Object.keys(sandbox);
    return new Function(...keys, `${read('js/api-client.js')}\nreturn api;`)(...keys.map((k) => sandbox[k]));
  })();
  await api.markAllNotificationsRead();
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0][0], /\/notifications\/read-all$/);
  assert.strictEqual(calls[0][1], 'POST');
  assert.ok(!/markNotificationRead\(/.test(read('js/dashboard-notifications.js').split('async markAllNotificationsRead')[1].split('async triggerHealthCheck')[0]));
  assert.ok(!/Audit/.test(read('js/dashboard-notifications.js').split('*/')[0]), 'stale Audit header comment is gone');
});

/** Run the service worker against fake caches and return a fetch(event) driver. */
function serviceWorker({ networkOk = true } = {}) {
  const stores = new Map(); // cache name -> Map(url -> response)
  const listeners = {};
  const cacheApi = {
    open: async (name) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        put: async (req, res) => { store.set(req.url, res); },
        keys: async () => [...store.keys()].map((url) => ({ url })),
        delete: async (key) => store.delete(key.url),
        addAll: async () => {},
      };
    },
    match: async (req) => { for (const store of stores.values()) if (store.has(req.url)) return store.get(req.url); return undefined; },
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
  };
  const self = { location: { origin: 'http://app.test' }, addEventListener: (type, fn) => { listeners[type] = fn; }, skipWaiting() {}, clients: { claim() {} } };
  const sandbox = {
    self, caches: cacheApi, URL,
    fetch: async (req) => { if (!networkOk) throw new Error('offline'); return { ok: true, url: req.url, body: `net:${req.url}`, clone() { return this; } }; },
  };
  const keys = Object.keys(sandbox);
  new Function(...keys, read('service-worker.js'))(...keys.map((k) => sandbox[k]));
  const get = async (url) => {
    let answer;
    listeners.fetch({ request: { url, method: 'GET', mode: 'cors' }, respondWith: (p) => { answer = p; } });
    return answer === undefined ? undefined : answer;
  };
  return { stores, listeners, get, setNetwork: (ok) => { sandbox.fetch = async (req) => { if (!ok) throw new Error('offline'); return { ok: true, url: req.url, body: `net:${req.url}`, clone() { return this; } }; }; } };
}

test('service worker: /js, /css and /vendor are network-first and keep one copy per path', async () => {
  const sw = serviceWorker();
  const a = await sw.get('http://app.test/js/app.js?v=1');
  assert.strictEqual(a.body, 'net:http://app.test/js/app.js?v=1');
  await new Promise((r) => setTimeout(r, 10));
  const b = await sw.get('http://app.test/js/app.js?v=2');
  assert.strictEqual(b.body, 'net:http://app.test/js/app.js?v=2', 'a cached older version is never served ahead of the network');
  await new Promise((r) => setTimeout(r, 20));
  const cached = [...[...sw.stores.values()][0].keys()].filter((u) => u.includes('/js/app.js'));
  assert.deepStrictEqual(cached, ['http://app.test/js/app.js?v=2'], 'the old ?v= entry was dropped');

  const vendor = await sw.get('http://app.test/vendor/openalgo-charts/index.js');
  assert.match(vendor.body, /^net:/);
});

test('service worker: offline falls back to the last copy; old caches go on activate', async () => {
  const sw = serviceWorker();
  await sw.get('http://app.test/css/app.css?v=3');
  await new Promise((r) => setTimeout(r, 10));
  sw.setNetwork(false);
  const offline = await sw.get('http://app.test/css/app.css?v=3');
  assert.strictEqual(offline.body, 'net:http://app.test/css/app.css?v=3', 'served from the cache when the network is down');

  sw.stores.set('simplifyed-v6', new Map([['x', 1]]));
  let done;
  sw.listeners.activate({ waitUntil: (p) => { done = p; } });
  await done;
  assert.ok(!sw.stores.has('simplifyed-v6'), 'the previous cache is deleted');
});
