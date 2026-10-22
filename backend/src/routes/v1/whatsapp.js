/**
 * WhatsApp page: connection, sending, templates/automations and history. Admins only - a hard
 * role check, not a grantable permission: whoever controls this messages every instance owner
 * from the linked account.
 */
import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import db from '../../core/database.js';
import { requireAuth, requireAdmin } from '../../middleware/auth.js';
import { ValidationError, NotFoundError } from '../../core/errors.js';
import whatsappService, { MEDIA_DIR, mediaKind, INLINE_MAX_BYTES } from '../../services/whatsapp.service.js';
import whatsappOutbox from '../../services/whatsapp-outbox.service.js';
import whatsappTemplates, {
  PLACEHOLDERS, PLACEHOLDER_HELP, PER_INSTANCE, messageVars, render, groupByPhone, validateBody,
} from '../../services/whatsapp-templates.service.js';
import loginReminderService from '../../services/login-reminder.service.js';
import { normalizeInstanceData } from '../../utils/instance-validation.util.js';

const router = express.Router();

// Attachments: up to 10 files, 90 MB each (WhatsApp takes documents far larger, but the request
// must pass Cloudflare's 100 MB upload cap); photos, videos and audio that play inline are capped
// at WhatsApp's 16 MB below. Stored under a random name - the original name only travels as the
// document's file name.
const MAX_FILES = 10;
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => fs.mkdir(MEDIA_DIR, { recursive: true }, (err) => cb(err, MEDIA_DIR)),
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase().replace(/[^.\w]/g, '')}`),
  }),
  limits: { fileSize: 90 * 1024 * 1024, files: MAX_FILES },
});
const removeUploads = (files = []) => files.forEach((f) => fs.rm(f.path, { force: true }, () => {}));
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
async function buildMessages(body, instanceIds, { attachments = false } = {}) {
  // With attachments the text is optional (it becomes the caption)
  const text = attachments && !String(body ?? '').trim() ? '' : validateBody(body, 'custom');
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

router.post('/preview', wrap(async (req, res) => ok(res, await buildMessages(req.body?.body, req.body?.instance_ids,
  { attachments: Boolean(req.body?.attachments) }))));

/** JSON, or multipart with `files` (instance_ids then arrives as a JSON string). */
router.post('/send', (req, res, next) => upload.array('files', MAX_FILES)(req, res, (err) => {
  if (err instanceof multer.MulterError) {
    return next(new ValidationError(err.code === 'LIMIT_FILE_SIZE' ? 'Each file must be under 90 MB'
      : err.code === 'LIMIT_FILE_COUNT' ? `At most ${MAX_FILES} files per message` : err.message));
  }
  return next(err);
}), wrap(async (req, res) => {
  const files = req.files || [];
  try {
    const tooBig = files.find((f) => mediaKind(f.mimetype) !== 'document' && f.size > INLINE_MAX_BYTES);
    if (tooBig) throw new ValidationError(`${tooBig.originalname}: photos, videos and audio are limited to 16 MB by WhatsApp - send it as a smaller file`);
    let instanceIds = req.body?.instance_ids;
    if (typeof instanceIds === 'string') {
      try { instanceIds = JSON.parse(instanceIds); } catch { instanceIds = []; }
    }
    const { messages, skipped } = await buildMessages(req.body?.body, instanceIds, { attachments: files.length > 0 });
    if (!messages.length) throw new ValidationError('None of the selected instances has an owner WhatsApp number');
    if (whatsappService.getStatus().status !== 'open') throw new ValidationError('WhatsApp is not connected');
    const media = files.map((f) => ({ file: f.filename, name: f.originalname.slice(0, 200), mime: f.mimetype, size: f.size }));
    const ids = await whatsappOutbox.enqueue(messages.map((m) => ({
      recipient: 'owner', phone: m.phone, instanceIds: m.instanceIds, templateKey: req.body?.template_key || null,
      body: m.body, sentBy: req.user.id, media,
    })));
    ok(res, { queued: ids.length, skipped, attachments: media.length });
  } catch (err) {
    removeUploads(files);
    throw err;
  }
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

/** Download an attachment of a sent message (History). */
router.get('/messages/:id/media/:index', wrap(async (req, res) => {
  const row = await db.get('SELECT media FROM whatsapp_messages WHERE id = ?', [Number(req.params.id)]);
  const item = row?.media ? JSON.parse(row.media)[Number(req.params.index)] : null;
  const file = item && path.join(MEDIA_DIR, path.basename(item.file));
  if (!file || !fs.existsSync(file)) throw new NotFoundError('Attachment no longer available');
  res.download(file, item.name);
}));

export default router;
