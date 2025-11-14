/**
 * Settings Handler
 * Handles settings view including Telegram linking
 */

class SettingsHandler {
  constructor() {
    this.telegramStatus = null;
  }

  /**
   * Render settings view
   */
  async renderSettingsView() {
    const contentArea = document.getElementById('content-area');

    try {
      // Fetch Telegram status
      this.telegramStatus = await this.fetchTelegramStatus();

      contentArea.innerHTML = `
        <div class="p-6">
          <div class="max-w-4xl mx-auto space-y-6">

            <!-- Telegram Notifications Section -->
            <div class="card">
              <div class="card-header">
                <h3 class="card-title">📱 Telegram Notifications</h3>
              </div>
              <div class="p-6">
                ${this.renderTelegramSection()}
              </div>
            </div>

            <!-- Monitor Status Section -->
            <div class="card">
              <div class="card-header">
                <h3 class="card-title">📊 Order Monitor Status</h3>
              </div>
              <div class="p-6">
                ${await this.renderMonitorStatusSection()}
              </div>
            </div>

          </div>
        </div>
      `;
    } catch (error) {
      contentArea.innerHTML = `
        <div class="p-4">
          <p class="text-error">Failed to load settings: ${error.message}</p>
        </div>
      `;
    }
  }

  /**
   * Render Telegram section
   */
  renderTelegramSection() {
    const isLinked = this.telegramStatus?.is_linked;
    const linkedAt = this.telegramStatus?.linked_at;
    const username = this.telegramStatus?.username;

    if (isLinked) {
      return `
        <div class="space-y-4">
          <div class="flex items-center justify-between p-4 bg-success-50 rounded-lg border border-success-200">
            <div>
              <p class="font-medium text-success-700">✅ Telegram Connected</p>
              <p class="text-sm text-success-600 mt-1">
                @${Utils.escapeHTML(username || 'Unknown')} • Linked ${this.formatDate(linkedAt)}
              </p>
            </div>
            <button class="btn btn-error btn-sm" onclick="settings.unlinkTelegram()">
              Unlink
            </button>
          </div>

          <div class="space-y-3">
            <h4 class="font-semibold text-neutral-700">Notification Preferences</h4>
            <p class="text-sm text-neutral-600">
              You'll receive Telegram alerts when targets and stop losses are hit in your analyzer mode instances.
            </p>
          </div>
        </div>
      `;
    } else {
      return `
        <div class="space-y-4">
          <div class="flex items-center justify-between p-4 bg-neutral-50 rounded-lg border border-neutral-200">
            <div>
              <p class="font-medium text-neutral-700">📱 Telegram Not Connected</p>
              <p class="text-sm text-neutral-600 mt-1">
                Link your Telegram account to receive instant trade alerts
              </p>
            </div>
            <button class="btn btn-primary" onclick="settings.linkTelegram()">
              Link Telegram
            </button>
          </div>

          <div id="telegram-linking-instructions" class="hidden space-y-3">
            <div class="p-4 bg-primary-50 rounded-lg border border-primary-200">
              <h4 class="font-semibold text-primary-900 mb-3">📋 Setup Instructions</h4>
              <ol class="list-decimal list-inside space-y-2 text-sm text-primary-800">
                <li>Copy the command below</li>
                <li>Open Telegram and search for <strong id="bot-username">...</strong></li>
                <li>Send the copied command to the bot</li>
                <li>Wait for confirmation (page will auto-refresh)</li>
              </ol>
            </div>

            <div class="p-4 bg-neutral-100 rounded-lg border border-neutral-300">
              <div class="flex items-center justify-between">
                <code id="telegram-link-command" class="text-sm font-mono text-neutral-800">
                  Loading...
                </code>
                <button class="btn btn-secondary btn-sm" onclick="settings.copyLinkCommand()">
                  📋 Copy
                </button>
              </div>
            </div>

            <div class="flex items-center gap-2">
              <button class="btn btn-primary" onclick="settings.openTelegramBot()">
                Open Telegram Bot
              </button>
              <button class="btn btn-secondary" onclick="settings.checkLinkStatus()">
                Check Status
              </button>
            </div>
          </div>
        </div>
      `;
    }
  }

