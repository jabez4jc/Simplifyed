/**
 * Order Monitor Service (legacy/inactive)
 * Position target/stoploss monitoring was superseded by AutoExitService + RiskControlsService
 * (see auto-exit.service.js, risk-controls.service.js), which are the services actually started
 * in server.js. This stub remains only so routes/v1/monitor.js can report accurate status and
 * serve any historical rows already present in order_monitor_log/analyzer_trades.
 */

class OrderMonitorService {
  getStatus() {
    return {
      is_monitoring: false,
      interval_ms: null,
      checked_positions_count: 0,
      note: 'Legacy monitor loop is inactive; target/stoploss monitoring is handled by AutoExitService',
    };
  }
}

const orderMonitorService = new OrderMonitorService();
export default orderMonitorService;
