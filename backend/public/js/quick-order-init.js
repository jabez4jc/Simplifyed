/**
 * Quick Order bootstrap - must load LAST, after quick-order-core.js and every
 * quick-order-*.js mixin file, so QuickOrderHandler.prototype is fully assembled.
 */

// Export singleton instance globally for inline handlers
if (window.quickOrder) {
  console.warn('[QuickOrder] Existing handler detected, reusing global instance');
} else {
  window.quickOrder = new QuickOrderHandler();
  // debug: removed noisy log
}
