# PHASE 1 IMPLEMENTATION GUIDE
# Basic Target Monitoring with Telegram Alerts (Analyzer Mode Only)

## Overview
This phase implements basic target monitoring for watchlist symbols in analyzer mode only, with Telegram notifications. No live trading risk.

## Timeline: 2 weeks

---

## WEEK 1: BACKEND FOUNDATION

### Day 1-2: Database Schema & Telegram Setup

**Tasks:**
1. Create migration 008 for order monitoring
2. Set up Telegram bot via BotFather
3. Add Telegram tables to database
4. Create telegram.service.js

**Deliverables:**
- [ ] Migration file: `008_add_order_monitoring.js`
- [ ] Telegram bot created and token obtained
- [ ] Telegram service with linking flow
- [ ] Database tables created

**Testing:**
- Run migration successfully
- Test Telegram bot responds to /start
- Verify linking code generation

---

### Day 3-4: Order Monitor Service (Core Logic)

**Tasks:**
1. Create `order-monitor.service.js`
2. Implement position discovery
3. Implement target evaluation (points & percentage)
4. Implement analyzer mode exit simulation
5. Add monitoring to polling service

**Deliverables:**
- [ ] OrderMonitorService class
- [ ] Position discovery from broker API
- [ ] Target hit detection logic
- [ ] Simulated exit logging

**Testing:**
- Mock position data with targets
- Verify target detection accuracy
- Confirm analyzer trades logged

---

### Day 5: API Endpoints

**Tasks:**
1. Create routes: `/api/v1/telegram/*`
2. Create routes: `/api/v1/watchlists/:id/symbols/:symbolId/target`
3. Create routes: `/api/v1/monitor/*`
4. Add validation schemas

**Deliverables:**
- [ ] Telegram linking API
- [ ] Target configuration API
- [ ] Monitor status/history API

**Testing:**
- Postman/curl tests for all endpoints
- Verify target CRUD operations
- Test monitoring status response

---

## WEEK 2: FRONTEND & INTEGRATION

### Day 6-7: UI Components

**Tasks:**
1. Add target configuration UI to watchlist symbol expansion
2. Add Telegram linking UI to settings page
3. Add monitoring status indicator
4. Add trigger history view

**Deliverables:**
- [ ] Target config form in watchlist
- [ ] Telegram settings page
- [ ] Active monitoring badge
- [ ] History table/modal

**Testing:**
- Configure target via UI
- Link Telegram account
- Verify live updates

---

### Day 8-9: End-to-End Testing

**Tasks:**
1. Create test instance in analyzer mode
2. Add test symbols with targets
3. Simulate price movements
4. Verify Telegram alerts received
5. Test edge cases (market closed, errors)

**Deliverables:**
- [ ] Full workflow tested
- [ ] All alerts working
- [ ] Error handling verified

**Testing Scenarios:**
- Target hit → Telegram alert → Simulated exit logged
- Multiple positions hit simultaneously
- Invalid configuration handling
- Telegram send failures

---

### Day 10: Documentation & Polish

**Tasks:**
1. Write user documentation
2. Add inline help text
3. Create demo video/screenshots
4. Performance optimization

**Deliverables:**
- [ ] User guide for target monitoring
- [ ] Telegram setup instructions
- [ ] Admin documentation

---

## IMPLEMENTATION DETAILS

### Migration 008: Order Monitoring Schema

