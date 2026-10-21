/**
 * WhatsApp message templates (table whatsapp_templates, seeded by migration 083) and the
 * placeholder renderer. A template is written once and rendered per recipient: an owner gets one
 * message covering all of their instances ({instances} lists them), the admin gets one covering
 * every instance involved.
 *
 * The instance name is the app's internal identifier - owners do not know it. Owners see an
 * instance as "<Broker> - <login URL>"; only the admin's copy carries the name. So {instance_name}
 * is allowed only in a message that goes to the admin alone.
 */
import db from '../core/database.js';
import { ValidationError, NotFoundError } from '../core/errors.js';
import { toISTDate } from '../utils/time.js';
import { isCryptoBroker } from '../utils/broker-type.util.js';

/** Every placeholder, with the description shown on its button. */
export const PLACEHOLDER_HELP = {
  owner_name: "Owner's name (\"there\" when not set)",
  account: 'Broker and login URL, e.g. Kotak - https://...',
  instances: 'One line per instance: broker and login URL',
  broker: 'Broker name',
  host_url: 'Login URL',
  session_pnl: 'P&L of the current session',
  total_pnl: "Today's total P&L",
  realized_pnl: "Today's booked P&L",
  unrealized_pnl: 'Open-position P&L',
  balance: 'Account balance',
  session_target: 'Session target profit',
  session_max_loss: 'Session max loss',
  mode: 'Live or Analyzer',
  status: 'Reachable or Not reachable',
  date: 'Today, e.g. 22 Oct 2026',
  time: 'Time now (IST), e.g. 09:00',
  instance_name: 'Internal instance name - admin-only messages',
  detail: 'What happened - alerts only',
};
// Values that differ per instance: a custom message using any of them goes once per instance
export const PER_INSTANCE = ['account', 'instances', 'broker', 'host_url', 'session_pnl', 'total_pnl', 'realized_pnl',
  'unrealized_pnl', 'balance', 'session_target', 'session_max_loss', 'mode', 'status'];
const COMMON = ['owner_name', ...PER_INSTANCE, 'date', 'time'];
export const PLACEHOLDERS = {
  custom: COMMON, // custom messages go to owners only, and are not about an event
  login: [...COMMON, 'instance_name'],
  alert: [...COMMON, 'instance_name', 'detail'],
};

const BROKER_LABELS = {
  angel: 'Angel One', deltaexchange: 'Delta Exchange', mstock: 'mStock', fivepaisa: '5paisa',
  aliceblue: 'Alice Blue', iifl: 'IIFL', icici: 'ICICI Direct', zerodha: 'Zerodha',
};
export function brokerLabel(broker) {
  const b = String(broker || '').trim();
  return BROKER_LABELS[b.toLowerCase()] || (b ? b[0].toUpperCase() + b.slice(1) : 'Broker');
}

/** How an instance is named in a message: broker + login URL for its owner; internal name + owner for the admin. */
function accountLabel(inst, forAdmin) {
  return forAdmin
    ? `${inst.name}${inst.owner_name ? ` (${inst.owner_name})` : ''} - ${inst.host_url}`
    : `${brokerLabel(inst.broker)} - ${inst.host_url}`;
}
const MAX_BODY = 4000;
const SEND_TO = ['owner', 'admin', 'both'];

