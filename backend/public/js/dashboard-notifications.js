/**
 * Simplifyed Admin V2 - Dashboard: Notifications + Audit views.
 */

Object.defineProperties(DashboardApp.prototype, Object.getOwnPropertyDescriptors(class {
  async renderNotificationsView() {
    const contentArea = document.getElementById('content-area');
    try {
      const res = await api.getNotifications();
      const rows = res.data || [];
      const fmtDate = (ts) => Utils.formatDateTime(ts, true);
      const canEdit = this.hasPermission('pages.notifications.edit');
      const items = rows.length
        ? rows
          .map(
            (n) => `
          <div class="flex items-start gap-3 p-3 rounded-lg ${n.read ? 'bg-base-200' : 'bg-base-100'} border border-base-200">
            <div class="text-sm font-semibold">${n.title}</div>
            <div class="ml-auto text-xs text-neutral-500">${fmtDate(n.created_at)}</div>
            <div class="text-xs text-neutral-600 w-full">${n.body || ''}</div>
            ${n.read || !canEdit ? '' : `<button class="btn btn-xs btn-outline" onclick="app.markNotificationRead(${n.id})">Mark read</button>`}
          </div>`
          )
          .join('')
        : '<p class="text-sm text-neutral-600">No notifications.</p>';

      contentArea.innerHTML = `
        <div class="p-4 space-y-3">
          <div class="flex items-center justify-between">
            <h3 class="text-lg font-semibold">Notifications</h3>
            <p class="text-sm text-neutral-500">Endpoint health and system alerts</p>
          </div>
          <div class="space-y-2">${items}</div>
          <div class="flex gap-2">
            ${canEdit ? `<button class="btn btn-buy btn-sm" onclick="app.markAllNotificationsRead()">Mark all read</button>` : ''}
            <button class="btn btn-neutral btn-outline btn-sm" onclick="app.renderNotificationsView()">Refresh</button>
            <button class="btn btn-outline btn-sm" onclick="app.triggerHealthCheck()">Run health check now</button>
          </div>
        </div>
      `;
    } catch (err) {
      contentArea.innerHTML = `<p class="text-error text-sm">Failed to load notifications: ${err.message}</p>`;
    }
  }

  async renderAuditView() {
    const contentArea = document.getElementById('content-area');
    if (!this.hasPermission('pages.audit.view')) {
      contentArea.innerHTML = `
        <div class="p-6">
          <div class="alert alert-warning">
            <div>
              <h3 class="font-semibold">Access required</h3>
              <p class="text-sm text-neutral-600">You do not have permission to view audit logs.</p>
            </div>
          </div>
        </div>
      `;
      return;
    }

    const actionFilter = document.getElementById('audit-action-filter')?.value || '';
    const userFilter = document.getElementById('audit-user-filter')?.value || '';
    const limit = 200;

    contentArea.innerHTML = `
      <div class="p-4 space-y-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 class="text-lg font-semibold">Audit Logs</h3>
            <p class="text-sm text-neutral-600">Recent admin and trading actions.</p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <input id="audit-action-filter" class="input input-bordered input-sm" placeholder="Action (e.g. orders.place)" value="${Utils.escapeHTML(actionFilter)}" />
            <input id="audit-user-filter" class="input input-bordered input-sm" placeholder="User ID" value="${Utils.escapeHTML(userFilter)}" />
            <button class="btn btn-outline btn-sm" onclick="app.renderAuditView()">Refresh</button>
          </div>
        </div>
        <div id="audit-table" class="table-container overflow-x-auto">
          <div class="text-center text-neutral-500">Loading audit logs…</div>
        </div>
      </div>
    `;

    try {
      const filters = { limit: String(limit) };
      if (actionFilter) filters.action = actionFilter;
      if (userFilter) filters.userId = userFilter;

      const res = await api.getAuditLogs(filters);
      const rows = res.data || [];
      const formatMetadata = (value) => {
        if (!value) return '-';
        try {
          const parsed = JSON.parse(value);
          return `<pre class="text-xs whitespace-pre-wrap">${Utils.escapeHTML(JSON.stringify(parsed, null, 2))}</pre>`;
        } catch {
          return `<span class="text-xs text-neutral-600">${Utils.escapeHTML(String(value))}</span>`;
        }
      };

      const body = rows.length
        ? rows.map((row) => `
            <tr>
              <td>${Utils.formatDateTime(row.created_at, true)}</td>
              <td>${Utils.escapeHTML(row.user_email || row.user_id || 'System')}</td>
              <td>${Utils.escapeHTML(row.action || '-')}</td>
              <td>${formatMetadata(row.metadata)}</td>
            </tr>
          `).join('')
        : '<tr><td colspan="4" class="text-center text-neutral-500">No audit entries.</td></tr>';

      const table = `
        <table class="table">
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>User</th>
              <th>Action</th>
              <th>Metadata</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      `;

      const container = document.getElementById('audit-table');
      if (container) container.innerHTML = table;
    } catch (err) {
      const container = document.getElementById('audit-table');
      if (container) {
        container.innerHTML = `<p class="text-error text-sm">Failed to load audit logs: ${err.message}</p>`;
      }
    }
  }

  async markNotificationRead(id) {
    try {
      await api.markNotificationRead(id);
      await this.renderNotificationsView();
    } catch (err) {
      Utils.showToast('Failed to mark notification read', 'error');
    }
  }

  async markAllNotificationsRead() {
    try {
      const res = await api.getNotifications();
      const rows = res.data || [];
      await Promise.all(rows.filter((n) => !n.read).map((n) => api.markNotificationRead(n.id)));
      await this.renderNotificationsView();
    } catch (err) {
      Utils.showToast('Failed to mark all read', 'error');
    }
  }

  async triggerHealthCheck() {
    try {
      await api.request('/health-check/run', { method: 'POST' });
      Utils.showToast('Health check triggered', 'success');
      await this.renderNotificationsView();
    } catch (err) {
      Utils.showToast('Failed to trigger health check', 'error');
    }
  }

}.prototype));
