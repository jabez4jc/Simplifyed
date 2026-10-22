import assert from 'assert';
import test, { before, beforeEach, mock } from 'node:test';
import request from 'supertest';

import { useTestDb, truncate } from '../helpers/db.js';
import { buildApp } from '../helpers/app.js';
import { asAdmin, asTrader, withPermissionsExcept, bearer } from '../helpers/auth.js';
import { makeInstance } from '../helpers/fixtures.js';
import { STATUS } from '../helpers/http.js';
import db from '../../src/core/database.js';
import whatsappRoutes from '../../src/routes/v1/whatsapp.js';
import instanceRoutes from '../../src/routes/v1/instances.js';
import fs from 'fs';
import path from 'path';
import whatsappService, { MEDIA_DIR } from '../../src/services/whatsapp.service.js';
import whatsappOutbox from '../../src/services/whatsapp-outbox.service.js';

let wa;
let inst;
let sent;
before(async () => {
  await useTestDb('whatsapp');
  wa = buildApp(whatsappRoutes, '/api/v1/whatsapp');
  inst = buildApp(instanceRoutes, '/api/v1/instances');
  mock.method(whatsappService, 'getStatus', () => ({ status: 'open', phone: '918951708122', qr: null }));
  mock.method(whatsappService, 'sendMessage', async (phone, text, media = []) => { sent.push({ phone, text, media }); });
  whatsappOutbox.gap = () => 0;
});
beforeEach(async () => {
  await truncate();
  await db.run("DELETE FROM whatsapp_templates WHERE kind = 'custom'");
  sent = [];
});

test('only admins reach the WhatsApp API - not even a role holding every permission', async () => {
  const everything = await withPermissionsExcept([]);
  for (const user of [everything, await asTrader()]) {
    assert.strictEqual((await bearer(request(wa).get('/api/v1/whatsapp/status'), user)).status, STATUS.FORBIDDEN);
    assert.strictEqual((await bearer(request(wa).post('/api/v1/whatsapp/send').send({ body: 'x', instance_ids: [1] }), user)).status, STATUS.FORBIDDEN);
  }
  assert.strictEqual((await bearer(request(wa).get('/api/v1/whatsapp/status'), await asAdmin())).status, STATUS.OK);
});

test('owner name and number are hidden from, and not editable by, non-admins', async () => {
  const row = await makeInstance({ owner_name: 'Ana', whatsapp_phone: '919876543210' });
  const trader = await asTrader();
  const admin = await asAdmin();

  const seen = await bearer(request(inst).get(`/api/v1/instances/${row.id}`), trader);
  assert.strictEqual(seen.status, STATUS.OK);
  assert.ok(!('whatsapp_phone' in seen.body.data) && !('owner_name' in seen.body.data));
  const list = await bearer(request(inst).get('/api/v1/instances'), trader);
  assert.ok(list.body.data.every((i) => !('whatsapp_phone' in i)));

  await bearer(request(inst).put(`/api/v1/instances/${row.id}`).send({ name: 'Renamed', whatsapp_phone: '911111111111' }), trader);
  const after = await db.get('SELECT name, whatsapp_phone FROM instances WHERE id = ?', [row.id]);
  assert.deepStrictEqual(after, { name: 'Renamed', whatsapp_phone: '919876543210' });

  const adminView = await bearer(request(inst).get(`/api/v1/instances/${row.id}`), admin);
  assert.strictEqual(adminView.body.data.whatsapp_phone, '919876543210');
  assert.strictEqual(adminView.body.data.owner_name, 'Ana');
  await bearer(request(inst).put(`/api/v1/instances/${row.id}`).send({ owner_name: 'Ana K' }), admin);
  assert.strictEqual((await db.get('SELECT owner_name FROM instances WHERE id = ?', [row.id])).owner_name, 'Ana K');
});

