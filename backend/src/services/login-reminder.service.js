/**
 * Morning OpenAlgo login sequence. OpenAlgo's broker session expires overnight, and an instance
 * stays unreachable until its owner logs in and the broker issues the day's token.
 *
 * Each enabled 'login' template (reminder, follow-ups, escalation - edited on the WhatsApp page)
 * runs once a day at its send_at time (IST): the active instances are pinged afresh, so an owner
 * who has logged in since the last step hears nothing more, and the ones still unreachable get the
 * template - one message per owner, and/or one summary to the admin, per the template's send_to.
 * Indian-broker instances are skipped on weekends and NSE holidays; crypto runs daily.
 */
import cron from 'node-cron';
import db from '../core/database.js';
import { log } from '../core/logger.js';
import instanceService from './instance.service.js';
import instanceHealthCheckService from './instance-health-check.service.js';
import marketCalendarService from './market-calendar.service.js';
import whatsappTemplates, { messageVars, render, groupByPhone } from './whatsapp-templates.service.js';
import whatsappOutbox from './whatsapp-outbox.service.js';
import { notify } from './notify.service.js';
import { toISTDate } from '../utils/time.js';
import { isCryptoBroker } from '../utils/broker-type.util.js';

/** Weekday and not an NSE holiday. An unknown calendar counts as a trading day - better one stray reminder than none. */
async function isIndianTradingDay(now) {
  const day = toISTDate(now).getDay();
  if (day === 0 || day === 6) return false;
  const holiday = await marketCalendarService.getHolidayInfo(now);
  return !holiday?.closedExchanges?.has('NSE');
}

function istClock(now) {
  const d = toISTDate(now);
  const pad = (n) => String(n).padStart(2, '0');
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, hhmm: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}

class LoginReminderService {
  start() {
    // Every minute: times are edited in the app, so there is no fixed cron per step to reschedule.
    this.cron = cron.schedule('0 * * * * *', () => this.tick().catch((err) => log.error('login_reminder_failed', err)), {
      timezone: 'Asia/Kolkata',
    });
    log.info('Login reminder scheduler started');
  }

  stop() {
    this.cron?.stop();
  }

  /** Run every enabled login step due this minute that has not run today. */
  async tick(now = new Date()) {
    // Also the outbox's sweep: sends anything left queued, and fails what waited too long
    whatsappOutbox.drain();
    const { date, hhmm } = istClock(now);
    const due = await db.all(
      `SELECT * FROM whatsapp_templates
       WHERE kind = 'login' AND enabled = 1 AND send_at = ? AND (last_run_date IS NULL OR last_run_date <> ?)
       ORDER BY sort_order`,
      [hhmm, date]
    );
    for (const template of due) {
      await db.run('UPDATE whatsapp_templates SET last_run_date = ? WHERE id = ?', [date, template.id]);
      await this.runStep(template, now);
    }
  }

  /**
   * One step of the sequence (also the "Run now" button). Pings, then queues the template's
   * messages for the instances that are unreachable.
   * @returns {Promise<{unreachable: string[], queued: number}>}
   */
  async runStep(templateOrKey, now = new Date(), { sentBy = null } = {}) {
    const template = typeof templateOrKey === 'string' ? await whatsappTemplates.get(templateOrKey) : templateOrKey;
    const toOwners = template.send_to !== 'admin';
    const toAdmin = template.send_to !== 'owner';

    const tradingDay = await isIndianTradingDay(now);
    const candidates = (await instanceService.getAllInstances({ is_active: true }))
      .filter((i) => tradingDay || isCryptoBroker(i.broker))
      .filter((i) => toAdmin || i.whatsapp_phone);

    const unreachable = [];
    for (const inst of candidates) {
      let healthy = false;
      try {
        const checked = await instanceHealthCheckService.updateHealthStatus(inst.id, { force: true });
        healthy = checked?.health_status === 'healthy';
      } catch (err) {
        log.warn('login_reminder_ping_failed', { instanceId: inst.id, error: err.message });
      }
      if (!healthy) unreachable.push({ ...inst, health_status: 'unhealthy' });
    }

    const messages = [];
    if (toOwners) {
      for (const [phone, list] of groupByPhone(unreachable)) {
        messages.push({ recipient: 'owner', phone, instanceIds: list.map((i) => i.id), templateKey: template.key,
          body: render(template.body, messageVars(list, { now })), sentBy });
      }
    }
    if (toAdmin && unreachable.length) {
      messages.push({ recipient: 'admin', instanceIds: unreachable.map((i) => i.id), templateKey: template.key,
        body: render(template.body, messageVars(unreachable, { now, forAdmin: true })), sentBy });
    }
    await whatsappOutbox.enqueue(messages);

    const names = unreachable.map((i) => i.name);
    if (messages.length) {
      await notify(template.name, `${names.length} instance(s) not reachable (${names.join(', ')}); ${messages.length} WhatsApp message(s) queued`, { severity: 'warn' });
    }
    log.info('login_step_done', { step: template.key, checked: candidates.length, unreachable: names.length, queued: messages.length });
    return { unreachable: names, queued: messages.length };
  }
}

export default new LoginReminderService();
