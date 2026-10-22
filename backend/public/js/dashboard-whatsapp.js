/**
 * Simplifyed Admin V2 - Dashboard: WhatsApp view (admins only).
 * Tabs: Send (custom messages to instance owners), Automations (login sequence, alerts, saved
 * messages), History (the outbox), Connection (link WhatsApp by QR).
 */

const WA_TABS = [
  ['send', 'Send'],
  ['automations', 'Automations'],
  ['history', 'History'],
  ['connection', 'Connection'],
];
const WA_SEND_TO = [['owner', 'Owner'], ['admin', 'Admin (linked number)'], ['both', 'Owner + admin']];
// Mirrors mediaKind in whatsapp.service.js: what plays inline (16 MB cap) vs goes as a document
const WA_INLINE_MAX = 16 * 1024 * 1024;
const WA_FILE_MAX = 90 * 1024 * 1024;
function waMediaKind(type) {
  const m = String(type || '').toLowerCase();
  if (m === 'image/jpeg' || m === 'image/png') return 'photo';
  if (m === 'video/mp4' || m === 'video/3gpp') return 'video';
  if (/^audio\/(aac|mp4|mpeg|mp3|amr|ogg|opus|x-m4a)$/.test(m)) return 'audio';
  return 'document';
}
const waSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

const WA_STYLES = [['*', 'Bold', 'font-weight:700'], ['_', 'Italic', 'font-style:italic'], ['~', 'Strikethrough', 'text-decoration:line-through'], ['```', 'Monospace', 'font-family:monospace']];

/**
 * A message as WhatsApp will show it: *bold*, _italic_, ~strike~, ```monospace```, `code` and
 * "> " quotes. Escapes first, so only the formatting becomes markup. Like WhatsApp, a marker only
 * counts against a non-space character and not inside a word (snake_case stays as typed).
 */
