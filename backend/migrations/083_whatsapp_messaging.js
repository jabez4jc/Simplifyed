/**
 * Migration 083: WhatsApp messaging
 *
 * - instances.owner_name: who the instance belongs to, for {owner_name} in messages.
 * - whatsapp_templates: every message the app sends. kind 'login' rows are the morning login
 *   sequence (sent at send_at to owners of unreachable instances), kind 'alert' rows are sent when
 *   the matching event fires (at most once per cooldown_min per instance), kind 'custom' rows are
 *   saved texts for the Send tab. The text and its automation settings live on one row.
 * - whatsapp_messages: the outbox and history - one row per message, queued then sent or failed.
 */

export const version = '083';
export const name = 'whatsapp_messaging';

const SEEDS = [
  ['login_reminder', 'Login reminder', 'login', 1, 'owner', '09:00', null, 10,
    ['Hi {owner_name},', '', 'Your Simplifyed instance is not reachable:', '{instances}', '',
      "Please log in to Simplifyed to generate today's broker token so trading can run."].join('\n')],
  ['login_followup_1', 'Login follow-up 1', 'login', 0, 'owner', '09:10', null, 20,
    ['Hi {owner_name},', '', 'Reminder: your Simplifyed instance is still not reachable:', '{instances}', '',
      'Please log in to Simplifyed now.'].join('\n')],
  ['login_followup_2', 'Login follow-up 2', 'login', 0, 'owner', '09:14', null, 30,
    ['*Urgent* - {owner_name}, the market opens at 09:15 and your Simplifyed instance is still not reachable:',
      '{instances}', '', 'Trading cannot run until you log in to Simplifyed.'].join('\n')],
  ['login_escalation', 'Login escalation (to admin)', 'login', 0, 'admin', '09:15', null, 40,
    ['*Not logged in at {time}*', '{instances}'].join('\n')],
  ['alert_unhealthy_positions', 'Instance unreachable with open positions', 'alert', 1, 'both', null, 30, 110,
    ['*ALERT* - {account} became unreachable while positions are open.', '{detail}', '',
      'Check the Simplifyed login and the broker at {host_url}.'].join('\n')],
  ['alert_session_cutoff', 'Session target / max loss hit', 'alert', 1, 'both', null, 30, 120,
    ['*ALERT* - {account}: session limit hit, switched to analyzer mode.', '{detail}'].join('\n')],
  ['alert_max_loss', 'Max loss cap reached', 'alert', 1, 'both', null, 30, 130,
    ['*ALERT* - Max loss reached on {account}.', '{detail}'].join('\n')],
  ['alert_exit_failed', 'Exit order failed', 'alert', 1, 'both', null, 30, 140,
    ['*ALERT* - An exit failed on {account}.', '{detail}', '', 'Check the position at the broker.'].join('\n')],
  ['alert_kill_switch', 'Kill switch executed', 'alert', 1, 'both', null, 30, 150,
    ['*KILL SWITCH* executed on {account}.', '{detail}'].join('\n')],
  ['alert_degraded', 'Instance degraded (quotes failing)', 'alert', 1, 'both', null, 180, 160,
    ['*ALERT* - {account} is degraded.', '{detail}'].join('\n')],
  ['alert_roll_blocked', 'Futures roll blocked', 'alert', 1, 'admin', null, 180, 170,
    ['*FUTURES ROLL BLOCKED*', '{detail}'].join('\n')],
];

export async function up(db) {
  const cols = (await db.all('PRAGMA table_info(instances)')).map((c) => c.name);
  if (!cols.includes('owner_name')) {
    await db.run('ALTER TABLE instances ADD COLUMN owner_name TEXT');
  }

  await db.run(`
    CREATE TABLE IF NOT EXISTS whatsapp_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('login', 'alert', 'custom')),
      body TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      send_to TEXT NOT NULL DEFAULT 'owner' CHECK (send_to IN ('owner', 'admin', 'both')),
      send_at TEXT,
      cooldown_min INTEGER,
      last_run_date TEXT,
      sort_order INTEGER NOT NULL DEFAULT 1000,
      updated_by INTEGER,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

  await db.run(`
    CREATE TABLE IF NOT EXISTS whatsapp_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipient TEXT NOT NULL CHECK (recipient IN ('owner', 'admin')),
      phone TEXT,
      instance_ids TEXT,
      template_key TEXT,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed')),
      error TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      sent_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      sent_at DATETIME
    )`);
  await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_status ON whatsapp_messages (status, priority, id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_template ON whatsapp_messages (template_key, created_at)');

  for (const [key, label, kind, enabled, sendTo, sendAt, cooldown, order, body] of SEEDS) {
    await db.run(
      `INSERT OR IGNORE INTO whatsapp_templates (key, name, kind, body, enabled, send_to, send_at, cooldown_min, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [key, label, kind, body, enabled, sendTo, sendAt, cooldown, order]
    );
  }
}

export async function down(db) {
  await db.run('DROP TABLE IF EXISTS whatsapp_messages');
  await db.run('DROP TABLE IF EXISTS whatsapp_templates');
  await db.run('ALTER TABLE instances DROP COLUMN owner_name');
}
