/**
 * Utility Functions
 * Common helpers for formatting, validation, notifications, etc.
 */

const Utils = {
  /**
   * Format number as currency (INR)
   */
  formatCurrency(value, decimals = 2) {
    if (value === null || value === undefined) return '₹0.00';

    const num = parseFloat(value);
    if (isNaN(num)) return '₹0.00';

    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(num);
  },

  /**
   * Format number with thousand separators
   */
  formatNumber(value, decimals = 2) {
    if (value === null || value === undefined) return '0';

    const num = parseFloat(value);
    if (isNaN(num)) return '0';

    return new Intl.NumberFormat('en-IN', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(num);
  },

  /**
   * Format percentage
   */
  formatPercentage(value, decimals = 2) {
    if (value === null || value === undefined) return '0%';

    const num = parseFloat(value);
    if (isNaN(num)) return '0%';

    return `${num.toFixed(decimals)}%`;
  },

  /**
   * Format date/time
   */
  formatDateTime(dateString, includeTime = true) {
    if (!dateString) return '-';

    const date = new Date(dateString);
    if (isNaN(date.getTime())) return '-';

    const options = {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'Asia/Kolkata',
    };

    if (includeTime) {
      options.hour = '2-digit';
      options.minute = '2-digit';
      options.second = '2-digit';
      options.hour12 = false;
    }

    return new Intl.DateTimeFormat('en-IN', options).format(date);
  },

  /**
   * Format relative time (e.g., "2 minutes ago")
   */
  formatRelativeTime(dateString) {
    if (!dateString) return '-';

    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    if (diffSec < 60) return 'Just now';
    if (diffMin < 60) return `${diffMin} minute${diffMin > 1 ? 's' : ''} ago`;
    if (diffHour < 24) return `${diffHour} hour${diffHour > 1 ? 's' : ''} ago`;
    if (diffDay < 7) return `${diffDay} day${diffDay > 1 ? 's' : ''} ago`;

    return this.formatDateTime(dateString, false);
  },

  /**
   * Get color class for P&L value using ButtonHighlights text colors
   */
  getPnLColorClass(value) {
    const num = parseFloat(value);
    if (isNaN(num) || num === 0) return 'text-neutral';
    return num > 0 ? 'text-buy' : 'text-exit';
  },

  /**
   * Get background color class for P&L using ButtonHighlights backgrounds
   */
  getPnLBgClass(value) {
    const num = parseFloat(value);
    if (isNaN(num) || num === 0) return 'bg-neutral-light';
    return num > 0 ? 'bg-buy-light' : 'bg-exit-light';
  },

  /**
   * Debounce function
   */
  debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  },

  /**
   * Throttle function
   */
  throttle(func, limit) {
    let inThrottle;
    return function(...args) {
      if (!inThrottle) {
        func.apply(this, args);
        inThrottle = true;
        setTimeout(() => inThrottle = false, limit);
      }
    };
  },

  /**
   * Show toast notification using ButtonHighlights alert styles
   */
  showToast(message, type = 'info', duration = 3000) {
    const toast = document.createElement('div');
    // Map notification types to ButtonHighlights alert classes
    const alertType = type === 'error' ? 'alert-danger' :
                      type === 'success' ? 'alert-success' :
                      type === 'warning' ? 'alert-warning' : 'alert-info';

    toast.className = `alert ${alertType} alert-sm`;
    toast.style.cssText = 'animation: slideIn 0.3s ease;';

    // Create alert icon element
    const iconDiv = document.createElement('div');
    iconDiv.className = 'alert-icon';
    iconDiv.textContent = this.getToastIcon(type);

    // Create alert content element with escaped message
    const contentDiv = document.createElement('div');
    contentDiv.className = 'alert-content';
    contentDiv.textContent = message; // Using textContent to prevent XSS

    // Create close button
    const closeBtn = document.createElement('button');
    closeBtn.className = 'alert-close';
    closeBtn.textContent = '×';
    closeBtn.onclick = () => toast.remove();

    toast.appendChild(iconDiv);
    toast.appendChild(contentDiv);
    toast.appendChild(closeBtn);

    const container = document.getElementById('toast-container');
    if (container) {
      container.appendChild(toast);

      // Cap visible toasts so a burst of actions (bulk cancel, quote errors) can't stack up
      // indefinitely - drop the oldest once we're over the limit.
      const MAX_VISIBLE_TOASTS = 4;
      while (container.children.length > MAX_VISIBLE_TOASTS) {
        container.firstElementChild.remove();
      }

      // Auto remove
      setTimeout(() => {
        toast.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => toast.remove(), 300);
      }, duration);
    }
  },

  /**
   * Get toast icon based on type
   */
  getToastIcon(type) {
    const icons = {
      success: '✓',
      error: '✕',
      warning: '⚠',
      info: 'ℹ',
    };
    return icons[type] || icons.info;
  },

  /**
   * Show confirmation dialog
   */
  async confirm(message, title = 'Confirm') {
    return new Promise((resolve) => {
      const modal = document.createElement('div');
      modal.className = 'modal-overlay';
      modal.innerHTML = `
        <div class="modal-content">
          <div class="modal-header">
            <h3></h3>
          </div>
          <div class="modal-body">
            <p></p>
          </div>
          <div class="modal-footer">
            <button class="btn btn-neutral btn-outline" data-action="cancel">Cancel</button>
            <button class="btn btn-buy" data-action="confirm">Confirm</button>
          </div>
        </div>
      `;
      // Set via textContent (not interpolated into the innerHTML template above) so
      // caller-supplied text - e.g. a live broker symbol - can never inject markup.
      modal.querySelector('.modal-header h3').textContent = title;
      modal.querySelector('.modal-body p').textContent = message;

      document.body.appendChild(modal);

      modal.addEventListener('click', (e) => {
        const action = e.target.dataset.action;
        if (action === 'confirm') {
          resolve(true);
          modal.remove();
        } else if (action === 'cancel' || e.target === modal) {
          resolve(false);
          modal.remove();
        }
      });
    });
  },

  /**
   * Show loading spinner
   */
  showLoading(container) {
    if (typeof container === 'string') {
      container = document.querySelector(container);
    }
    if (container) {
      container.innerHTML = `
        <div class="app-loading-spinner">
          <div class="app-loading-dots">
            <span></span>
            <span></span>
            <span></span>
          </div>
          <p>Loading...</p>
        </div>
      `;
    }
  },

  /**
   * Validate instance form data
   */
  validateInstanceData(data) {
    const errors = [];

    if (!data.name || data.name.trim() === '') {
      errors.push({ field: 'name', message: 'Name is required' });
    }

    if (!data.host_url || data.host_url.trim() === '') {
      errors.push({ field: 'host_url', message: 'Host URL is required' });
    } else if (!this.isValidURL(data.host_url)) {
      errors.push({ field: 'host_url', message: 'Invalid URL format' });
    }

    if (!data.api_key || data.api_key.trim() === '') {
      errors.push({ field: 'api_key', message: 'API Key is required' });
    }

    return errors;
  },

  /**
   * Validate URL format
   */
  isValidURL(string) {
    try {
      new URL(string);
      return true;
    } catch (_) {
      return false;
    }
  },

  /**
   * Copy text to clipboard
   */
  async copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      this.showToast('Copied to clipboard', 'success', 2000);
      return true;
    } catch (err) {
      this.showToast('Failed to copy', 'error');
      return false;
    }
  },

  /**
   * Download data as JSON file
   */
  downloadJSON(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  /**
   * Parse CSV string
   */
  parseCSV(csvString) {
    const lines = csvString.trim().split('\n');
    const headers = lines[0].split(',').map(h => h.trim());
    const data = [];

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',').map(v => v.trim());
      const row = {};
      headers.forEach((header, index) => {
        row[header] = values[index];
      });
      data.push(row);
    }

    return data;
  },

  /**
   * Generate CSV from array of objects
   */
  generateCSV(data, headers = null) {
    if (!data || data.length === 0) return '';

    const keys = headers || Object.keys(data[0]);
    const csvRows = [];

    // Header row
    csvRows.push(keys.join(','));

    // Data rows
    for (const row of data) {
      const values = keys.map(key => {
        const value = row[key];
        // Escape commas and quotes
        return typeof value === 'string' && value.includes(',')
          ? `"${value.replace(/"/g, '""')}"`
          : value;
      });
      csvRows.push(values.join(','));
    }

    return csvRows.join('\n');
  },

  /**
   * Escape HTML to prevent XSS
   */
  escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },

  /**
   * Create element with attributes
   */
  createElement(tag, attributes = {}, children = []) {
    const element = document.createElement(tag);

    for (const [key, value] of Object.entries(attributes)) {
      if (key === 'className') {
        element.className = value;
      } else if (key === 'dataset') {
        for (const [dataKey, dataValue] of Object.entries(value)) {
          element.dataset[dataKey] = dataValue;
        }
      } else {
        element.setAttribute(key, value);
      }
    }

    for (const child of children) {
      if (typeof child === 'string') {
        element.appendChild(document.createTextNode(child));
      } else {
        element.appendChild(child);
      }
    }

    return element;
  },

  /**
   * Get status badge HTML using ButtonHighlights badge styles
   */
  getStatusBadge(status) {
    const badges = {
      healthy: '<span class="badge badge-buy">Healthy</span>',
      unhealthy: '<span class="badge badge-exit">Unhealthy</span>',
      pending: '<span class="badge badge-sell">Pending</span>',
      active: '<span class="badge badge-buy">Active</span>',
      inactive: '<span class="badge badge-neutral">Inactive</span>',
      complete: '<span class="badge badge-buy">Complete</span>',
      cancelled: '<span class="badge badge-neutral">Cancelled</span>',
      rejected: '<span class="badge badge-exit">Rejected</span>',
      open: '<span class="badge badge-info">Open</span>',
    };

    return badges[status] || `<span class="badge badge-neutral">${status}</span>`;
  },
};

// Escape closes the topmost open modal - every modal in this app shares the .modal-overlay
// class and is appended directly to <body>, so the last one in the DOM is the topmost. If it
// has a Cancel button (data-action="cancel", used by Utils.confirm()), click it so any pending
// promise resolves the same way a real Cancel click would; otherwise just remove the overlay,
// matching the `onclick="this.closest('.modal-overlay').remove()"` pattern used everywhere else.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const overlays = document.querySelectorAll('.modal-overlay');
  if (!overlays.length) return;
  const topmost = overlays[overlays.length - 1];
  const cancelBtn = topmost.querySelector('[data-action="cancel"]');
  if (cancelBtn) {
    cancelBtn.click();
  } else {
    topmost.remove();
  }
});
