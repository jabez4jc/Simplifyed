import assert from 'assert';
import test, { before, beforeEach, mock } from 'node:test';

import { useTestDb, truncate } from '../helpers/db.js';
import { makeInstance } from '../helpers/fixtures.js';
import db from '../../src/core/database.js';
import whatsappService from '../../src/services/whatsapp.service.js';
import whatsappOutbox from '../../src/services/whatsapp-outbox.service.js';
import marketCalendarService from '../../src/services/market-calendar.service.js';
import loginReminderService from '../../src/services/login-reminder.service.js';
import { notify } from '../../src/services/notify.service.js';
import { render, messageVars, unknownPlaceholders } from '../../src/services/whatsapp-templates.service.js';
import { normalizeInstanceData } from '../../src/utils/instance-validation.util.js';

const WEDNESDAY = new Date('2026-10-21T03:30:00Z'); // 09:00 IST
const SATURDAY = new Date('2026-10-24T03:30:00Z');
const ADMIN_PHONE = '918951708122';

let sent;
let templatesBackup;
before(async () => {
  await useTestDb('login-reminder');
  templatesBackup = await db.all('SELECT * FROM whatsapp_templates');
  mock.method(marketCalendarService, 'getHolidayInfo', async () => null);
  mock.method(whatsappService, 'getStatus', () => ({ status: 'open', phone: ADMIN_PHONE, qr: null }));
  mock.method(whatsappService, 'phone', () => ADMIN_PHONE);
  mock.method(whatsappService, 'sendText', async (phone, text) => {
    if (phone === '910000000000') throw new Error('910000000000 is not on WhatsApp');
    sent.push({ phone, text });
  });
  whatsappOutbox.gap = () => 0;
});
beforeEach(async () => {
  await truncate();
  // whatsapp_templates survives truncate (seeded); undo what a test edited
  for (const t of templatesBackup) {
    await db.run('UPDATE whatsapp_templates SET body = ?, enabled = ?, send_to = ?, send_at = ?, cooldown_min = ?, last_run_date = NULL WHERE id = ?',
      [t.body, t.enabled, t.send_to, t.send_at, t.cooldown_min, t.id]);
  }
  sent = [];
});

const statuses = () => db.all('SELECT recipient, phone, template_key, status, error FROM whatsapp_messages ORDER BY id');

// makeInstance points at a port nothing listens on, so its ping genuinely fails - an instance nobody logged in to.
test('09:00 reminder: one WhatsApp per owner listing all of their unreachable instances', async () => {
  await makeInstance({ name: 'Kotak A', owner_name: 'Rubinson', whatsapp_phone: '919876543210' });
  await makeInstance({ name: 'Fyers B', owner_name: 'Rubinson', whatsapp_phone: '919876543210' });
  await makeInstance({ name: 'No phone' });
  await makeInstance({ name: 'Inactive', whatsapp_phone: '919999999999', is_active: 0 });

  await loginReminderService.tick(WEDNESDAY);
  await whatsappOutbox.drain();

  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].phone, '919876543210');
  assert.match(sent[0].text, /^Hi Rubinson,/);
  assert.strictEqual(sent[0].text.match(/• Zerodha - http:\/\/127\.0\.0\.1/g).length, 2, 'owners see broker + login URL');
  assert.ok(!/Kotak A|Fyers B/.test(sent[0].text), 'never the internal instance name');
  assert.deepStrictEqual((await statuses()).map((m) => m.status), ['sent']);

  // Same minute again: already ran today
  await loginReminderService.tick(WEDNESDAY);
  await whatsappOutbox.drain();
  assert.strictEqual(sent.length, 1);
});

test('steps that are off do not run; escalation goes to the admin with owners named', async () => {
  await makeInstance({ name: 'Kotak A', owner_name: 'Sai', whatsapp_phone: '919876543210' });
  await makeInstance({ name: 'No phone' });

  await loginReminderService.tick(new Date('2026-10-21T03:45:00Z')); // 09:15, escalation still off
  await whatsappOutbox.drain();
  assert.strictEqual(sent.length, 0);

  await db.run("UPDATE whatsapp_templates SET enabled = 1 WHERE key = 'login_escalation'");
  await loginReminderService.tick(new Date('2026-10-21T03:45:00Z'));
  await whatsappOutbox.drain();
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].phone, ADMIN_PHONE);
  assert.match(sent[0].text, /Kotak A \(Sai\)/);
  assert.match(sent[0].text, /No phone/, 'the admin hears about instances without an owner number too');
});