function waFormatHTML(text) {
  const blocks = [];
  const keep = (html) => `\u0000${blocks.push(html) - 1}\u0000`;
  let s = Utils.escapeHTML(text)
    .replace(/```([\s\S]+?)```/g, (m, code) => keep(`<code style="font-family:monospace">${code}</code>`))
    .replace(/`([^`\n]+)`/g, (m, code) => keep(`<code style="font-family:monospace;background:rgba(127,127,127,.2);padding:0 3px;border-radius:3px">${code}</code>`));
  for (const [mark, tag] of [['\\*', 'strong'], ['_', 'em'], ['~', 's']]) {
    const re = new RegExp(`(^|[^\\w])${mark}(?=\\S)([^\\n]*?\\S)${mark}(?!\\w)`, 'g');
    s = s.replace(re, (m, pre, inner) => `${pre}<${tag}>${inner}</${tag}>`);
  }
  s = s.split('\n').map((line) => (line.startsWith('&gt; ')
    ? `<span style="display:inline-block;width:100%;border-left:3px solid rgba(127,127,127,.6);padding-left:8px">${line.slice(5)}</span>`
    : line)).join('\n');
  return s.replace(/\u0000(\d+)\u0000/g, (m, i) => blocks[Number(i)]);
}

Object.defineProperties(DashboardApp.prototype, Object.getOwnPropertyDescriptors(class {
  async renderWhatsAppView() {
    this.wa = this.wa || { tab: 'send', selected: new Set() };
    document.getElementById('content-area').innerHTML = `
      <div class="space-y-4">
        <div class="flex flex-wrap gap-2" role="tablist">
          ${WA_TABS.map(([id, label]) => `
            <button class="btn btn-sm ${this.wa.tab === id ? 'btn-primary' : 'btn-neutral btn-outline'}" role="tab"
                    aria-selected="${this.wa.tab === id}" onclick="app.switchWaTab('${id}')">${label}</button>`).join('')}
        </div>
        <div id="wa-tab"></div>
      </div>`;
    await this.renderWaTab();
  }

  async switchWaTab(tab) {
    this.wa.tab = tab;
    await this.renderWhatsAppView();
  }

  async renderWaTab() {
    const el = document.getElementById('wa-tab');
    clearTimeout(this.waPoll);
    try {
      if (this.wa.tab === 'send') await this.renderWaSend(el);
      else if (this.wa.tab === 'automations') await this.renderWaAutomations(el);
      else if (this.wa.tab === 'history') await this.renderWaHistory(el);
      else await this.renderWaConnection(el);
    } catch (error) {
      el.innerHTML = `<p class="text-error text-sm">${Utils.escapeHTML(error.message)}</p>`;
    }
  }

  async loadWaTemplates() {
    const data = (await api.request('/whatsapp/templates')).data;
    this.wa.templates = data.templates;
    this.wa.placeholders = data.placeholders;
    this.wa.help = data.help || {};
    this.wa.perInstance = new RegExp(`\\{(${(data.per_instance || []).join('|')})\\}`);
    return data;
  }

  waChips(kind, targetId) {
    const styles = WA_STYLES.map(([mark, label, css], i) =>
      `<button type="button" class="btn btn-xs btn-neutral btn-outline" style="text-transform:none" title="${label}" aria-label="${label}"
               onclick="app.wrapWaSelection('${targetId}', ${i})"><span style="${css}">${label === 'Monospace' ? '&lt;/&gt;' : label[0]}</span></button>`).join('');
    return `<div class="flex flex-wrap gap-1 mt-1">${styles}<span class="mx-1"></span>${(this.wa.placeholders[kind] || []).map((p) =>
      `<button type="button" class="btn btn-xs btn-neutral btn-outline" style="text-transform:none" title="${Utils.escapeHTML(this.wa.help[p] || '')}"
               onclick="app.insertWaPlaceholder('${targetId}', '${p}')">{${p}}</button>`).join('')}</div>`;
  }

  /** Wrap the selected text in a WhatsApp formatting marker (or insert an empty pair at the cursor). */
  wrapWaSelection(targetId, styleIndex) {
    const ta = document.getElementById(targetId);
    if (!ta) return;
    const mark = WA_STYLES[styleIndex][0];
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? start;
    // WhatsApp ignores a marker next to a space, so keep surrounding spaces outside it
    const picked = ta.value.slice(start, end);
    const lead = picked.match(/^\s*/)[0];
    const trail = picked.slice(lead.length).match(/\s*$/)[0];
    const core = picked.slice(lead.length, picked.length - trail.length);
    ta.value = `${ta.value.slice(0, start)}${lead}${mark}${core}${mark}${trail}${ta.value.slice(end)}`;
    ta.focus();
    const at = start + lead.length + mark.length;
    ta.selectionStart = at;
    ta.selectionEnd = at + core.length;
  }

  insertWaPlaceholder(targetId, key) {
    const ta = document.getElementById(targetId);
    if (!ta) return;
    const at = ta.selectionStart ?? ta.value.length;
    ta.value = `${ta.value.slice(0, at)}{${key}}${ta.value.slice(ta.selectionEnd ?? at)}`;
    ta.focus();
    ta.selectionStart = ta.selectionEnd = at + key.length + 2;
  }

  // ── Send ────────────────────────────────────────────────
  async renderWaSend(el) {
    const [recipients] = await Promise.all([api.request('/whatsapp/recipients').then((r) => r.data), this.loadWaTemplates()]);
    this.wa.recipients = recipients;
    const custom = this.wa.templates.filter((t) => t.kind === 'custom');
    const esc = Utils.escapeHTML;
    el.innerHTML = `
      <div class="card"><div class="p-4 space-y-3">
        <div class="flex flex-wrap gap-2 items-center">
          <span class="text-sm font-semibold">Recipients</span>
          <button class="btn btn-xs btn-neutral btn-outline" onclick="app.selectWaRecipients('all')">All with a number</button>
          <button class="btn btn-xs btn-neutral btn-outline" onclick="app.selectWaRecipients('unreachable')">Unreachable now</button>
          <button class="btn btn-xs btn-neutral btn-outline" onclick="app.selectWaRecipients('none')">Clear</button>
          <select class="form-input" style="width:auto" aria-label="Select an owner" onchange="app.selectWaOwner(this.value)">
            <option value="">Select one owner...</option>
            ${[...new Map(recipients.filter((r) => r.whatsapp_phone).map((r) => [r.whatsapp_phone, r])).values()]
              .map((r) => `<option value="${esc(r.whatsapp_phone)}">${esc(r.owner_name || r.name)} (+${esc(r.whatsapp_phone)})</option>`).join('')}
          </select>
          <span class="text-xs text-neutral-600" id="wa-selected-count"></span>
        </div>
        <div class="overflow-x-auto"><table class="table table-sm w-full">
          <thead><tr><th></th><th>Instance</th><th>Owner</th><th>WhatsApp</th><th>Broker</th><th>Health</th></tr></thead>
          <tbody>${recipients.map((r) => `
            <tr class="${r.is_active ? '' : 'opacity-60'}">
              <td><input type="checkbox" class="form-checkbox wa-recipient" value="${r.id}" aria-label="Select ${esc(r.name)}"
                   ${r.whatsapp_phone ? '' : 'disabled title="No WhatsApp number - add one by editing the instance"'}
                   ${this.wa.selected.has(r.id) ? 'checked' : ''} onchange="app.updateWaSelection()"></td>
              <td>${esc(r.name)}${r.is_active ? '' : ' <span class="text-xs">(inactive)</span>'}</td>
              <td>${esc(r.owner_name || '-')}</td>
              <td>${r.whatsapp_phone ? `+${esc(r.whatsapp_phone)}` : '<span class="text-neutral-500">none</span>'}</td>
              <td>${esc(r.broker || '')}</td>
              <td><span class="badge ${r.health_status === 'healthy' ? 'badge-success' : 'badge-error'}">${esc(r.health_status || 'unknown')}</span></td>
            </tr>`).join('')}</tbody>
        </table></div>
      </div></div>

      <div class="card"><div class="p-4 space-y-3">
        <div class="flex flex-wrap gap-2 items-center">
          <label class="text-sm font-semibold" for="wa-template">Message</label>
          <select id="wa-template" class="form-input" style="max-width:20rem" onchange="app.loadWaTemplateIntoBody()">
            <option value="">Start from a saved message...</option>
            ${custom.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}
          </select>
        </div>
        <textarea id="wa-body" class="form-input w-full" rows="7" maxlength="4000"
                  placeholder="Hi {owner_name}, ...">${esc(this.wa.draft || '')}</textarea>
        <p class="text-xs text-neutral-600">Placeholders are filled in per recipient (hover one to see what it holds; P&amp;L and balance are the latest figures the app has polled). Instance details send one message per instance. Select text and use B / I / S / &lt;/&gt; to format it; Preview shows it as WhatsApp will.</p>
        ${this.waChips('custom', 'wa-body')}
        <div>
          <label class="btn btn-neutral btn-outline btn-sm" style="cursor:pointer">
            Attach files
            <input type="file" multiple class="hidden" onchange="app.addWaFiles(this)" aria-label="Attach files">
          </label>
          <span class="text-xs text-neutral-600 ml-2">Up to 10 files: photos (JPG/PNG), videos (MP4), audio up to 16 MB; any other file - PDF, TXT, Excel, screenshots in other formats... - goes as a document, up to 90 MB.</span>
          <div id="wa-files" class="mt-2"></div>
        </div>
        <div class="flex flex-wrap gap-2">
          <button class="btn btn-neutral btn-outline btn-sm" onclick="app.previewWaMessage()">Preview</button>
          <button class="btn btn-buy btn-sm" onclick="app.sendWaMessage()">Send</button>
          <button class="btn btn-neutral btn-outline btn-sm" onclick="app.saveWaCustomTemplate()">Save as saved message</button>
        </div>
        <div id="wa-preview"></div>
      </div></div>`;
    this.updateWaSelection();
    this.renderWaFiles();
  }

  updateWaSelection() {
    this.wa.selected = new Set([...document.querySelectorAll('.wa-recipient:checked')].map((c) => Number(c.value)));
    const owners = new Set(this.wa.recipients.filter((r) => this.wa.selected.has(r.id)).map((r) => r.whatsapp_phone));
    const count = document.getElementById('wa-selected-count');
    if (count) count.textContent = `${this.wa.selected.size} instance(s), ${owners.size} owner(s) selected`;
  }

  selectWaRecipients(mode) {
    document.querySelectorAll('.wa-recipient').forEach((c) => {
      if (c.disabled) return;
      const r = this.wa.recipients.find((x) => x.id === Number(c.value));
      c.checked = mode === 'all' ? Boolean(r.is_active) : mode === 'unreachable' ? Boolean(r.is_active) && r.health_status !== 'healthy' : false;
    });
    this.updateWaSelection();
  }

  /** Tick exactly one owner's instances (every instance carrying that WhatsApp number). */
  selectWaOwner(phone) {
    if (!phone) return;
    document.querySelectorAll('.wa-recipient').forEach((c) => {
      c.checked = !c.disabled && this.wa.recipients.find((x) => x.id === Number(c.value))?.whatsapp_phone === phone;
    });
    this.updateWaSelection();
  }

  /** From the Instances page: open Send with this instance's owner selected. */
  async messageInstanceOwner(instanceId) {
    this.wa = { ...(this.wa || {}), tab: 'send', selected: new Set([instanceId]) };
    this.switchView('whatsapp', { forceReload: true });
  }

  loadWaTemplateIntoBody() {
    const id = Number(document.getElementById('wa-template').value);
    const t = this.wa.templates.find((x) => x.id === id);
    if (t) document.getElementById('wa-body').value = t.body;
  }

  addWaFiles(input) {
    this.wa.files = this.wa.files || [];
    for (const f of input.files) {
      const kind = waMediaKind(f.type);
      if (this.wa.files.length >= 10) { Utils.showToast('At most 10 files per message', 'warning'); break; }
      if (f.size > WA_FILE_MAX || (kind !== 'document' && f.size > WA_INLINE_MAX)) {
        Utils.showToast(`${f.name} is too large (${waSize(f.size)}; ${kind === 'document' ? '90' : '16'} MB max for a ${kind})`, 'error', 5000);
        continue;
      }
      this.wa.files.push(f);
    }
    input.value = '';
    this.renderWaFiles();
  }

  removeWaFile(index) {
    this.wa.files.splice(index, 1);
    this.renderWaFiles();
  }

  renderWaFiles() {
    const el = document.getElementById('wa-files');
    if (!el) return;
    const esc = Utils.escapeHTML;
    el.innerHTML = (this.wa.files || []).map((f, i) => `
      <div class="flex items-center gap-2 text-sm">
        <span class="badge">${waMediaKind(f.type)}</span>
        <span style="overflow-wrap:anywhere">${esc(f.name)}</span>
        <span class="text-xs text-neutral-600">${waSize(f.size)}</span>
        <button type="button" class="btn btn-xs btn-neutral btn-outline" onclick="app.removeWaFile(${i})" aria-label="Remove ${esc(f.name)}">Remove</button>
      </div>`).join('');
  }

  /** Attachments as the preview shows them: photo thumbnails (data: URLs - the CSP allows no blob: images), a chip for the rest. */
  async waFilesPreviewHTML() {
    const esc = Utils.escapeHTML;
    const asDataUrl = (f) => new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve('');
      reader.readAsDataURL(f);
    });
    const parts = await Promise.all((this.wa.files || []).map(async (f) => (waMediaKind(f.type) === 'photo'
      ? `<img src="${await asDataUrl(f)}" alt="${esc(f.name)}" style="max-height:120px;max-width:180px;border-radius:6px">`
      : `<span class="badge" style="text-transform:none">${waMediaKind(f.type)}: ${esc(f.name)}</span>`)));
    return `<div class="flex flex-wrap gap-2 mb-1">${parts.join('')}</div>`;
  }

  waPayload() {
    this.wa.draft = document.getElementById('wa-body').value;
    const templateId = Number(document.getElementById('wa-template').value);
    return {
      body: this.wa.draft,
      instance_ids: [...this.wa.selected],
      template_key: this.wa.templates.find((t) => t.id === templateId)?.key || null,
      attachments: (this.wa.files || []).length > 0,
    };
  }

  async previewWaMessage() {
    const out = document.getElementById('wa-preview');
    try {
      const { messages, skipped, per_instance: perInstance } = (await api.request('/whatsapp/preview', { method: 'POST', body: this.waPayload() })).data;
      const esc = Utils.escapeHTML;
      const filesHtml = this.wa.files?.length ? await this.waFilesPreviewHTML() : '';
      out.innerHTML = `
        <p class="text-sm font-semibold">${messages.length} message(s) will be sent${skipped.length ? ` - skipped (no number): ${esc(skipped.join(', '))}` : ''}</p>
        <p class="text-xs text-neutral-600">${perInstance
          ? 'The text refers to instance details (account, broker, P&L, balance, mode...), so each instance gets its own message - an owner of two selected instances receives two.'
          : 'One message per owner.'}</p>
        ${messages.slice(0, 5).map((m) => `
          <div class="border border-base-300 rounded-lg p-3 mt-2">
            <div class="text-xs text-neutral-600">To +${esc(m.phone)} - ${esc(m.instances.join(', '))}</div>
            ${filesHtml}
            <div class="text-sm whitespace-pre-wrap mt-1" style="overflow-wrap:anywhere">${waFormatHTML(m.body)}</div>
          </div>`).join('')}
        ${messages.length > 5 ? `<p class="text-xs text-neutral-600 mt-1">...and ${messages.length - 5} more</p>` : ''}`;
    } catch (error) {
      out.innerHTML = `<p class="text-error text-sm">${Utils.escapeHTML(error.message)}</p>`;
    }
  }

  async sendWaMessage() {
    const payload = this.waPayload();
    const chosen = this.wa.recipients.filter((r) => this.wa.selected.has(r.id) && r.whatsapp_phone);
    const owners = new Set(chosen.map((r) => r.whatsapp_phone));
    // Same rule as the server: instance details in the text mean one message per instance
    const perInstance = this.wa.perInstance.test(payload.body);
    const count = perInstance ? chosen.length : owners.size;
    const files = this.wa.files || [];
    if (!confirm(`Send ${count} WhatsApp message(s) to ${owners.size} owner(s)${files.length ? `, each with ${files.length} attachment(s)` : ''}?${perInstance && count > owners.size
      ? '\n\nThe text refers to instance details, so an owner of several selected instances gets one message per instance.' : ''}`)) return;
    let body = payload;
    if (files.length) {
      body = new FormData();
      body.append('body', payload.body);
      body.append('instance_ids', JSON.stringify(payload.instance_ids));
      if (payload.template_key) body.append('template_key', payload.template_key);
      files.forEach((f) => body.append('files', f, f.name));
    }
    try {
      const { queued, skipped } = (await api.request('/whatsapp/send', { method: 'POST', body })).data;
      this.wa.draft = '';
      this.wa.files = [];
      this.renderWaFiles();
      Utils.showToast(`${queued} message(s) queued - they go out a few seconds apart. See History.${skipped.length ? ` Skipped: ${skipped.join(', ')}` : ''}`, 'success', 5000);
      document.getElementById('wa-preview').innerHTML = '';
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }

  async saveWaCustomTemplate() {
    const body = document.getElementById('wa-body').value;
    const name = prompt('Name for this saved message:');
    if (!name) return;
    try {
      await api.request('/whatsapp/templates', { method: 'POST', body: { name, body } });
      this.wa.draft = body;
      Utils.showToast('Saved', 'success');
      await this.renderWaTab();
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }

  // ── Automations ─────────────────────────────────────────
  async renderWaAutomations(el) {
    await this.loadWaTemplates();
    const section = (kind, title, intro) => {
      const rows = this.wa.templates.filter((t) => t.kind === kind);
      return `
        <div class="card"><div class="card-header"><h3 class="card-title">${title}</h3></div>
          <div class="p-4 space-y-4">
            <p class="text-sm text-neutral-700">${intro}</p>
            ${rows.length ? rows.map((t) => this.waTemplateCard(t)).join('') : '<p class="text-sm text-neutral-600">None yet - save one from the Send tab.</p>'}
          </div></div>`;
    };
    el.innerHTML = `<div class="space-y-4">
      ${section('login', 'Morning login sequence',
        'Each step that is switched on runs once a day at its time (IST). Instances are pinged first, and only the ones still unreachable - usually because nobody has logged in to Simplifyed - are messaged, so an owner who has logged in hears nothing more. Indian brokers are skipped on weekends and NSE holidays; crypto runs daily.')}
      ${section('alert', 'Emergency alerts',
        'Sent when the app detects a problem on an instance. The cooldown stops repeats: an instance is alerted about the same problem at most once per cooldown. Admin messages go to the linked WhatsApp number (your own chat).')}
      ${section('custom', 'Saved messages', 'Reusable texts for the Send tab.')}
    </div>`;
  }

  waTemplateCard(t) {
    const esc = Utils.escapeHTML;
    const id = `wa-t-${t.id}`;
    const isCustom = t.kind === 'custom';
    return `
      <form class="border border-base-300 rounded-lg p-3 space-y-2" id="${id}" onsubmit="event.preventDefault(); app.saveWaTemplate(${t.id})">
        <div class="flex flex-wrap gap-3 items-center">
          <input type="text" name="name" class="form-input" style="max-width:22rem" value="${esc(t.name)}" aria-label="Name">
          ${isCustom ? '' : `
            <label class="inline-flex items-center gap-2 text-sm"><input type="checkbox" name="enabled" class="form-checkbox" ${t.enabled ? 'checked' : ''}> On</label>
            <label class="text-sm">Send to
              <select name="send_to" class="form-input" style="width:auto">${WA_SEND_TO.map(([v, l]) => `<option value="${v}" ${t.send_to === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
            </label>`}
          ${t.kind === 'login' ? `<label class="text-sm">At <input type="time" name="send_at" class="form-input" style="width:auto" value="${esc(t.send_at || '')}"> IST</label>` : ''}
          ${t.kind === 'alert' ? `<label class="text-sm">Cooldown <input type="number" name="cooldown_min" class="form-input" style="width:6rem" min="0" max="1440" value="${t.cooldown_min ?? 0}"> min</label>` : ''}
        </div>
        <textarea name="body" id="${id}-body" class="form-input w-full" rows="7" maxlength="4000">${esc(t.body)}</textarea>
        ${this.waChips(t.kind, `${id}-body`)}
        <div class="flex flex-wrap gap-2">
          <button type="submit" class="btn btn-buy btn-sm">Save</button>
          ${t.kind === 'login' ? `<button type="button" class="btn btn-neutral btn-outline btn-sm" onclick="app.runWaLoginStep(${t.id})">Run now</button>` : ''}
          ${isCustom ? `<button type="button" class="btn btn-neutral btn-outline btn-sm" onclick="app.deleteWaTemplate(${t.id})">Delete</button>` : ''}
          ${t.last_run_date ? `<span class="text-xs text-neutral-600 self-center">Last ran ${esc(t.last_run_date)}</span>` : ''}
        </div>
      </form>`;
  }

  async saveWaTemplate(id) {
    const form = document.getElementById(`wa-t-${id}`);
    const data = { name: form.name.value, body: form.body.value };
    if (form.enabled) data.enabled = form.enabled.checked;
    if (form.send_to) data.send_to = form.send_to.value;
    if (form.send_at) data.send_at = form.send_at.value;
    if (form.cooldown_min) data.cooldown_min = Number(form.cooldown_min.value);
    try {
      await api.request(`/whatsapp/templates/${id}`, { method: 'PUT', body: data });
      Utils.showToast('Saved', 'success');
    } catch (error) {
      Utils.showToast(error.message, 'error', 6000);
    }
  }

  async runWaLoginStep(id) {
    if (!confirm('Ping the instances now and message the owners of any that are unreachable?')) return;
    try {
      const { unreachable, queued } = (await api.request(`/whatsapp/templates/${id}/run`, { method: 'POST' })).data;
      Utils.showToast(unreachable.length ? `${unreachable.length} unreachable (${unreachable.join(', ')}); ${queued} message(s) queued` : 'All checked instances are reachable - nothing sent', 'success', 6000);
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }

  async deleteWaTemplate(id) {
    if (!confirm('Delete this saved message?')) return;
    try {
      await api.request(`/whatsapp/templates/${id}`, { method: 'DELETE' });
      await this.renderWaTab();
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }

  // ── History ─────────────────────────────────────────────
  async renderWaHistory(el) {
    const [rows, recipients] = await Promise.all([
      api.request(`/whatsapp/messages?limit=300${this.wa.historyInstance ? `&instance_id=${this.wa.historyInstance}` : ''}`).then((r) => r.data),
      api.request('/whatsapp/recipients').then((r) => r.data),
    ]);
    const esc = Utils.escapeHTML;
    const badge = { sent: 'badge-success', failed: 'badge-error', queued: 'badge-warning' };
    el.innerHTML = `
      <div class="card"><div class="p-4 space-y-3">
        <div class="flex gap-2 items-center">
          <select class="form-input" style="width:auto" aria-label="Filter by instance"
                  onchange="app.wa.historyInstance = Number(this.value) || null; app.renderWaTab()">
            <option value="">All instances</option>
            ${recipients.map((r) => `<option value="${r.id}" ${this.wa.historyInstance === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}
          </select>
          <span class="text-sm text-neutral-700">Newest 300 shown. Each instance keeps its last 300 messages, for up to 90 days.</span>
          <button class="btn btn-xs btn-neutral btn-outline" onclick="app.renderWaTab()">Refresh</button>
        </div>
        <div class="overflow-x-auto"><table class="table table-sm w-full">
          <thead><tr><th>Time</th><th>To</th><th>Type</th><th>Status</th><th>Message</th><th>By</th></tr></thead>
          <tbody>${rows.length ? rows.map((m) => `
            <tr>
              <td class="whitespace-nowrap">${Utils.formatDateTime(m.created_at, true)}</td>
              <td class="whitespace-nowrap">${m.recipient === 'admin' ? 'Admin' : ''} ${m.phone ? `+${esc(m.phone)}` : ''}</td>
              <td>${esc(m.template_key || 'custom')}</td>
              <td><span class="badge ${badge[m.status] || ''}">${esc(m.status)}</span>${m.error ? `<div class="text-xs text-error">${esc(m.error)}</div>` : ''}</td>
              <td><pre class="text-xs whitespace-pre-wrap" style="font-family:inherit;max-width:32rem">${esc(m.body)}</pre>
                ${m.media ? JSON.parse(m.media).map((f, i) => `<button type="button" class="btn btn-xs btn-neutral btn-outline mt-1" style="text-transform:none"
                     onclick="app.downloadWaAttachment(${m.id}, ${i}, this.dataset.name)" data-name="${esc(f.name)}">📎 ${esc(f.name)}</button>`).join(' ') : ''}</td>
              <td class="text-xs">${esc(m.sent_by_email || 'automatic')}</td>
            </tr>`).join('') : '<tr><td colspan="6" class="text-sm text-neutral-600">No messages yet.</td></tr>'}</tbody>
        </table></div>
      </div></div>`;
  }

  /** The download needs the login token, so it is fetched and handed to the browser as a blob. */
  async downloadWaAttachment(id, index, name) {
    try {
      const res = await fetch(`/api/v1/whatsapp/messages/${id}/media/${index}`, { headers: { Authorization: `Bearer ${localStorage.getItem('auth_token')}` } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || `HTTP ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement('a'), { href: url, download: name });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }

  // ── Connection ──────────────────────────────────────────
  async renderWaConnection(el) {
    const wa = (await api.request('/whatsapp/status')).data;
    const label = { open: 'Connected', qr: 'Waiting for scan', connecting: 'Connecting...', disconnected: 'Not connected' }[wa.status] || wa.status;
    const esc = Utils.escapeHTML;
    el.innerHTML = `
      <div class="card"><div class="p-4 space-y-4">
        <p class="text-sm text-neutral-700">Every message is sent from the WhatsApp account linked here. The link survives restarts and updates.</p>
        <p class="text-sm"><span class="text-neutral-600">Status:</span>
          <span class="font-semibold ${wa.status === 'open' ? 'text-success-600' : 'text-error'}">${label}</span>
          ${wa.phone ? `<span class="text-neutral-700">(+${esc(wa.phone)})</span>` : ''}</p>
        ${wa.qr ? `
          <div>
            <img src="${wa.qr}" alt="WhatsApp link QR code" width="264" height="264" style="background:#fff;padding:8px">
            <p class="text-sm text-neutral-600 mt-2">On your phone: WhatsApp &gt; Settings &gt; Linked Devices &gt; Link a Device, then scan this code.</p>
          </div>` : ''}
        <div class="flex flex-wrap gap-2 items-center">
          ${wa.status === 'disconnected' ? '<button class="btn btn-buy btn-sm" onclick="app.waConnectionAction(\'/whatsapp/connect\')">Connect WhatsApp</button>' : ''}
          ${wa.status !== 'disconnected' ? '<button class="btn btn-neutral btn-outline btn-sm" onclick="app.waConnectionAction(\'/whatsapp/logout\', \'Unlink WhatsApp from this app?\')">Unlink</button>' : ''}
        </div>
        ${wa.status === 'open' ? `
          <form class="flex flex-wrap gap-2 items-center" onsubmit="event.preventDefault(); app.sendWaTest()">
            <input type="tel" id="wa-test-phone" class="form-input" style="max-width:14rem" placeholder="919876543210" aria-label="Test number">
            <button class="btn btn-neutral btn-outline btn-sm" type="submit">Send test message</button>
          </form>` : ''}
      </div></div>`;
    if (wa.status === 'qr' || wa.status === 'connecting') {
      this.waPoll = setTimeout(() => { if (this.currentView === 'whatsapp' && this.wa.tab === 'connection') this.renderWaTab(); }, 3000);
    }
  }

  async waConnectionAction(endpoint, confirmText) {
    if (confirmText && !confirm(confirmText)) return;
    try {
      await api.request(endpoint, { method: 'POST' });
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
    await this.renderWaTab();
  }

  async sendWaTest() {
    try {
      const { to } = (await api.request('/whatsapp/test', { method: 'POST', body: { phone: document.getElementById('wa-test-phone').value } })).data;
      Utils.showToast(`Test message sent to +${to}`, 'success');
    } catch (error) {
      Utils.showToast(error.message, 'error');
    }
  }
}.prototype));
