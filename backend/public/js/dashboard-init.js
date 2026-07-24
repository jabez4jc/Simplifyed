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

// Pause background polling while the tab is backgrounded - separate from the user-facing
// isPaused flag (togglePause()) so this never overrides a deliberate manual pause, and only
// resumes what it auto-paused. The individual stop*Polling() calls are no-ops if already
// stopped, so this is safe to fire on every visibility flip.
document.addEventListener('visibilitychange', () => {
  const app = window.app;
  if (!app) return;
  if (document.hidden) {
    if (app.isPaused || app.autoPausedByVisibility) return;
    app.autoPausedByVisibility = true;
    app.stopAllWatchlistPolling();
    app.stopTradesPolling();
    app.stopPositionsPolling();
    if (app.pollingInterval) {
      clearInterval(app.pollingInterval);
      app.pollingInterval = null;
    }
  } else if (app.autoPausedByVisibility) {
    app.autoPausedByVisibility = false;
    app.refreshCurrentView(true);
    app.startAutoRefresh();
  }
});