test('send: one personalised message per owner, recorded with the sender; bad placeholders refused', async () => {
  const admin = await asAdmin();
  const a = await makeInstance({ name: 'Kotak', owner_name: 'Vinay', whatsapp_phone: '919876543210' });
  const b = await makeInstance({ name: 'Fyers', owner_name: 'Vinay', whatsapp_phone: '919876543210' });
  const c = await makeInstance({ name: 'Bare' });

  const bad = await bearer(request(wa).post('/api/v1/whatsapp/preview').send({ body: 'Hi {owner}', instance_ids: [a.id] }), admin);
  assert.strictEqual(bad.status, STATUS.VALIDATION);
  assert.match(bad.body.message, /\{owner\}/);

  const body = 'Hi {owner_name}, *maintenance* tonight at {time}.';
  const preview = await bearer(request(wa).post('/api/v1/whatsapp/preview').send({ body, instance_ids: [a.id, b.id, c.id] }), admin);
  assert.strictEqual(preview.status, STATUS.OK, preview.text);
  assert.strictEqual(preview.body.data.messages.length, 1);
  assert.deepStrictEqual(preview.body.data.skipped, ['Bare']);

  const res = await bearer(request(wa).post('/api/v1/whatsapp/send').send({ body, instance_ids: [a.id, b.id, c.id] }), admin);
  assert.strictEqual(res.status, STATUS.OK, res.text);
  assert.strictEqual(res.body.data.queued, 1);
  await whatsappOutbox.drain();
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].text, /^Hi Vinay, \*maintenance\* tonight at \d\d:\d\d\.$/);

  const history = await bearer(request(wa).get('/api/v1/whatsapp/messages'), admin);
  assert.strictEqual(history.body.data[0].status, 'sent');
  assert.strictEqual(history.body.data[0].sent_by_email, admin.email);
});

test('templates: built-ins are edited (time, recipients, text) but not deleted; saved messages come and go', async () => {
  const admin = await asAdmin();
  const { templates } = (await bearer(request(wa).get('/api/v1/whatsapp/templates'), admin)).body.data;
  const followup = templates.find((t) => t.key === 'login_followup_1');
  try {
    const put = await bearer(request(wa).put(`/api/v1/whatsapp/templates/${followup.id}`)
      .send({ enabled: true, send_at: '09:12', send_to: 'both', body: 'Still down: {instances}' }), admin);
    assert.strictEqual(put.status, STATUS.OK, put.text);
    assert.deepStrictEqual([put.body.data.enabled, put.body.data.send_at, put.body.data.send_to], [1, '09:12', 'both']);
    assert.strictEqual((await bearer(request(wa).put(`/api/v1/whatsapp/templates/${followup.id}`).send({ send_at: '9am' }), admin)).status, STATUS.VALIDATION);
    assert.strictEqual((await bearer(request(wa).put(`/api/v1/whatsapp/templates/${followup.id}`).send({ body: '{detail}' }), admin)).status, STATUS.VALIDATION,
      '{detail} only exists for alerts');
    assert.strictEqual((await bearer(request(wa).delete(`/api/v1/whatsapp/templates/${followup.id}`), admin)).status, STATUS.VALIDATION);
    // {instance_name} only in a message that goes to the admin alone
    const named = (body) => bearer(request(wa).put(`/api/v1/whatsapp/templates/${followup.id}`).send(body), admin);
    assert.strictEqual((await named({ body: 'Down: {instance_name}' })).status, STATUS.VALIDATION, "send_to is 'both' here");
    assert.strictEqual((await named({ body: 'Down: {instance_name}', send_to: 'admin' })).status, STATUS.OK);
    assert.strictEqual((await named({ send_to: 'owner' })).status, STATUS.VALIDATION, 'cannot point a named message at owners');
  } finally {
    await db.run('UPDATE whatsapp_templates SET enabled = ?, send_at = ?, send_to = ?, body = ? WHERE id = ?',
      [followup.enabled, followup.send_at, followup.send_to, followup.body, followup.id]);
  }

  const created = await bearer(request(wa).post('/api/v1/whatsapp/templates').send({ name: 'Holiday', body: 'Hi {owner_name}, markets closed tomorrow.' }), admin);
  assert.strictEqual(created.status, STATUS.OK, created.text);
  assert.strictEqual(created.body.data.kind, 'custom');
  assert.strictEqual((await bearer(request(wa).delete(`/api/v1/whatsapp/templates/${created.body.data.id}`), admin)).status, STATUS.OK);
});

