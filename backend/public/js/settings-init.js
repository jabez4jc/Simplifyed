/**
 * Settings bootstrap - must load LAST, after settings-core.js and every settings-*.js
 * mixin file, so SettingsHandler.prototype is fully assembled.
 */

// Export singleton instance
var settings = new SettingsHandler();
if (typeof window !== 'undefined') {
  window.settings = settings;
}
