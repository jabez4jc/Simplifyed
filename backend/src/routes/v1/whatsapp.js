/**
 * WhatsApp page: connection, sending, templates/automations and history. Admins only - a hard
 * role check, not a grantable permission: whoever controls this messages every instance owner
 * from the linked account.
 */
import express from 'express';
import db from '../../core/database.js';
import { requireAuth, requireAdmin } from '../../middleware/auth.js';
import { ValidationError } from '../../core/errors.js';
import whatsappService from '../../services/whatsapp.service.js';
import whatsappOutbox from '../../services/whatsapp-outbox.service.js';
import whatsappTemplates, {
  PLACEHOLDERS, PLACEHOLDER_HELP, PER_INSTANCE, messageVars, render, groupByPhone, validateBody,
} from '../../services/whatsapp-templates.service.js';
import loginReminderService from '../../services/login-reminder.service.js';
import { normalizeInstanceData } from '../../utils/instance-validation.util.js';

const router = express.Router();
const PER_INSTANCE_PLACEHOLDERS = new RegExp(`\\{(${PER_INSTANCE.join('|')})\\}`);
router.use(requireAuth, requireAdmin);

const ok = (res, data) => res.json({ status: 'success', data });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

// ── Connection ────────────────────────────────────────────
router.get('/status', (req, res) => ok(res, whatsappService.getStatus()));
router.post('/connect', wrap(async (req, res) => { await whatsappService.start(); ok(res, whatsappService.getStatus()); }));
router.post('/logout', wrap(async (req, res) => { await whatsappService.logout(); ok(res, whatsappService.getStatus()); }));

// ── Recipients and sending ────────────────────────────────
router.get('/recipients', wrap(async (req, res) => {
  ok(res, await db.all(
    `SELECT id, name, broker, host_url, is_active, health_status, owner_name, whatsapp_phone
     FROM instances ORDER BY is_active DESC, name COLLATE NOCASE`
  ));
}));

/**
 * Selected instances -> rendered messages. A text that refers to instance details
 * (any PER_INSTANCE placeholder - account, broker, P&L, balance...) goes once per instance, so an owner of two
 * selected instances gets two messages, each about one; any other text goes once per owner.
 * Instances without a number are skipped.
 */
async function buildMessages(body, instanceIds) {
  const text = validateBody(body, 'custom');
  const ids = Array.isArray(instanceIds) ? [...new Set(instanceIds.map(Number).filter(Number.isInteger))] : [];
  if (!ids.length) throw new ValidationError('Select at least one instance');
  const instances = await db.all(`SELECT * FROM instances WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  const perInstance = PER_INSTANCE_PLACEHOLDERS.test(text);
  const groups = perInstance
    ? instances.filter((i) => i.whatsapp_phone).map((i) => [i.whatsapp_phone, [i]])
    : [...groupByPhone(instances)];
  return {
    per_instance: perInstance,
    skipped: instances.filter((i) => !i.whatsapp_phone).map((i) => i.name),
    messages: groups.map(([phone, list]) => ({
      phone,
      instanceIds: list.map((i) => i.id),
      instances: list.map((i) => i.name),
      body: render(text, messageVars(list)),
    })),
  };
}

router.post('/preview', wrap(async (req, res) => ok(res, await buildMessages(req.body?.body, req.body?.instance_ids))));

router.post('/send', wrap(async (req, res) => {
  const { messages, skipped } = await buildMessages(req.body?.body, req.body?.instance_ids);
  if (!messages.length) throw new ValidationError('None of the selected instances has an owner WhatsApp number');
  if (whatsappService.getStatus().status !== 'open') throw new ValidationError('WhatsApp is not connected');
  const ids = await whatsappOutbox.enqueue(messages.map((m) => ({
    recipient: 'owner', phone: m.phone, instanceIds: m.instanceIds, templateKey: req.body?.template_key || null,
    body: m.body, sentBy: req.user.id,
  })));
  ok(res, { queued: ids.length, skipped });
}));

/** A test message to any number - checks the link without involving an instance. */
router.post('/test', wrap(async (req, res) => {
  const { whatsapp_phone: phone } = normalizeInstanceData({ whatsapp_phone: req.body?.phone ?? '' }, true);
  if (!phone) throw new ValidationError('phone is required');
  await whatsappService.sendText(phone, req.body?.message || 'Simplifyed: test message - WhatsApp messages are working.');
  ok(res, { to: phone });
}));

// ── Templates and automations ─────────────────────────────
router.get('/templates', wrap(async (req, res) => ok(res, {
  templates: await whatsappTemplates.list(), placeholders: PLACEHOLDERS, help: PLACEHOLDER_HELP, per_instance: PER_INSTANCE,
})));
router.post('/templates', wrap(async (req, res) => ok(res, await whatsappTemplates.createCustom(req.body || {}, req.user.id))));
router.put('/templates/:id', wrap(async (req, res) => ok(res, await whatsappTemplates.update(Number(req.params.id), req.body || {}, req.user.id))));
router.delete('/templates/:id', wrap(async (req, res) => { await whatsappTemplates.deleteCustom(Number(req.params.id)); ok(res, null); }));

/** Run one login step now (pings, then messages owners of unreachable instances). */
router.post('/templates/:id/run', wrap(async (req, res) => {
  const template = await whatsappTemplates.getById(Number(req.params.id));
  if (template.kind !== 'login') throw new ValidationError('Only login steps can be run on demand');
  ok(res, await loginReminderService.runStep(template, new Date(), { sentBy: req.user.id }));
}));

// ── History ───────────────────────────────────────────────
router.get('/messages', wrap(async (req, res) => ok(res, await whatsappOutbox.history(req.query.limit, req.query.instance_id))));

export default router;