test('weekends skip Indian brokers but not crypto, and a failed send is recorded and notified', async () => {
  await makeInstance({ name: 'Kotak', whatsapp_phone: '919876543210' });
  await makeInstance({ name: 'Delta', broker: 'deltaexchange', whatsapp_phone: '910000000000' });

  await loginReminderService.runStep('login_reminder', SATURDAY);
  await whatsappOutbox.drain();

  assert.deepStrictEqual(await statuses(), [
    { recipient: 'owner', phone: '910000000000', template_key: 'login_reminder', status: 'failed', error: '910000000000 is not on WhatsApp' },
  ]);
  const note = await db.get("SELECT body FROM notifications WHERE title = 'WhatsApp send failed'");
  assert.match(note.body, /not on WhatsApp/);
});

test('alerts: owner + admin, then silenced for the cooldown; switched off means nothing', async () => {
  const inst = await makeInstance({ name: 'Jz Maha', broker: 'fyers', owner_name: 'Maha', whatsapp_phone: '919876543210' });
  const other = await makeInstance({ name: 'Jz Other', owner_name: 'Someone else' });

  await notify('Max loss reached', 'NIFTY on Jz Maha: loss 2100 reached the 2000 max loss (Jz Other fine)', { severity: 'error', alert: 'alert_max_loss', instanceIds: [inst.id] });
  await whatsappOutbox.drain();
  assert.deepStrictEqual(sent.map((s) => s.phone).sort(), [ADMIN_PHONE, '919876543210'].sort());
  const owner = sent.find((s) => s.phone === '919876543210').text;
  const admin = sent.find((s) => s.phone === ADMIN_PHONE).text;
  assert.match(owner, /Max loss reached on Fyers - http/);
  assert.match(owner, /NIFTY on Fyers - http\S+: loss 2100 .*\(another account fine\)/);
  assert.ok(!/Jz /.test(owner), `no internal names reach the owner: ${owner}`);
  assert.match(admin, /Max loss reached on Jz Maha \(Maha\)/);
  assert.match(admin, /NIFTY on Jz Maha: loss 2100/);
  assert.ok(other);

  await notify('Max loss reached', 'again', { alert: 'alert_max_loss', instanceIds: [inst.id] });
  await whatsappOutbox.drain();
  assert.strictEqual(sent.length, 2, 'cooldown holds the repeat');

  await db.run("UPDATE whatsapp_templates SET enabled = 0 WHERE key = 'alert_kill_switch'");
  await notify('Kill switch', 'Executed', { alert: 'alert_kill_switch', instanceIds: [inst.id] });
  await whatsappOutbox.drain();
  assert.strictEqual(sent.length, 2);
  assert.ok(await db.get("SELECT 1 FROM notifications WHERE title = 'Kill switch'"), 'the Notifications page still gets it');
});

test('placeholders render per recipient; unknown ones are reported', () => {
  const inst = { name: 'Jz Kotak 3', owner_name: 'Ana', host_url: 'https://k.example', broker: 'angel' };
  const vars = messageVars([inst], { now: WEDNESDAY });
  assert.strictEqual(render('Hi {owner_name}: {account} ({broker}) at {time} {nope}', vars), 'Hi Ana: Angel One - https://k.example (Angel One) at 09:00 {nope}');
  assert.strictEqual(render('{instance_name}', vars), '', 'an owner copy never carries the internal name');
  assert.strictEqual(render('{account}', messageVars([inst], { forAdmin: true })), 'Jz Kotak 3 (Ana) - https://k.example');
  assert.strictEqual(render('Hi {owner_name}', messageVars([{ ...inst, owner_name: null }])), 'Hi there');
  assert.deepStrictEqual(unknownPlaceholders('{owner_name} {detail} {instance_name} {nope}', 'custom'), ['detail', 'instance_name', 'nope']);
  assert.deepStrictEqual(unknownPlaceholders('{owner_name} {detail}', 'alert'), []);
});

test('WhatsApp numbers are stored as digits with country code', () => {
  assert.strictEqual(normalizeInstanceData({ whatsapp_phone: '+91 98765-43210' }, true).whatsapp_phone, '919876543210');
  assert.strictEqual(normalizeInstanceData({ whatsapp_phone: '9876543210' }, true).whatsapp_phone, '919876543210');
  assert.strictEqual(normalizeInstanceData({ whatsapp_phone: '' }, true).whatsapp_phone, null);
  assert.throws(() => normalizeInstanceData({ whatsapp_phone: '12345' }, true), /validation failed/);
});