  /**
   * Render monitor status section
   */
  async renderMonitorStatusSection() {
    try {
      const response = await fetch('/api/v1/monitor/status');
      const data = await response.json();
      const status = data.data;

      return `
        <div class="space-y-4">
          <div class="grid grid-cols-3 gap-4">
            <div class="p-4 bg-neutral-50 rounded-lg border border-neutral-200">
              <p class="text-sm text-neutral-600">Monitoring Status</p>
              <p class="text-lg font-semibold ${status.is_monitoring ? 'text-success-600' : 'text-neutral-500'}">
                ${status.is_monitoring ? '✅ Active' : '⏸️ Inactive'}
              </p>
            </div>
            <div class="p-4 bg-neutral-50 rounded-lg border border-neutral-200">
              <p class="text-sm text-neutral-600">Check Interval</p>
              <p class="text-lg font-semibold text-neutral-800">
                ${status.interval_ms / 1000}s
              </p>
            </div>
            <div class="p-4 bg-neutral-50 rounded-lg border border-neutral-200">
              <p class="text-sm text-neutral-600">Analyzer Instances</p>
              <p class="text-lg font-semibold text-neutral-800">
                ${status.analyzer_instances_count || 0}
              </p>
            </div>
          </div>

          <div class="p-4 bg-info-50 rounded-lg border border-info-200">
            <p class="text-sm text-info-800">
              ℹ️ The order monitor checks analyzer mode positions every ${status.interval_ms / 1000} seconds.
              Configure targets on watchlist symbols to enable monitoring.
            </p>
          </div>
        </div>
      `;
    } catch (error) {
      return `<p class="text-error text-sm">Failed to load monitor status: ${error.message}</p>`;
    }
  }

  /**
   * Fetch Telegram link status
   */
  async fetchTelegramStatus() {
    try {
      const response = await fetch('/api/v1/telegram/status');
      if (!response.ok) throw new Error('Failed to fetch Telegram status');
      const data = await response.json();
      return data.data;
    } catch (error) {
      console.error('[Settings] Error fetching Telegram status:', error);
      return { is_linked: false };
    }
  }

  /**
   * Link Telegram account
   */
  async linkTelegram() {
    try {
      // Generate linking code
      const response = await fetch('/api/v1/telegram/link', { method: 'POST' });
      if (!response.ok) throw new Error('Failed to generate linking code');

      const data = await response.json();
      const { linking_code, bot_username, link_url } = data.data;

      // Show instructions
      const instructionsDiv = document.getElementById('telegram-linking-instructions');
      instructionsDiv.classList.remove('hidden');

      // Update command
      document.getElementById('telegram-link-command').textContent = `/start ${linking_code}`;
      document.getElementById('bot-username').textContent = `@${bot_username}`;

      // Store for later use
      this.linkingData = { linking_code, bot_username, link_url };

      Utils.showToast('Linking code generated! Follow the instructions above.', 'success');
    } catch (error) {
      console.error('[Settings] Error linking Telegram:', error);
      Utils.showToast(`Failed to link: ${error.message}`, 'error');
    }
  }

  /**
   * Copy link command
   */
  copyLinkCommand() {
    const command = document.getElementById('telegram-link-command').textContent;
    navigator.clipboard.writeText(command);
    Utils.showToast('Command copied to clipboard!', 'success');
  }

  /**
   * Open Telegram bot
   */
  openTelegramBot() {
    if (this.linkingData?.link_url) {
      window.open(this.linkingData.link_url, '_blank');
    }
  }

  /**
   * Check link status
   */
  async checkLinkStatus() {
    try {
      this.telegramStatus = await this.fetchTelegramStatus();

      if (this.telegramStatus.is_linked) {
        Utils.showToast('✅ Telegram linked successfully!', 'success');
        // Refresh view
        await this.renderSettingsView();
      } else {
        Utils.showToast('Not linked yet. Please send the command to the bot.', 'info');
      }
    } catch (error) {
      Utils.showToast(`Error checking status: ${error.message}`, 'error');
    }
  }

  /**
   * Unlink Telegram account
   */
  async unlinkTelegram() {
    if (!confirm('Are you sure you want to unlink your Telegram account?')) {
      return;
    }

    try {
      const response = await fetch('/api/v1/telegram/unlink', { method: 'DELETE' });
      if (!response.ok) throw new Error('Failed to unlink');

      Utils.showToast('Telegram unlinked successfully', 'success');

      // Refresh view
      await this.renderSettingsView();
    } catch (error) {
      console.error('[Settings] Error unlinking Telegram:', error);
      Utils.showToast(`Failed to unlink: ${error.message}`, 'error');
    }
  }

  /**
   * Format date for display
   */
  formatDate(dateString) {
    if (!dateString) return 'recently';
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 60) return `${diffMins} minutes ago`;
    if (diffHours < 24) return `${diffHours} hours ago`;
    if (diffDays < 7) return `${diffDays} days ago`;
    return date.toLocaleDateString();
  }
}

// Export singleton instance
const settings = new SettingsHandler();
