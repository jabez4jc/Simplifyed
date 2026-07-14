/**
 * Simplifyed Admin V2 - Settings: Data Management tab (Instruments Cache, Instance CSV,
 * Watchlist CSV import/export).
 */

Object.defineProperties(SettingsHandler.prototype, Object.getOwnPropertyDescriptors(class {
  /**
   * Render Data Management tab (Instruments Cache + Import/Export)
   */
  async renderDataManagementTab() {
    return `
      <div class="space-y-6">
        <!-- Instruments Cache Section -->
        <div class="card">
          <div class="card-header">
            <h3 class="card-title">📊 Instruments Cache</h3>
            <p class="text-sm text-neutral-600 mt-1">
              Manage broker instruments cache. Upload CSV file or refresh from broker API.
            </p>
          </div>
          <div class="p-6">
            ${await this.renderInstrumentsCacheSection()}
          </div>
        </div>

        ${this.isAdmin() ? `
        <!-- Instances Import / Export Section -->
        <div class="card">
          <div class="card-header">
            <h3 class="card-title">🗂️ Instances Import / Export</h3>
            <p class="text-sm text-neutral-600 mt-1">
              Admin-only: export all instances to CSV or import/update from CSV (upsert by host_url).
            </p>
          </div>
          <div class="p-6 space-y-3">
            ${this.renderInstanceCsvSection()}
          </div>
        </div>

        <!-- Watchlists Import / Export Section -->
        <div class="card">
          <div class="card-header">
            <h3 class="card-title">🗂️ Watchlists Import / Export</h3>
            <p class="text-sm text-neutral-600 mt-1">
              Admin-only: export all watchlists, symbols, and instance mappings, or import/update from CSV.
            </p>
          </div>
          <div class="p-6 space-y-3">
            ${this.renderWatchlistCsvSection()}
          </div>
        </div>
        ` : ''}
      </div>
    `;
  }
  /**
   * Render instruments cache section
   */
  async renderInstrumentsCacheSection() {
    try {
      const response = await this.authFetch('/api/v1/instruments/stats');
      const data = await response.json();
      const stats = data.data;

      const html = `
        <div class="space-y-6">
          <!-- Cache Stats Header -->
          <div class="settings-sub-panel">
            <div class="flex items-center justify-between mb-4">
              <div>
                <h3 class="text-lg font-semibold text-neutral-900">📊 Instruments Cache Overview</h3>
                <p class="text-sm text-neutral-600 mt-1">
                  Local cache of broker instruments for fast symbol search
                </p>
              </div>
              <div class="flex items-center gap-2">
                <div class="px-3 py-1.5 rounded-full text-sm font-medium ${(stats.total || 0) > 0 ? 'bg-success-100 text-success-700' : 'bg-neutral-100 text-neutral-600'}">
                  ${(stats.total || 0) > 0 ? '✅ Loaded' : '⏸️ Empty'}
                </div>
              </div>
            </div>

            <!-- Stats Grid -->
            <div class="grid grid-cols-3 gap-4">
              <div class="settings-stat-box">
                <p class="text-xs font-medium text-neutral-600 uppercase tracking-wide">Total Instruments</p>
                <p class="text-2xl font-bold text-neutral-900 mt-2">
                  ${(stats.total || 0).toLocaleString()}
                </p>
              </div>
              <div class="settings-stat-box">
                <p class="text-xs font-medium text-neutral-600 uppercase tracking-wide">Last Refresh</p>
                <p class="text-lg font-semibold text-neutral-900 mt-2">
                  ${stats.last_refresh ? this.formatDate(stats.last_refresh.completed_at) : 'Never'}
                </p>
              </div>
              <div class="settings-stat-box">
                <p class="text-xs font-medium text-neutral-600 uppercase tracking-wide">Exchanges</p>
                <p class="text-lg font-semibold text-neutral-900 mt-2">
                  9 Exchanges
                </p>
                <p class="text-xs text-neutral-600 mt-1">
                  NSE, BSE, NFO, BFO, BCD, CDS, MCX, NSE_INDEX, BSE_INDEX
                </p>
              </div>
            </div>
          </div>

          <!-- Data Import Methods -->
          <div class="settings-sub-panel">
            <h3 class="text-lg font-semibold text-neutral-900 mb-4">💾 Import Methods</h3>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <!-- CSV Upload Card -->
              <div class="settings-method-card method-primary">
                <div class="flex items-start gap-3">
                  <div class="text-2xl">📁</div>
                  <div class="flex-1">
                    <h4 class="font-semibold text-primary-900 mb-2">Upload CSV File</h4>
                    <p class="text-xs text-primary-800 mb-3">
                      Import instruments from a pre-downloaded CSV file. Best for bulk imports.
                    </p>
                    <div class="space-y-3">
                      <input
                        type="file"
                        id="instruments-csv-file"
                        accept=".csv"
                        class="form-input w-full text-sm"
                      />
                      <button
                        class="btn btn-primary w-full"
                        onclick="settings.uploadInstrumentsCSV()"
                        id="upload-csv-btn"
                      >
                        📤 Upload & Import
                      </button>
                      <div id="upload-progress" class="hidden">
                        <div class="settings-status-box">
                          <p class="text-xs text-primary-800 font-medium" id="upload-status">Processing...</p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Fetch from Instance Card -->
              <div class="settings-method-card method-success">
                <div class="flex items-start gap-3">
                  <div class="text-2xl">🔄</div>
                  <div class="flex-1">
                    <h4 class="font-semibold text-success-900 mb-2">Fetch from Instance</h4>
                    <p class="text-xs text-success-800 mb-3">
                      Download instruments directly from an OpenAlgo instance. Fetches all 9 exchanges.
                    </p>
                    <div class="space-y-3">
                      <select id="instance-select" class="form-select w-full text-sm">
                        <option value="">-- Select an instance --</option>
                      </select>
                      <button
                        class="btn btn-success w-full"
                        onclick="settings.fetchFromInstance()"
                        id="fetch-instance-btn"
                      >
                        🚀 Start Fetch
                      </button>
                      <div id="fetch-progress" class="hidden">
                        <div class="settings-status-box">
                          <p class="text-xs text-success-800 font-medium" id="fetch-status">Initializing...</p>
                          <p class="text-xs text-success-700 mt-1">⏱️ This may take several minutes</p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Additional Options -->
          <div class="bg-info-50 rounded-lg border border-info-200 p-4">
            <div class="flex items-start gap-3">
              <div class="text-xl">💡</div>
              <div>
                <h4 class="font-semibold text-info-900 mb-1">Additional Options</h4>
                <p class="text-sm text-info-800">
                  You can also refresh instruments from the broker API via the main dashboard.
                  The cache automatically refreshes daily on first login.
                </p>
              </div>
            </div>
          </div>
        </div>
      `;

      // Load instances after the DOM is ready
      setTimeout(() => {
        this.loadInstances();
      }, 100);

      return html;
    } catch (error) {
      return `<p class="text-error text-sm">Failed to load instruments cache stats: ${error.message}</p>`;
    }
  }

  /**
   * Upload instruments CSV file
   */
  async uploadInstrumentsCSV() {
    const fileInput = document.getElementById('instruments-csv-file');
    const uploadBtn = document.getElementById('upload-csv-btn');
    const progressDiv = document.getElementById('upload-progress');
    const statusText = document.getElementById('upload-status');

    if (!fileInput.files || fileInput.files.length === 0) {
      Utils.showToast('Please select a CSV file to upload', 'warning');
      return;
    }

    const file = fileInput.files[0];

    if (!file.name.endsWith('.csv')) {
      Utils.showToast('Please select a CSV file', 'error');
      return;
    }

    try {
      // Show progress
      progressDiv.classList.remove('hidden');
      statusText.textContent = 'Uploading file...';
      uploadBtn.disabled = true;
      uploadBtn.textContent = '⏳ Uploading...';

      // Create form data
      const formData = new FormData();
      formData.append('file', file);

      // Upload file
      const response = await this.authFetch('/api/v1/instruments/upload', {
        method: 'POST',
        body: formData
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || 'Upload failed');
      }

      // Show success
      const result = data.data;
      statusText.textContent = `✅ Success! Imported ${result.finalCount.toLocaleString()} instruments in ${result.duration}`;

      Utils.showToast(
        `Successfully imported ${result.finalCount.toLocaleString()} instruments`,
        'success'
      );

      // Clear file input
      fileInput.value = '';

      // Refresh the settings view after 2 seconds
      setTimeout(() => {
        this.renderSettingsView();
      }, 2000);
    } catch (error) {
      console.error('[Settings] CSV upload error:', error);
      statusText.textContent = `❌ Error: ${error.message}`;
      Utils.showToast(`Upload failed: ${error.message}`, 'error');
    } finally {
      uploadBtn.disabled = false;
      uploadBtn.textContent = '📤 Upload CSV';
    }
  }

  /**
   * Load instances into the selector dropdown
   */
  async loadInstances() {
    try {
      const response = await this.authFetch('/api/v1/instances');
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || 'Failed to load instances');
      }

      const instances = data.data || [];
      const select = document.getElementById('instance-select');

      if (!select) {
        console.error('[Settings] Instance select element not found');
        return;
      }

      // Clear existing options (keep the first placeholder option)
      select.innerHTML = '<option value="">-- Select an instance --</option>';

      // Add instances to dropdown
      instances.forEach(instance => {
        const option = document.createElement('option');
        option.value = instance.id;
        option.textContent = `${instance.name} (${instance.host})`;
        select.appendChild(option);
      });

      if (instances.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = '-- No instances found --';
        option.disabled = true;
        select.appendChild(option);
      }
    } catch (error) {
      console.error('[Settings] Error loading instances:', error);
      const select = document.getElementById('instance-select');
      if (select) {
        select.innerHTML = '<option value="">-- Error loading instances --</option>';
      }
    }
  }

  /**
   * Fetch instruments from selected instance
   */
  async fetchFromInstance() {
    const select = document.getElementById('instance-select');
    const fetchBtn = document.getElementById('fetch-instance-btn');
    const progressDiv = document.getElementById('fetch-progress');
    const statusText = document.getElementById('fetch-status');

    if (!select) {
      Utils.showToast('Instance selector not found', 'error');
      return;
    }

    const instanceId = select.value;

    if (!instanceId) {
      Utils.showToast('Please select an OpenAlgo instance', 'warning');
      return;
    }

    try {
      // Show progress
      progressDiv.classList.remove('hidden');
      statusText.textContent = 'Starting fetch from instance...';
      fetchBtn.disabled = true;
      fetchBtn.textContent = '⏳ Fetching...';

      // Call the API
      const response = await this.authFetch('/api/v1/instruments/fetch-from-instance', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          instanceId: parseInt(instanceId, 10)
        })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || 'Fetch failed');
      }

      // Poll for status updates
      this.pollFetchStatus(instanceId, statusText, fetchBtn, progressDiv);
    } catch (error) {
      console.error('[Settings] Fetch from instance error:', error);
      statusText.textContent = `❌ Error: ${error.message}`;
      statusText.classList.add('text-error');
      Utils.showToast(`Fetch failed: ${error.message}`, 'error');
      fetchBtn.disabled = false;
      fetchBtn.textContent = '🔄 Fetch from Instance';
    }
  }

  /**
   * Poll for fetch status updates
   */
  async pollFetchStatus(instanceId, statusText, fetchBtn, progressDiv) {
    const pollInterval = 2000; // Poll every 2 seconds
    const maxDuration = 5 * 60 * 1000; // 5 minutes max
    const startTime = Date.now();

    const poll = async () => {
      try {
        const response = await this.authFetch(`/api/v1/instruments/fetch-status/${instanceId}`);

        if (response.ok) {
          const data = await response.json();
          const status = data.data;

          // Update status display
          statusText.textContent = `⏳ ${status.message}`;
          statusText.classList.remove('text-error', 'text-success');
          statusText.classList.add('text-info');

          // If completed, show success and stop polling
          if (status.status === 'completed') {
            statusText.textContent = `✅ ${status.message} (Total: ${status.totalInstruments.toLocaleString()} instruments)`;
            statusText.classList.remove('text-info');
            statusText.classList.add('text-success');

            Utils.showToast(
              `Successfully fetched ${status.totalInstruments.toLocaleString()} instruments!`,
              'success'
            );

            fetchBtn.disabled = false;
            fetchBtn.textContent = '🔄 Fetch from Instance';

            // Refresh settings view after completion
            setTimeout(() => {
              this.renderSettingsView();
            }, 3000);

            return; // Stop polling
          }

          // If error, show error and stop polling
          if (status.status === 'error') {
            statusText.textContent = `❌ ${status.message}`;
            statusText.classList.remove('text-info');
            statusText.classList.add('text-error');

            Utils.showToast(`Fetch failed: ${status.message}`, 'error');

            fetchBtn.disabled = false;
            fetchBtn.textContent = '🔄 Fetch from Instance';
            return; // Stop polling
          }
        } else if (response.status === 404) {
          // Fetch completed (no longer in activeFetches)
          statusText.textContent = '✅ Fetch completed!';
          statusText.classList.remove('text-info');
          statusText.classList.add('text-success');

          fetchBtn.disabled = false;
          fetchBtn.textContent = '🔄 Fetch from Instance';

          setTimeout(() => {
            this.renderSettingsView();
          }, 3000);

          return; // Stop polling
        }

        // Continue polling if still active
        if (Date.now() - startTime < maxDuration) {
          setTimeout(poll, pollInterval);
        } else {
          statusText.textContent = '⚠️ Fetch timeout (still running in background)';
          statusText.classList.remove('text-info');
          statusText.classList.add('text-warning');
          fetchBtn.disabled = false;
          fetchBtn.textContent = '🔄 Fetch from Instance';
        }
      } catch (error) {
        console.error('[Settings] Error polling fetch status:', error);
        // Continue polling on error
        if (Date.now() - startTime < maxDuration) {
          setTimeout(poll, pollInterval);
        }
      }
    };

    // Start polling
    poll();
  }

  renderInstanceCsvSection() {
    return `
      <div class="flex flex-col gap-3">
        <div class="flex gap-2 items-center flex-wrap">
          <button class="btn btn-buy btn-sm" onclick="settings.exportInstancesCsv()" id="btn-export-instances">
            Export Instances CSV
          </button>
          <span class="text-xs text-neutral-500">Exports all instance fields (excluding timestamps) to CSV.</span>
        </div>
        <div class="flex gap-2 items-center flex-wrap">
          <input type="file" accept=".csv,text/csv" id="instances-csv-file" class="input input-sm" />
          <button class="btn btn-neutral btn-outline btn-sm" onclick="settings.importInstancesCsv()" id="btn-import-instances">
            Import Instances CSV
          </button>
          <span class="text-xs text-neutral-500">Upserts by host_url. Blank cells are ignored.</span>
        </div>
      </div>
    `;
  }

  async exportInstancesCsv() {
    const btn = document.getElementById('btn-export-instances');
    if (btn) btn.classList.add('is-loading');
    try {
      const res = await this.authFetch('/api/v1/instances/export/csv', { method: 'GET' });
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'instances-export.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      Utils.showToast('Instances exported', 'success');
    } catch (err) {
      Utils.showToast(err.message || 'Export failed', 'error');
    } finally {
      if (btn) btn.classList.remove('is-loading');
    }
  }

  async importInstancesCsv() {
    const input = document.getElementById('instances-csv-file');
    const btn = document.getElementById('btn-import-instances');
    if (!input || !input.files || !input.files.length) {
      Utils.showToast('Select a CSV file first', 'warning');
      return;
    }
    const file = input.files[0];
    const formData = new FormData();
    formData.append('file', file);

    if (btn) btn.classList.add('is-loading');
    try {
      const res = await this.authFetch('/api/v1/instances/import/csv', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || 'Import failed');
      }
      Utils.showToast(data.message || 'Import completed', 'success');
      await this.renderSettingsView();
    } catch (err) {
      Utils.showToast(err.message || 'Import failed', 'error');
    } finally {
      if (btn) btn.classList.remove('is-loading');
      if (input) input.value = '';
    }
  }

  renderWatchlistCsvSection() {
    return `
      <div class="flex flex-col gap-3">
        <div class="flex gap-2 items-center flex-wrap">
          <button class="btn btn-buy btn-sm" onclick="settings.exportWatchlistsCsv()" id="btn-export-watchlists">
            Export Watchlists CSV
          </button>
          <span class="text-xs text-neutral-500">Exports watchlists, symbols, and instance mappings as a text bundle.</span>
        </div>
        <div class="flex gap-2 items-center flex-wrap">
          <input type="file" accept=".txt,.csv,text/plain" id="watchlists-csv-file" class="input input-sm" />
          <button class="btn btn-neutral btn-outline btn-sm" onclick="settings.importWatchlistsCsv()" id="btn-import-watchlists">
            Import Watchlists CSV
          </button>
          <span class="text-xs text-neutral-500">Upserts by watchlist name; symbols by (watchlist_id, symbol, exchange); mappings by (watchlist_id, instance_id).</span>
        </div>
      </div>
    `;
  }

  async exportWatchlistsCsv() {
    const btn = document.getElementById('btn-export-watchlists');
    if (btn) btn.classList.add('is-loading');
    try {
      const res = await this.authFetch('/api/v1/watchlists/export/csv', { method: 'GET' });
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'watchlists-export.txt';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      Utils.showToast('Watchlists exported', 'success');
    } catch (err) {
      Utils.showToast(err.message || 'Export failed', 'error');
    } finally {
      if (btn) btn.classList.remove('is-loading');
    }
  }

  async importWatchlistsCsv() {
    const input = document.getElementById('watchlists-csv-file');
    const btn = document.getElementById('btn-import-watchlists');
    if (!input || !input.files || !input.files.length) {
      Utils.showToast('Select a CSV/text file first', 'warning');
      return;
    }
    const file = input.files[0];
    const formData = new FormData();
    formData.append('file', file);

    if (btn) btn.classList.add('is-loading');
    try {
      const res = await this.authFetch('/api/v1/watchlists/import/csv', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || 'Import failed');
      }
      Utils.showToast(data.message || 'Import completed', 'success');
      await this.renderSettingsView();
    } catch (err) {
      Utils.showToast(err.message || 'Import failed', 'error');
    } finally {
      if (btn) btn.classList.remove('is-loading');
      if (input) input.value = '';
    }
  }
}.prototype));