test('instance details in the text mean one message per instance; otherwise one per owner', async () => {
  const admin = await asAdmin();
  const a = await makeInstance({ name: 'Kotak', broker: 'kotak', owner_name: 'Ana', whatsapp_phone: '919876543210' });
  const b = await makeInstance({ name: 'Fyers', broker: 'fyers', owner_name: 'Ana', whatsapp_phone: '919876543210' });
  const preview = (body) => bearer(request(wa).post('/api/v1/whatsapp/preview').send({ body, instance_ids: [a.id, b.id] }), admin);

  for (const placeholder of ['{account}', '{broker}', '{host_url}', '{instances}']) {
    const res = (await preview(`Hi {owner_name}: ${placeholder}`)).body.data;
    assert.strictEqual(res.per_instance, true, placeholder);
    assert.strictEqual(res.messages.length, 2, placeholder);
  }
  const split = (await preview('Hi {owner_name}, your {broker} account')).body.data.messages.map((m) => m.body).sort();
  assert.deepStrictEqual(split, ['Hi Ana, your Fyers account', 'Hi Ana, your Kotak account']);
  assert.strictEqual((await preview('{instance_name}')).status, STATUS.VALIDATION, 'internal names are not for owners');

  const together = (await preview('Hi {owner_name}, markets are closed tomorrow ({date}).')).body.data;
  assert.strictEqual(together.per_instance, false);
  assert.strictEqual(together.messages.length, 1);

  const res = await bearer(request(wa).post('/api/v1/whatsapp/send').send({ body: '{broker} subscription is due for renewal', instance_ids: [a.id, b.id] }), admin);
  assert.strictEqual(res.body.data.queued, 2);
  await whatsappOutbox.drain();
  assert.deepStrictEqual(sent.map((m) => m.text).sort(), ['Fyers subscription is due for renewal', 'Kotak subscription is due for renewal']);
  const forKotak = (await bearer(request(wa).get(`/api/v1/whatsapp/messages?instance_id=${a.id}`), admin)).body.data;
  assert.deepStrictEqual(forKotak.map((m) => m.body), ['Kotak subscription is due for renewal'], 'History filters by instance');
});

test('every instance field is available in custom messages, with live figures per instance', async () => {
  const admin = await asAdmin();
  const a = await makeInstance({ broker: 'kotak', owner_name: 'Ana', whatsapp_phone: '919876543210', session_pnl: 1250.5,
    total_pnl: -300, current_balance: 150000, session_max_loss: 2000, is_analyzer_mode: 1, health_status: 'healthy' });
  const b = await makeInstance({ broker: 'deltaexchange', owner_name: 'Ana', whatsapp_phone: '919876543210', session_pnl: 12.25 });
  const { placeholders, help } = (await bearer(request(wa).get('/api/v1/whatsapp/templates'), admin)).body.data;
  for (const key of ['session_pnl', 'total_pnl', 'realized_pnl', 'unrealized_pnl', 'balance', 'session_target', 'session_max_loss', 'mode', 'status']) {
    assert.ok(placeholders.custom.includes(key), key);
    assert.ok(help[key], `${key} has a description`);
  }
  assert.ok(!placeholders.custom.includes('instance_name') && !placeholders.custom.includes('detail'));

  const body = 'Session {session_pnl} | day {total_pnl} | bal {balance} | target {session_target} | cap {session_max_loss} | {mode} | {status}';
  const res = await bearer(request(wa).post('/api/v1/whatsapp/preview').send({ body, instance_ids: [a.id, b.id] }), admin);
  assert.strictEqual(res.status, STATUS.OK, res.text);
  const texts = res.body.data.messages.map((m) => m.body).sort();
  assert.deepStrictEqual(texts, [
    'Session 12.25 | day 0.00 | bal 0.00 | target not set | cap not set | Live | Not reachable',
    'Session ₹1,250.50 | day -₹300.00 | bal ₹1,50,000.00 | target not set | cap ₹2,000.00 | Analyzer | Reachable',
  ]);
});