```sql
-- File: backend/migrations/008_add_order_monitoring.js

export const version = '008';
export const name = 'add_order_monitoring';

export async function up(db) {
  // 1. User Telegram configuration
  await db.run(`
    CREATE TABLE IF NOT EXISTS user_telegram_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,

      telegram_chat_id TEXT,
      telegram_username TEXT,
      linking_code TEXT UNIQUE,
      linked_at DATETIME,

      enabled BOOLEAN DEFAULT 1,
      notify_on_target BOOLEAN DEFAULT 1,
      notify_on_sl BOOLEAN DEFAULT 1,
      notify_on_tsl BOOLEAN DEFAULT 1,
      notify_on_error BOOLEAN DEFAULT 1,
      silent_mode BOOLEAN DEFAULT 0,

      is_active BOOLEAN DEFAULT 1,
      last_message_at DATETIME,

      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    )
  `);

  // 2. Telegram message log
  await db.run(`
    CREATE TABLE IF NOT EXISTS telegram_message_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      chat_id TEXT,
      message_type TEXT NOT NULL,
      message_text TEXT,
      telegram_message_id INTEGER,
      send_status TEXT DEFAULT 'pending',
      error_message TEXT,
      sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (user_id) REFERENCES users (id)
    )
  `);

  // 3. Order monitor execution log
  await db.run(`
    CREATE TABLE IF NOT EXISTS order_monitor_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      exchange TEXT NOT NULL,

      trigger_type TEXT NOT NULL,
      entry_price REAL NOT NULL,
      trigger_price REAL NOT NULL,
      target_value REAL NOT NULL,
      exit_quantity INTEGER NOT NULL,

      is_analyzer_mode BOOLEAN DEFAULT 0,
      simulated_pnl REAL,

      exit_order_id TEXT,
      exit_status TEXT,
      error_message TEXT,

      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (instance_id) REFERENCES instances (id)
    )
  `);

  // 4. Analyzer mode trades (simulated executions)
  await db.run(`
    CREATE TABLE IF NOT EXISTS analyzer_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      exchange TEXT NOT NULL,
      side TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      price REAL NOT NULL,
      trade_type TEXT NOT NULL,
      pnl REAL,
      simulated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (instance_id) REFERENCES instances (id)
    )
  `);

  // 5. Market holidays (manual entry)
  await db.run(`
    CREATE TABLE IF NOT EXISTS market_holidays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exchange TEXT NOT NULL,
      holiday_date DATE NOT NULL,
      holiday_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      UNIQUE(exchange, holiday_date)
    )
  `);

  // Indexes for performance
  await db.run('CREATE INDEX IF NOT EXISTS idx_telegram_config_user ON user_telegram_config(user_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_telegram_log_user ON telegram_message_log(user_id, sent_at)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_monitor_log_instance ON order_monitor_log(instance_id, created_at)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_analyzer_trades_instance ON analyzer_trades(instance_id, simulated_at)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_holidays_lookup ON market_holidays(exchange, holiday_date)');

  console.log('  ✅ Created order monitoring tables');
}

export async function down(db) {
  await db.run('DROP TABLE IF EXISTS market_holidays');
  await db.run('DROP TABLE IF EXISTS analyzer_trades');
  await db.run('DROP TABLE IF EXISTS order_monitor_log');
  await db.run('DROP TABLE IF EXISTS telegram_message_log');
  await db.run('DROP TABLE IF EXISTS user_telegram_config');

  console.log('  ✅ Dropped order monitoring tables');
}
```

### Order Monitor Service Structure

