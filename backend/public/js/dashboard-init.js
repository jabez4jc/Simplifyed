/**
 * Dashboard bootstrap - must load LAST, after dashboard-core.js and every dashboard-*.js
 * view file, so DashboardApp.prototype is fully assembled (via Object.assign in each view
 * file) before the single instance is created.
 */

window.app = new DashboardApp();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => window.app.init());
} else {
  window.app.init();
}