export function unknownPlaceholders(body, kind = 'custom') {
  const allowed = new Set(PLACEHOLDERS[kind] || COMMON);
  return [...new Set([...String(body).matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].filter((k) => !allowed.has(k));
}

/** Rupees for Indian brokers; crypto accounts are quoted without a currency sign. */
function money(value, broker) {
  if (value === null || value === undefined || value === '' || Number.isNaN(Number(value))) return '-';
  const n = Number(value);
  const text = Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? '-' : ''}${isCryptoBroker(broker) ? '' : '₹'}${text}`;
}

/**
 * Values for one message. `instances` are the instance rows the message is about; `forAdmin`
 * renders the admin's copy (internal names and owners) instead of an owner's. A per-instance value
 * in a message about several instances reads "Kotak: ₹1,200.00, Fyers: -₹300.00" (internal names
 * in the admin's copy). Figures are the app's latest poll of the broker.
 */
export function messageVars(instances, { forAdmin = false, now = new Date(), extra = {} } = {}) {
  const ist = toISTDate(now);
  const pad = (n) => String(n).padStart(2, '0');
  const each = (fn) => (instances.length === 1
    ? fn(instances[0])
    : instances.map((i) => `${forAdmin ? i.name : brokerLabel(i.broker)}: ${fn(i)}`).join(', '));
  const vars = {
    owner_name: forAdmin ? 'Admin' : instances[0]?.owner_name || 'there',
    account: instances.map((i) => accountLabel(i, forAdmin)).join(', '),
    instances: instances.map((i) => `• ${accountLabel(i, forAdmin)}`).join('\n'),
    instance_name: forAdmin ? instances.map((i) => i.name).join(', ') : '',
    broker: [...new Set(instances.map((i) => brokerLabel(i.broker)))].join(', '),
    host_url: instances.map((i) => i.host_url).join(', '),
    session_pnl: each((i) => money(i.session_pnl, i.broker)),
    total_pnl: each((i) => money(i.total_pnl, i.broker)),
    realized_pnl: each((i) => money(i.realized_pnl, i.broker)),
    unrealized_pnl: each((i) => money(i.unrealized_pnl, i.broker)),
    balance: each((i) => money(i.current_balance, i.broker)),
    session_target: each((i) => (i.session_target_profit == null ? 'not set' : money(i.session_target_profit, i.broker))),
    session_max_loss: each((i) => (i.session_max_loss == null ? 'not set' : money(i.session_max_loss, i.broker))),
    mode: each((i) => (i.is_analyzer_mode ? 'Analyzer' : 'Live')),
    status: each((i) => (i.health_status === 'healthy' ? 'Reachable' : 'Not reachable')),
    date: ist.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }),
    time: `${pad(ist.getHours())}:${pad(ist.getMinutes())}`,
    detail: '',
  };
  // An event can supply a value as of that moment (the session P&L that tripped a cutoff)
  for (const [k, v] of Object.entries(extra)) {
    vars[k] = k === 'session_pnl' && typeof v === 'number' ? money(v, instances[0]?.broker) : v;
  }
  return vars;
}

/**
 * An alert's {detail} is the app's own notification text, which names instances internally (and
 * a kill switch names everyone's). For an owner: their instances become "<Broker> - <URL>", any
 * other instance becomes "another account". Whole-name matches only, longest first, so an instance
 * called "Ana" leaves "Analyzer" alone.
 */
export function ownerDetail(detail, ownInstances, allInstances) {
  const own = new Set(ownInstances.map((i) => i.id));
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let text = String(detail || '');
  for (const inst of [...allInstances].filter((i) => i.name).sort((a, b) => b.name.length - a.name.length)) {
    const label = own.has(inst.id) ? accountLabel(inst, false) : 'another account';
    text = text.replace(new RegExp(`(?<![\\w])${escape(inst.name)}(?![\\w])`, 'g'), label);
  }
  return text;
}

export function render(body, vars) {
  return String(body).replace(/\{(\w+)\}/g, (match, key) => (key in vars ? String(vars[key] ?? '') : match)).trim();
}

/** Group instances by owner phone - one message per person, listing all of their instances. */
export function groupByPhone(instances) {
  const byPhone = new Map();
  for (const inst of instances) {
    if (!inst.whatsapp_phone) continue;
    if (!byPhone.has(inst.whatsapp_phone)) byPhone.set(inst.whatsapp_phone, []);
    byPhone.get(inst.whatsapp_phone).push(inst);
  }
  return byPhone;
}

function validateBody(body, kind, sendTo = 'owner') {
  const text = typeof body === 'string' ? body.trim() : '';
  if (!text) throw new ValidationError('Message text is required');
  if (text.length > MAX_BODY) throw new ValidationError(`Message text is limited to ${MAX_BODY} characters`);
  const unknown = unknownPlaceholders(text, kind);
  if (unknown.length) {
    throw new ValidationError(`Unknown placeholder(s): ${unknown.map((k) => `{${k}}`).join(', ')}. Available: ${PLACEHOLDERS[kind].map((k) => `{${k}}`).join(', ')}`);
  }
  if (sendTo !== 'admin' && /\{instance_name\}/.test(text)) {
    throw new ValidationError('{instance_name} is the internal name, which owners do not know - use {account} (broker and login URL) in messages that go to owners');
  }
  return text;
}

class WhatsAppTemplatesService {
  list() {
    return db.all('SELECT * FROM whatsapp_templates ORDER BY sort_order, id');
  }

  get(key) {
    return db.get('SELECT * FROM whatsapp_templates WHERE key = ?', [key]);
  }

  async getById(id) {
    const row = await db.get('SELECT * FROM whatsapp_templates WHERE id = ?', [id]);
    if (!row) throw new NotFoundError('Template not found');
    return row;
  }

  async createCustom({ name, body }, userId) {
    const label = typeof name === 'string' ? name.trim().slice(0, 80) : '';
    if (!label) throw new ValidationError('Template name is required');
    const text = validateBody(body, 'custom');
    const { lastID } = await db.run(
      `INSERT INTO whatsapp_templates (key, name, kind, body, sort_order, updated_by)
       VALUES (?, ?, 'custom', ?, 2000, ?)`,
      [`custom_${Date.now()}`, label, text, userId ?? null]
    );
    return this.getById(lastID);
  }

  /** Edit text and, for login/alert templates, the automation settings on the same row. */
  async update(id, data, userId) {
    const row = await this.getById(id);
    const sets = {};
    if (data.name !== undefined) {
      const label = String(data.name).trim().slice(0, 80);
      if (!label) throw new ValidationError('Template name is required');
      sets.name = label;
    }
    if (row.kind !== 'custom') {
      if (data.enabled !== undefined) sets.enabled = data.enabled === true || data.enabled === 1 || data.enabled === 'true' ? 1 : 0;
      if (data.send_to !== undefined) {
        if (!SEND_TO.includes(data.send_to)) throw new ValidationError('send_to must be owner, admin or both');
        sets.send_to = data.send_to;
      }
    }
    // Checked against the recipients it will have after this save (an owner must not get {instance_name})
    if (data.body !== undefined || sets.send_to) {
      sets.body = validateBody(data.body ?? row.body, row.kind, row.kind === 'custom' ? 'owner' : sets.send_to || row.send_to);
    }
    if (row.kind === 'login' && data.send_at !== undefined) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(data.send_at))) throw new ValidationError('Time must be HH:MM (24-hour, IST)');
      sets.send_at = data.send_at;
    }
    if (row.kind === 'alert' && data.cooldown_min !== undefined) {
      const n = Number(data.cooldown_min);
      if (!Number.isInteger(n) || n < 0 || n > 1440) throw new ValidationError('Cooldown must be 0-1440 minutes');
      sets.cooldown_min = n;
    }
    const keys = Object.keys(sets);
    if (!keys.length) throw new ValidationError('Nothing to update');
    await db.run(
      `UPDATE whatsapp_templates SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [...keys.map((k) => sets[k]), userId ?? null, id]
    );
    return this.getById(id);
  }

  async deleteCustom(id) {
    const row = await this.getById(id);
    if (row.kind !== 'custom') throw new ValidationError('Built-in templates can be switched off, not deleted');
    await db.run('DELETE FROM whatsapp_templates WHERE id = ?', [id]);
  }
}

export { validateBody };
export default new WhatsAppTemplatesService();
