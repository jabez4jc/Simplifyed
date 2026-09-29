/**
 * Simplifyed Admin V2 - Settings: System Status tab (Monitor Status + Instance Health Tests).
 */

Object.defineProperties(SettingsHandler.prototype, Object.getOwnPropertyDescriptors(class {
  /**
   * Render System Status tab (Monitor Status + Health Tests)
   */
  async renderSystemStatusTab() {
    return `
      <div class="space-y-6">
        <!-- Monitor Status Section -->
        <div class="card">
          <div class="card-header">
            <h3 class="card-title">Auto-exit (targets &amp; stop-losses)</h3>
          </div>
          <div class="p-6">
            ${await this.renderMonitorStatusSection()}
          </div>
        </div>
      </div>
    `;
  }
  /**
   * Render monitor status section
   */
  async renderMonitorStatusSection() {
    try {
      const response = await this.authFetch('/api/v1/monitor/status');
      const data = await response.json();
      const status = data.data;

      return `
        <div class="space-y-4">
          <div class="settings-stat-box p-4 border border-neutral-200">
            <p class="text-sm text-neutral-700">
              Auto-exit watches every open position that has a target, stop-loss or trailing stop set on its watchlist symbol
              or strategy leg, and closes it when the level is reached. It works the same on live and analyzer instances.
            </p>
          </div>
          <div class="grid grid-cols-3 gap-4">
            <div class="settings-stat-box p-4 border border-neutral-200">
              <p class="text-sm text-neutral-600">Status</p>
              <p class="text-lg font-semibold ${status.is_monitoring ? 'text-success-600' : 'text-error'}">
                ${status.is_monitoring ? 'Running' : 'Stopped - exits are NOT being watched'}
              </p>
            </div>
            <div class="settings-stat-box p-4 border border-neutral-200">
              <p class="text-sm text-neutral-600">Checks every</p>
              <p class="text-lg font-semibold text-neutral-800">
                ${status.interval_ms ? `${status.interval_ms / 1000} seconds` : '-'}
              </p>
            </div>
            <div class="settings-stat-box p-4 border border-neutral-200">
              <p class="text-sm text-neutral-600">Active Instances</p>
              <p class="text-lg font-semibold text-neutral-800">
                ${status.eligible_instances_count ?? status.analyzer_instances_count ?? 0}
              </p>
            </div>
          </div>

          <div class="settings-method-card method-info p-4">
            <p class="text-sm text-info-800">
              A level must hold for a moment before auto-exit acts, so a single stray tick does not close a position.
              Brokers refuse MIS exits after the 15:15 IST square-off - those are closed by the broker's own square-off.
            </p>
          </div>
        </div>
      `;
    } catch (error) {
      return `<p class="text-error text-sm">Failed to load monitor status: ${Utils.escapeHTML(error.message)}</p>`;
    }
  }

  /**
   * Fetch Telegram link status
   */
  /**
   * Format date for display
   */
  formatDate(dateString) {
    if (!dateString) return 'recently';
    // Prefer relative display for recent events, otherwise show IST date/time
    const rel = Utils.formatRelativeTime(dateString);
    if (rel && rel !== '-') return rel;
    return Utils.formatDateTime(dateString, true);
  }
}.prototype));