```javascript
// File: backend/src/services/order-monitor.service.js

class OrderMonitorService {
  constructor() {
    this.isMonitoring = false;
    this.monitorInterval = null;
    this.checkedPositions = new Map(); // In-memory cache for recent checks
  }

  /**
   * Start monitoring (called by polling service)
   */
  async start() {
    if (this.isMonitoring) {
      log.warn('Order monitor already running');
      return;
    }

    this.isMonitoring = true;

    // Load recent checked positions from database
    await this.loadCheckedPositionsFromDB();

    // Run every 5 seconds
    this.monitorInterval = setInterval(
      () => this.monitorAllPositions(),
      5000
    );

    log.info('Order monitor started');
  }

  /**
   * Load checked positions from database (last 1 hour)
   */
  async loadCheckedPositionsFromDB() {
    try {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

      const recentTriggers = await db.all(`
        SELECT instance_id, symbol, exchange, created_at
        FROM order_monitor_log
        WHERE created_at > ?
        ORDER BY created_at DESC
      `, [oneHourAgo]);

      // Populate in-memory cache
      recentTriggers.forEach(trigger => {
        const positionKey = `${trigger.instance_id}:${trigger.symbol}:${trigger.exchange}`;
        const timestamp = new Date(trigger.created_at).getTime();
        this.checkedPositions.set(positionKey, timestamp);
      });

      log.info('Loaded checked positions from database', {
        count: recentTriggers.length
      });
    } catch (error) {
      log.error('Failed to load checked positions', error);
    }
  }

  /**
   * Main monitoring loop
   */
  async monitorAllPositions() {
    try {
      // Get all ANALYZER mode instances (Phase 1: analyzer only)
      const instances = await db.all(`
        SELECT * FROM instances
        WHERE is_active = 1 AND is_analyzer_mode = 1
      `);

      if (instances.length === 0) {
        return;
      }

      // Monitor each instance
      for (const instance of instances) {
        await this.monitorInstance(instance);
      }

    } catch (error) {
      log.error('Monitor loop failed', error);
    }
  }

  /**
   * Monitor single instance
   */
  async monitorInstance(instance) {
    try {
      // Fetch position book with 10-second timeout protection
      const positions = await this._withTimeout(
        openalgoClient.getPositionBook(instance),
        10000,
        'Position book fetch timed out'
      );

      // Filter only open positions
      const openPositions = positions.filter(p => {
        const qty = this._getPositionQuantity(p);
        return qty !== 0;
      });

      // Check each position
      for (const position of openPositions) {
        await this.checkPosition(instance, position);
      }

    } catch (error) {
      log.error('Instance monitor failed', { instance: instance.id, error });
    }
  }

  /**
   * Wrap a promise with timeout
   */
  _withTimeout(promise, timeoutMs, errorMessage) {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
      )
    ]);
  }

  /**
   * Check single position for triggers
   */
  async checkPosition(instance, position) {
    // Normalize position data
    const symbol = position.symbol || position.tradingsymbol;
    const exchange = position.exchange;
    const quantity = this._getPositionQuantity(position);
    const entryPrice = parseFloat(position.average_price || position.avgprice || 0);
    const currentPrice = parseFloat(position.ltp || position.last_price || 0);

    if (entryPrice === 0 || currentPrice === 0) {
      return; // Skip invalid data
    }

    // Try to match to watchlist symbol
    const watchlistSymbol = await this.matchToWatchlist(symbol, exchange);

    if (!watchlistSymbol) {
      return; // Not in watchlist, skip
    }

    // Check if target configured
    if (watchlistSymbol.target_type === 'NONE' || !watchlistSymbol.target_value) {
      return; // No target set
    }

    // Create position key to prevent duplicate triggers
    const positionKey = `${instance.id}:${symbol}:${exchange}`;

    // Check if already triggered (in-memory cache first)
    if (this.checkedPositions.has(positionKey)) {
      return;
    }

    // Double-check database for recent triggers (last 1 hour)
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const recentTrigger = await db.get(`
      SELECT id FROM order_monitor_log
      WHERE instance_id = ? AND symbol = ? AND exchange = ?
      AND created_at > ?
      LIMIT 1
    `, [instance.id, symbol, exchange, oneHourAgo]);

    if (recentTrigger) {
      // Update cache and skip
      this.checkedPositions.set(positionKey, Date.now());
      return;
    }

    // Evaluate target
    const targetHit = this.evaluateTarget(
      entryPrice,
      currentPrice,
      watchlistSymbol.target_type,
      watchlistSymbol.target_value,
      quantity > 0 ? 'LONG' : 'SHORT'
    );

    if (targetHit) {
      // Mark as checked
      this.checkedPositions.set(positionKey, Date.now());

      // Execute simulated exit
      await this.simulateExit(instance, position, watchlistSymbol, currentPrice);

      // Clean up old checked positions (after 1 hour)
      this.cleanupCheckedPositions();
    }
  }

  /**
   * Evaluate if target is hit
   */
  evaluateTarget(entryPrice, currentPrice, targetType, targetValue, side) {
    let targetPrice;

    if (targetType === 'POINTS') {
      targetPrice = side === 'LONG'
        ? entryPrice + targetValue
        : entryPrice - targetValue;
    } else if (targetType === 'PERCENTAGE') {
      targetPrice = side === 'LONG'
        ? entryPrice * (1 + targetValue / 100)
        : entryPrice * (1 - targetValue / 100);
    } else {
      return false;
    }

    // Check if target hit
    if (side === 'LONG') {
      return currentPrice >= targetPrice;
    } else {
      return currentPrice <= targetPrice;
    }
  }

  /**
   * Simulate exit in analyzer mode
   */
  async simulateExit(instance, position, watchlistSymbol, exitPrice) {
    const symbol = position.symbol || position.tradingsymbol;
    const exchange = position.exchange;
    const quantity = Math.abs(this._getPositionQuantity(position));
    const entryPrice = parseFloat(position.average_price || position.avgprice || 0);
    const side = this._getPositionQuantity(position) > 0 ? 'LONG' : 'SHORT';

    // Calculate P&L
    const pnl = side === 'LONG'
      ? (exitPrice - entryPrice) * quantity
      : (entryPrice - exitPrice) * quantity;

    // Log to order_monitor_log
    await db.run(`
      INSERT INTO order_monitor_log
      (instance_id, symbol, exchange, trigger_type, entry_price, trigger_price,
       target_value, exit_quantity, is_analyzer_mode, simulated_pnl, exit_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      instance.id,
      symbol,
      exchange,
      'TARGET',
      entryPrice,
      exitPrice,
      watchlistSymbol.target_value,
      quantity,
      1, // is_analyzer_mode
      pnl,
      'SIMULATED',
    ]);

    // Log to analyzer_trades
    await db.run(`
      INSERT INTO analyzer_trades
      (instance_id, symbol, exchange, side, quantity, price, trade_type, pnl)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      instance.id,
      symbol,
      exchange,
      side === 'LONG' ? 'SELL' : 'BUY', // Exit side
      quantity,
      exitPrice,
      'TARGET',
      pnl,
    ]);

    // Send Telegram notification
    await this.sendTelegramAlert(instance, {
      type: 'TARGET_HIT',
      position: {
        symbol,
        exchange,
        side,
        quantity,
        entry_price: entryPrice,
        instance_name: instance.name,
      },
      trigger: {
        exit_price: exitPrice,
        exit_quantity: quantity,
      },
      pnl,
    });

    log.info('Target hit - simulated exit', {
      instance: instance.id,
      symbol,
      entry: entryPrice,
      exit: exitPrice,
      pnl,
    });
  }

  /**
   * Send Telegram alert (if configured)
   */
  async sendTelegramAlert(instance, alert) {
    try {
      // Get user ID from instance relationship
      // Query user via instance ownership (assumes instances.user_id FK exists)
      const user = await db.get(`
        SELECT u.*
        FROM users u
        INNER JOIN instances i ON u.id = i.user_id
        WHERE i.id = ?
      `, [instance.id]);

      if (user) {
        await telegramService.sendAlert(user.id, alert);
      } else {
        log.warn('No user associated with instance for Telegram alert', {
          instance_id: instance.id,
        });
      }
    } catch (error) {
      log.error('Telegram alert failed', error);
      // Log failure to telegram_message_log for audit trail
      try {
        await db.run(`
          INSERT INTO telegram_message_log
          (user_id, message_type, message_text, send_status, error_message)
          VALUES (?, ?, ?, ?, ?)
        `, [
          instance.id, // Use instance ID as fallback if user not found
          'ALERT',
          JSON.stringify(alert),
          'failed',
          error.message
        ]);
      } catch (dbError) {
        log.error('Failed to log Telegram error', dbError);
      }
    }
  }

  /**
   * Match position to watchlist symbol
   */
  async matchToWatchlist(symbol, exchange) {
    return await db.get(`
      SELECT * FROM watchlist_symbols
      WHERE symbol = ? AND exchange = ?
      AND is_enabled = 1
      LIMIT 1
    `, [symbol, exchange]);
  }

  /**
   * Clean up old checked positions
   */
  cleanupCheckedPositions() {
    const oneHourAgo = Date.now() - (60 * 60 * 1000);
    for (const [key, timestamp] of this.checkedPositions.entries()) {
      if (timestamp < oneHourAgo) {
        this.checkedPositions.delete(key);
      }
    }
  }

  /**
   * Get normalized quantity from position
   */
  _getPositionQuantity(pos) {
    const rawQty = pos.quantity ?? pos.netqty ?? pos.net_quantity ?? pos.netQty ?? pos.net ?? 0;
    return parseIntSafe(rawQty, 0);
  }

  /**
   * Stop monitoring
   */
  stop() {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    this.isMonitoring = false;
    log.info('Order monitor stopped');
  }
}

export default new OrderMonitorService();
```

---

## TESTING CHECKLIST

### Backend Tests
- [ ] Migration runs successfully
- [ ] Telegram bot responds to /start
- [ ] Linking code generation works
- [ ] Position discovery fetches data
- [ ] Target evaluation calculates correctly (points)
- [ ] Target evaluation calculates correctly (percentage)
- [ ] Simulated exits log to database
- [ ] Telegram alerts send successfully
- [ ] Duplicate trigger prevention works

### Frontend Tests
- [ ] Target configuration form displays
- [ ] Can save target (points & percentage)
- [ ] Telegram linking flow works
- [ ] Receives Telegram message with link
- [ ] Account links successfully
- [ ] Monitoring status shows active
- [ ] Trigger history displays logs
- [ ] All validations work

### Integration Tests
- [ ] End-to-end: Configure → Position → Target Hit → Alert → Log
- [ ] Multiple symbols monitored simultaneously
- [ ] Error handling (network failures, invalid data)
- [ ] Performance (handles 50+ positions)

---

## SUCCESS CRITERIA

Phase 1 is complete when:
1. ✅ Can configure target on watchlist symbol
2. ✅ Monitor detects when target is hit
3. ✅ Receives Telegram alert immediately
4. ✅ Simulated exit logged in database
5. ✅ Works reliably in analyzer mode
6. ✅ No performance issues
7. ✅ User documentation complete

---

## NEXT PHASE PREVIEW

**Phase 2 will add:**
- Stop loss monitoring
- Live mode support (real order execution)
- Multiple targets per symbol
- Email notifications (optional)

