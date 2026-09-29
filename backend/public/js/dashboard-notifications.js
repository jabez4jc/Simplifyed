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
            <div class="text-sm font-semibold">${Utils.escapeHTML(n.title || '')}</div>
            <div class="ml-auto text-xs text-neutral-500">${fmtDate(n.created_at)}</div>
            <!-- Escaped: notification bodies are assembled by the server's logger from log
                 messages and their metadata, which includes error_message straight off a broker
                 response. An OpenAlgo instance returning markup in an error would otherwise have
                 stored script in this table and run it here, where localStorage holds auth_token. -->
            <div class="text-xs text-neutral-600 w-full">${Utils.escapeHTML(n.body || '')}</div>
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
      contentArea.innerHTML = `<p class="text-error text-sm">Failed to load notifications: ${Utils.escapeHTML(err.message)}</p>`;
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