test('attachments: stored once, sent to every recipient with the text as caption, downloadable from History', async () => {
  const admin = await asAdmin();
  const a = await makeInstance({ owner_name: 'Ana', whatsapp_phone: '919876543210' });
  const b = await makeInstance({ owner_name: 'Sai', whatsapp_phone: '919812345678' });
  const before = fs.existsSync(MEDIA_DIR) ? fs.readdirSync(MEDIA_DIR).length : 0;

  const res = await bearer(request(wa).post('/api/v1/whatsapp/send'), admin)
    .field('body', 'Hi {owner_name}, *statement* attached')
    .field('instance_ids', JSON.stringify([a.id, b.id]))
    .attach('files', Buffer.from('%PDF-1.4 test'), { filename: 'Statement Oct.pdf', contentType: 'application/pdf' })
    .attach('files', Buffer.from([0xff, 0xd8, 0xff, 0xe0]), { filename: 'screen.jpg', contentType: 'image/jpeg' });
  assert.strictEqual(res.status, STATUS.OK, res.text);
  assert.deepStrictEqual([res.body.data.queued, res.body.data.attachments], [2, 2]);
  await whatsappOutbox.drain();

  assert.strictEqual(sent.length, 2);
  assert.deepStrictEqual(sent.map((m) => m.text).sort(), ['Hi Ana, *statement* attached', 'Hi Sai, *statement* attached']);
  for (const m of sent) {
    assert.deepStrictEqual(m.media.map((f) => [f.name, f.mime]), [['Statement Oct.pdf', 'application/pdf'], ['screen.jpg', 'image/jpeg']]);
  }
  assert.strictEqual(sent[0].media[0].file, sent[1].media[0].file, 'one stored copy shared by every recipient');
  assert.strictEqual(fs.readdirSync(MEDIA_DIR).length, before + 2);

  const [row] = (await bearer(request(wa).get('/api/v1/whatsapp/messages'), admin)).body.data;
  const dl = await bearer(request(wa).get(`/api/v1/whatsapp/messages/${row.id}/media/0`), admin).buffer(true);
  assert.strictEqual(dl.status, STATUS.OK);
  assert.match(dl.headers['content-disposition'], /Statement Oct\.pdf/);
  assert.strictEqual(dl.body.toString(), '%PDF-1.4 test');
  assert.strictEqual((await bearer(request(wa).get(`/api/v1/whatsapp/messages/${row.id}/media/9`), admin)).status, STATUS.NOT_FOUND);

  // Text is optional with an attachment; a photo over WhatsApp's 16 MB is refused and not kept
  const onlyFile = await bearer(request(wa).post('/api/v1/whatsapp/send'), admin)
    .field('body', '').field('instance_ids', JSON.stringify([a.id]))
    .attach('files', Buffer.from('hello'), { filename: 'note.txt', contentType: 'text/plain' });
  assert.strictEqual(onlyFile.status, STATUS.OK, onlyFile.text);
  const count = fs.readdirSync(MEDIA_DIR).length;
  const big = await bearer(request(wa).post('/api/v1/whatsapp/send'), admin)
    .field('body', 'x').field('instance_ids', JSON.stringify([a.id]))
    .attach('files', Buffer.alloc(17 * 1024 * 1024), { filename: 'huge.png', contentType: 'image/png' });
  assert.strictEqual(big.status, STATUS.VALIDATION);
  assert.match(big.body.message, /16 MB/);
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(fs.readdirSync(MEDIA_DIR).length, count, 'a refused upload is deleted');
  assert.ok(path.isAbsolute(MEDIA_DIR));
});
