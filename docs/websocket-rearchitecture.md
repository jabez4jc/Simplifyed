# Simplifyed Next-Gen Architecture (WebSocket-First, Layman-Friendly)

This document is a self-contained blueprint for building a WebSocket-first trading console that is fast, reliable, respects OpenAlgo limits, and remains fully themeable and user-friendly. It assumes no prior knowledge of any existing codebase. OpenAlgo provides WebSockets for **quotes/LTP/depth** only; every other broker capability is accessed via REST.

---

## 1) Goals and Non-Negotiables
- **Feature set**: watchlists, quotes, quick orders (equity/futures/options, Buyer/Writer), option chain + expiry resolution, analyzer vs live, auto-exit (targets/SL/TSL), funds/positions/orders/trades, pause/resume, settings, Telegram alerts, session target/max-loss hooks.
- **Push-first data**: quotes/LTP/depth over OpenAlgo WebSockets; deltas fanned out to clients over the app’s WebSocket gateway. REST remains for control actions and fallbacks.
- **Never break OpenAlgo limits**: per-instance RPS, RPM, orders/sec, and concurrency are guarded centrally.
- **Be reliable by design**: graceful degradation (WS -> SSE -> REST), circuit breakers, backpressure-aware queues, restart safety.
- **Be modern and themeable**: CSS-variable design tokens, multiple themes, user preference persistence.
- **Make it observable**: metrics, logs, and traces expose health, budgets, and latency.
- **Respect layers**: presentation, application, business logic, data access, security, infrastructure—each with clear responsibilities and boundaries.

---

## 2) System Map (Simple View)
```
Browsers
  | \
  |  \__ REST API (control)
  |        - log in, CRUD watchlists, place orders, settings
  |
  \____ WebSocket Gateway (stream)
           - quotes, positions/trades/orders deltas
           - health and rate-limit signals

Backend Services
  - Market Data Plane (quote streamer, caches, batcher)
  - Trading/Risk Plane (quick orders, auto-exit, session guards)
  - OpenAlgo Adapter (rate-limited HTTP client, retries, backoff)
  - Persistence (SQL + caches)

OpenAlgo Instances
  - Live and analyzer nodes
  - WebSocket endpoints for quotes/LTP/depth
  - REST endpoints for orders, trades, positions, funds, option-chain/search, health
```

---

## 3) Layered Component Breakdown (What Each Part Does)

### Layer 1: Presentation
- WebSocket + REST clients (web/mobile) consuming streams and control endpoints.
- Theme system via CSS variables; per-user preferences.
- Global pause and stale indicators driven by payload metadata.

### WebSocket Gateway
- Maintains client sessions and subscriptions to topics (quotes, positions, trades, orders, health, rate-limit).
- Pushes only changes (deltas) with sequence numbers so clients can reconcile.
- Handles auth: WS token issued after login; checks role/permissions; disconnects on expiry.
- Reconnect logic: exponential backoff, resume from last sequence if provided; falls back to SSE, then REST polling.
- Client reconnection sketch:
  ```js
  let seq = 0, delay = 500;
  function connect() {
    const ws = new WebSocket(`${WS_URL}?token=${jwt}&last_seq=${seq}`);
    ws.onmessage = (e) => { const msg = JSON.parse(e.data); seq = msg.seq; apply(msg); };
    ws.onclose = () => setTimeout(() => { delay = Math.min(delay*2, 8000); connect(); }, delay);
    ws.onerror = () => ws.close();
  }
  connect();
  ```
- Client reconnection sketch:
  ```js
  let seq = 0, delay = 500;
  function connect() {
    const ws = new WebSocket(`${WS_URL}?token=${jwt}&last_seq=${seq}`);
    ws.onmessage = (e) => { const msg = JSON.parse(e.data); seq = msg.seq; apply(msg); };
    ws.onclose = () => setTimeout(() => { delay = Math.min(delay*2, 8000); connect(); }, delay);
    ws.onerror = () => ws.close();
  }
  connect();
  ```

### REST API (Control Plane)
- All writes and administrative reads stay on REST: login/logout, watchlists CRUD, quick orders, cancel orders, settings, health checks, option-chain/expiry fetch, manual refresh triggers.
- Provides snapshot endpoints for clients that cannot use WS or need a clean resync.
- Example snapshot call:
  ```http
  GET /api/v1/snapshots/quotes?exchange=NSE&symbols=RELIANCE,BANKNIFTY
  ```

### Market Data Plane (Quote Streamer)
- **Inventory Builder**: compiles the symbol list from watchlists, open positions, expanded option chains, and active quick-order previews. Emits diffs when the list changes.
- **OpenAlgo WS Subscription Manager**: subscribes to quotes/LTP/depth streams per instance; keeps one connection per instance; auto-resubscribes on disconnect; filters only inventory symbols to minimize traffic.
- **REST Snapshot Fallback**: if WS lags or drops symbols, fetches REST quote snapshots within reserved rate limits to patch gaps.
- **Two-Tier Cache**:
  - L1 (memory): freshest quotes with timestamps and change hashes.
  - L2 (database): durable snapshots so restart does not cause a cold blank state.
- **Push Topics**:
  - `quotes:{exchange}` with `{seq, ts, symbol, ltp, bid, ask, depth, source, stale_ms}`.
  - `positions:update`, `funds:update`, `orders:update`, `trades:update`.
  - `health` (instance health, circuit states), `rate_limit` (budget remaining).
- **Backpressure control**: per-client send caps (e.g., 10 messages/sec) and coalescing to keep slow clients from blocking the hub.
- Example depth-inclusive payload:
  ```json
  {
    "seq": 1023,
    "ts": 1714123456789,
    "symbol": "RELIANCE",
    "exchange": "NSE",
    "ltp": 2510.5,
    "bid": 2510.0,
    "ask": 2511.0,
    "depth": { "bids": [[2510.0, 500]], "asks": [[2511.0, 300]] },
    "source": "ws:NSE-1",
    "stale_ms": 120
  }
  ```

### Trading and Risk Plane
- **Quick-Order Service**: BUY/SELL/SHORT/COVER/EXIT with NRML enforced for derivatives. Uses freshest positions from the data plane for sizing, then invalidates affected caches and emits order events.
- **Order Router**: per-instance queues with priorities (user actions > auto-exit > sync). Enforces orders/sec and concurrent order limits before hitting OpenAlgo.
- **Auto-Exit + Risk Controls**: consume streamed quotes, keep trailing state in durable storage, apply a small confirmation window (2–3 ticks) to avoid single-tick spikes, and publish `auto_exit:triggered`/`auto_exit:skipped`.
- **Session Guards**: when session target/max-loss triggers, enqueue close-all, cancel open orders, flip to analyzer, and broadcast the change.
- **Strategy/Risk Profiles**: optional preset profiles (e.g., Conservative/Balanced/Aggressive) that parameterize target/SL/TSL and position sizing for both single-leg and multi-leg orders.
- **Spread/Pair Handling**: spread-aware exits for options pairs/strategies; evaluate P&L at strategy level, not just per leg.
- Quick-order sizing logic:
  ```js
  function finalPosition(action, netQty, delta) {
    switch (action) {
      case 'BUY': return netQty + delta;                // grow or flip toward long
      case 'SELL': return Math.max(0, netQty - delta);  // only reduce longs
      case 'SHORT': return netQty - delta;              // grow or flip toward short
      case 'COVER': return Math.min(0, netQty + delta); // only reduce shorts
      case 'EXIT': return 0;
    }
  }
  ```
- Auto-exit decision:
  ```js
  function evaluateExit({ side, entry, ltp, targetPts, slPts, tslPts, activation, highest, lowest }) {
    const dir = side === 'LONG' ? 1 : -1;
    const target = targetPts ? entry + dir * targetPts : null;
    const stop   = slPts ? entry - dir * slPts : null;
    const profit = dir * (ltp - entry);
    const activated = activation ? profit >= activation : true;
    const triggerTSL = activated && tslPts ? (side === 'LONG'
      ? ltp <= highest - tslPts
      : ltp >= lowest + tslPts) : false;
    if (target && ((dir > 0 && ltp >= target) || (dir < 0 && ltp <= target))) return 'TARGET';
    if (stop   && ((dir > 0 && ltp <= stop)   || (dir < 0 && ltp >= stop)))   return 'STOP';
    if (triggerTSL) return 'TSL';
    return null;
  }
  ```

### OpenAlgo Adapter (WebSocket + REST, Rate-Limited)
- **WebSocket side**: manages per-instance WS connections for quotes/LTP/depth; auto-resubscribe with backoff; validates payloads; drops or flags malformed frames.
- **REST side**: token buckets per instance for RPS, RPM, orders/sec, and concurrency on all non-quote endpoints (orders, trades, positions, funds, option-chain/search, health).
- **Priority queues**: `critical` (positions for sizing, risk checks), `orders`, `background` (health/expiry refresh), `rest_quotes_fallback`. REST quotes are used only when WS is degraded and within a reserved headroom slice.
- **Request coalescing**: identical in-flight REST calls share the same promise to avoid duplicate hits.
- **Retries with jitter and circuit breakers**: open circuits push state to WS so UIs show degraded status.
- **Budget telemetry**: exposes current buckets to the WS gateway and REST so users see when budgets are tight.
- **Cold-start warmup**: hydrate caches from DB before calling OpenAlgo; ramp up gradually to avoid RPM spikes.
- Token bucket check:
  ```js
  function allow(bucket, now = Date.now()) {
    const elapsed = now - bucket.last;
    bucket.tokens = Math.min(bucket.cap, bucket.tokens + elapsed * bucket.ratePerMs);
    bucket.last = now;
    if (bucket.tokens >= 1) { bucket.tokens -= 1; return true; }
    return false;
  }
  ```
- Skeleton (Node.js, adapter + queues):
  ```js
  class Adapter {
    constructor(http, wsFactory, limits) {
      this.http = http; this.wsFactory = wsFactory; this.limits = limits;
      this.queues = { critical: [], orders: [], background: [], rest_quotes: [] };
      this.buckets = makeBuckets(limits);
      this.wsConns = new Map(); // instanceId -> ws
    }
    async ensureWs(instance) {
      if (this.wsConns.has(instance.id)) return this.wsConns.get(instance.id);
      const ws = this.wsFactory(instance.wsUrl);
      ws.on('message', (msg) => this.onWsMessage(instance, msg));
      ws.on('close', () => setTimeout(() => this.ensureWs(instance), 1000));
      this.wsConns.set(instance.id, ws);
      return ws;
    }
    enqueue(kind, instance, task) { this.queues[kind].push({ instance, task }); }
    async pump() {
      for (const kind of ['critical','orders','background','rest_quotes']) {
        const item = this.queues[kind].shift(); if (!item) continue;
        if (!allow(this.buckets[kind][item.instance.id])) { this.queues[kind].push(item); continue; }
        try { await item.task(); } catch (e) { /* record failure, maybe open circuit */ }
      }
      setImmediate(() => this.pump());
    }
  }
  ```

### Minimal WS Gateway Scaffold (Node.js, topic router)
```js
import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ server, path: '/stream' });
const clients = new Map(); // ws -> { seq, topics: Set }

function authAndTopicsFromReq(req) {
  // TODO: verify token, derive permissions/topics
  return { ok: true, topics: ['quotes:NSE', 'orders', 'health'], userId: 'u1' };
}

wss.on('connection', (ws, req) => {
  const auth = authAndTopicsFromReq(req);
  if (!auth.ok) return ws.close();
  clients.set(ws, { seq: 0, topics: new Set(auth.topics) });

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'sub') msg.topics.forEach(t => clients.get(ws).topics.add(t));
    if (msg.type === 'unsub') msg.topics.forEach(t => clients.get(ws).topics.delete(t));
    if (msg.type === 'last_seq') clients.get(ws).seq = msg.seq;
  });
  ws.on('close', () => clients.delete(ws));
});

function broadcast(topic, payload) {
  for (const [ws, meta] of clients.entries()) {
    if (!meta.topics.has(topic)) continue;
    if (ws.readyState !== ws.OPEN) continue;
    const seq = ++meta.seq;
    ws.send(JSON.stringify({ topic, seq, ...payload }));
  }
}
// Usage: broadcast('quotes:NSE', { ts, symbol, ltp })
```

### OpenAlgo WS Subscription Manager Stub
```js
import WebSocket from 'ws';

class OAStream {
  constructor(url, symbols = []) {
    this.url = url;
    this.symbols = new Set(symbols);
    this.ws = null;
  }

  connect() {
    this.ws = new WebSocket(this.url);
    this.ws.on('open', () => this._resubscribe());
    this.ws.on('message', (msg) => this._onMessage(JSON.parse(msg)));
    this.ws.on('close', () => setTimeout(() => this.connect(), 1000));
    this.ws.on('error', () => this.ws.close());
  }

  updateInventory(symbols) {
    this.symbols = new Set(symbols);
    this._resubscribe();
  }

  _resubscribe() {
    if (this.ws?.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify({ action: 'unsubscribe_all' }));
    this.ws.send(JSON.stringify({ action: 'subscribe', symbols: [...this.symbols] }));
  }

  _onMessage(frame) {
    // TODO: validate frame shape; emit to cache updater
    if (!frame.symbol || !frame.ltp) return;
    cache.update(frame.symbol, frame);
  }
}
// Usage:
// const stream = new OAStream(process.env.OA_WS_URL);
// stream.connect();
// stream.updateInventory(['NSE:RELIANCE', 'NFO:BANKNIFTY']);
```

### Token Bucket + Priority Queue Worker (REST side)
```js
class Bucket {
  constructor({ cap, ratePerMs }) {
    this.cap = cap; this.ratePerMs = ratePerMs;
    this.tokens = cap; this.last = Date.now();
  }
  allow(now = Date.now()) {
    const elapsed = now - this.last;
    this.tokens = Math.min(this.cap, this.tokens + elapsed * this.ratePerMs);
    this.last = now;
    if (this.tokens >= 1) { this.tokens -= 1; return true; }
    return false;
  }
}

class PriorityQueue {
  constructor() { this.q = { critical: [], orders: [], background: [], rest_quotes: [] }; }
  push(kind, job) { this.q[kind].push(job); }
  shift() {
    for (const kind of ['critical','orders','background','rest_quotes']) {
      if (this.q[kind].length) return this.q[kind].shift();
    }
    return null;
  }
}

async function worker(queue, buckets) {
  const job = queue.shift(); if (!job) return setTimeout(() => worker(queue,buckets), 5);
  const b = buckets[job.kind][job.instanceId];
  if (!b.allow()) { queue.push(job.kind, job); return setTimeout(() => worker(queue,buckets), 10); }
  try { await job.run(); } catch (e) { job.onError?.(e); }
  setImmediate(() => worker(queue,buckets));
}
```

### Simple Redis Cache Hook (optional)
```js
import { createClient } from 'redis';
const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

// store WS session last seq
async function storeSession(clientId, seq) {
  await redis.hSet(`ws:session:${clientId}`, { seq, ts: Date.now() });
}
// pub/sub for fan-out across nodes
redis.subscribe('broadcast', (raw) => {
  const msg = JSON.parse(raw);
  broadcast(msg.topic, msg.payload);
});
function broadcastCrossNode(topic, payload) {
  redis.publish('broadcast', JSON.stringify({ topic, payload }));
}
```

### Margin/Quality Pre-Check Example
```js
function gradeMargin({ available, required }) {
  const ratio = available / required;
  if (ratio >= 1.5) return 'A';
  if (ratio >= 1.1) return 'B';
  if (ratio >= 1.0) return 'C';
  return 'BLOCK';
}

const grade = gradeMargin({ available: funds.freeCash, required: order.margin });
if (grade === 'BLOCK') throw new Error('Insufficient margin');
return { grade, hint: grade === 'C' ? 'Tight margin; slippage risk' : undefined };
```

### Persistence and Caching
- Keep existing schema; add:
  - `quote_snapshots` (latest payload, hash, ts),
  - `trailing_state` (per position key),
  - `rate_limit_ledger` (per instance, per endpoint counters),
  - `ws_sessions` (client id, last seq, caps).
- SQLite is fine single-node; Postgres recommended if multi-writer or for read replicas (analytics without extra OpenAlgo calls).
- Warm restart: load L2 into L1, start WS, let clients resync from last sequence instead of full reload.
- Optional Redis cache for WS fan-out buffers, session state, and rate-limit ledgers to scale horizontally without hammering the DB.

### Frontend (Modern, Themeable)
- Can stay static JS or move to React/Next. Either way:
  - Use a small WS client with auto-resubscribe and buffered deltas.
  - Use a query/cache layer (e.g., TanStack Query) for snapshots and SWR patterns.
  - Normalize entities keyed by `exchange:symbol:expiry`.
- **Theme System**:
  - CSS variables for color, typography, spacing, radius, shadows.
  - Theme packs: `light`, `dark`, `terminal`, `high-contrast`.
  - Preferences stored in localStorage and in user profile via REST; applied at `:root` for instant swap.
- UX safeties: global pause stops WS subscriptions and REST fetches; stale badges use `stale_ms`; optimistic order toasts reconciled by order events.

---

## 4) Key Data Flows (Step-by-Step, No Gaps)

### A) Quote Streaming
1) Inventory builder compiles symbols from watchlists + open positions + option-chain expansions.
2) Subscription manager ensures those symbols are subscribed on each healthy OpenAlgo WS connection; prunes obsolete symbols.
3) Incoming WS frames update L1 cache with timestamps and hashes; if WS lags or misses symbols, trigger a REST snapshot within reserved headroom.
4) Cache computes deltas vs last sent sequence; gateway emits `quotes:{exchange}` messages with only changed fields.
5) Clients apply deltas; if they detect a sequence gap, they request a REST snapshot and resume from the new seq.
6) On adapter backoff or circuit open, gateway emits `rate_limit`/`health` notices so clients show degraded state and slow their local refreshes.
- Gap handling example:
  ```json
  { "type": "gap", "from": 1050, "to": 1060 }
  // client calls: GET /api/v1/snapshots/quotes?since_seq=1049
  // resumes WS with last_seq=1060
  ```
 - Sequence (WS-first quotes, REST fallback)
   ```mermaid
   sequenceDiagram
     participant Inv as Inventory Builder
     participant WS as OpenAlgo WS
     participant Cache as L1/L2 Cache
     participant GW as WS Gateway
     participant UI as Client
     Inv->>WS: subscribe(symbols)
     WS-->>Cache: quote frame (ltp/bid/ask/depth)
     Cache-->>GW: delta + seq
     GW-->>UI: quotes:{exchange} {seq, delta}
     UI-->>GW: last_seq=...
     Cache-->>GW: detects gap
     GW-->>UI: gap notice
     UI->>REST: GET /snapshots/quotes
     REST-->>UI: snapshot + new seq
     UI->>GW: resume with seq
   ```

### B) Quick Order (BUY/SELL/SHORT/COVER/EXIT)
1) User submits order over REST.
2) Quick-order service fetches freshest live positions from data plane (no stale cache) to size the final `position_size`.
3) Order router queues the request in the `critical` or `user` lane, checks orders/sec and concurrency caps, then calls OpenAlgo via the adapter.
4) Adapter response is logged with budgets; router invalidates positions/funds/orders/trades caches for that instance.
5) Gateway emits `order:acked` or `order:failed` and later `positions:update`/`orders:update`/`trades:update` deltas.
6) Optional: pre-check margin and quality grades (A/B/C) before enqueueing; attach hints to order response for UI display.

### C) Auto-Exit (Targets, SL, TSL)
1) Auto-exit loop listens to quote deltas from L1 cache (no extra OpenAlgo calls).
2) For each open position, resolve entry (position/tradebook/fallback) and current price (L1 quote).
3) Apply target/SL/TSL with a short confirmation window (wait 2–3 ticks crossing the threshold).
4) If triggered, enqueue an exit in the order router; mark pending to avoid duplicates; persist trailing state.
5) Emit `auto_exit:triggered` with reason; if skipped, emit `auto_exit:skipped` with context.

### D) Session Guard (Max Loss / Target)
1) Session metrics stream into the guard (PnL from trades/positions).
2) On breach: enqueue close-all, cancel open orders, flip instance to analyzer, and broadcast `session_guard:tripped`.
3) UI shows locked state; further orders are blocked until manually reset.

### E) Option Chain and Expiry Refresh
1) UI requests chain/expiry via REST; service uses DB cache first.
2) If missing/stale, adapter fetches via OpenAlgo REST within `background` budget; stores in DB and L1.
3) Gateway can push chain updates when ATM strike moves (optional) to keep Buyer/Writer previews correct.
- Strike resolution example (Buyer, FLOAT offset 2 OTM):
  ```js
  const atm = findATM(chain);           // e.g., 45000
  const targetStrike = atm + 2 * chain.step; // step=100
  const symbol = `${underlying}${expiryCode}${targetStrike}CE`;
  ```

### F) Restart and Resync
1) On boot, load L2 snapshots (quotes, positions, trailing) into L1.
2) Start WS gateway; clients resubscribe, sending last known sequence.
3) If sequences mismatch, server asks client to fetch REST snapshot, then resumes streaming.

---

## 5) WebSocket Topics (What Clients Receive)
- `quotes:{exchange}`: `{seq, ts, symbol, ltp, bid, ask, source, stale_ms}`
- `positions:update`: `{seq, ts, instance_id, positions:[...], stale_ms}`
- `funds:update`: `{seq, ts, instance_id, balances:[...] }`
- `orders:update`: `{seq, ts, instance_id, orders:[...]}`
- `trades:update`: `{seq, ts, instance_id, trades:[...]}`
- `order:acked` / `order:failed`: `{client_order_id, instance_id, status, message, backend_symbol}`
- `auto_exit:triggered` / `auto_exit:skipped`: `{instance_id, symbol, reason, detail}`
- `health`: `{instance_id, status, circuit_state, last_error}`
- `rate_limit`: `{instance_id, rps_left, rpm_left, orders_left, concurrency_left}`
- `settings:update`: `{category, keys, ts}` so UIs live-update.

---

## 6) Rate Limit and Efficiency Strategy (Concrete Rules)
- **Token buckets per instance (REST)**:
  - Orders: hard cap on orders/sec and concurrent orders; router enforces before adapter call.
  - Positions/funds/orderbook/tradebook/option-chain/search/health: separate buckets with conservative RPS/RPM.
  - REST quotes fallback: tiny reserved headroom used only when WS is degraded.
- **WebSocket efficiency**:
  - Single WS connection per instance for quotes/LTP/depth.
  - Filter subscriptions to inventory symbols; unsubscribe when no longer tracked.
  - Detect stale/lost symbols and patch with REST snapshot inside headroom.
- **Skip rate-limit flag**: allowed only for REST quote fallbacks within headroom; everything else must queue.
- **Backoff**: on REST rate-limit errors, double wait with jitter; open circuit and emit `rate_limit` event if repeated.
- **Cold-start ramp**: start at 25% of RPM and increase gradually over N intervals.

---

## 7) Reliability and Degradation
- **Graceful fallback**: WS -> SSE -> REST polling with cache-based ETags to minimize payloads.
- **Backpressure**: per-client send caps and message coalescing; drop lowest-priority updates first (e.g., health spam) if buffers grow.
- **Circuit breakers**: per-endpoint, per-instance. When open, the gateway warns clients and the scheduler skips that instance until cooldown.
- **Durable state**: trailing stops, last sequences, quote snapshots, and ws_sessions persisted to survive restarts.
- **Health checks**: periodic pings to instances; results streamed via `health` topic.
- Circuit breaker snippet:
  ```js
  if (failures >= threshold) {
    circuit = 'open'; reopenAt = now + cooldown + jitter();
    notifyClients({ type: 'health', circuit, reopenAt });
  }
  ```
- End-to-end reliability flow (orders)
  ```mermaid
  sequenceDiagram
    participant UI as Client
    participant API as REST API
    participant QR as Quick-Order
    participant OR as Order Router
    participant OA as OpenAlgo REST
    participant GW as WS Gateway
    UI->>API: POST /orders (payload)
    API->>QR: validate + resolve symbol
    QR->>OR: enqueue (priority=user)
    OR->>OA: placeSmartOrder (within buckets)
    OA-->>OR: ack/reject
    OR->>QR: result
    QR->>GW: emit order:acked/failed
    GW-->>UI: order event
    OR->>Caches: invalidate positions/funds/orders/trades
    Caches->>GW: positions/orders/trades deltas
    GW-->>UI: updates
  ```

---

## 8) Security and Permissions
- REST: session or JWT-based auth; role and permission checks on every route.
- WS: token issued after login; includes role/permissions; expires; server can revoke on settings change.
- Topic-level authorization: only send data for instances the user can see; avoid leaking other instances.
- Input validation: server-side schemas for all commands (orders, settings).

---

## 9) Theming and UX Details
- CSS variables define the design tokens; switching theme swaps variable values at `:root`.
- Theme packs:
  - `light`: neutral background, soft contrast.
  - `dark`: low-glare, high-contrast text.
  - `terminal`: dark with neon accents, monospace headings.
  - `high-contrast`: WCAG-friendly for accessibility.
- Preferences stored in localStorage and synced via REST per user; applied instantly without reload.
- Motion: optional micro-transitions on data updates; keep a preference to disable motion.

---

## 10) Observability (What to Measure)
- Metrics to emit: `ws_clients`, `ws_backlog`, `quote_fanout_ms`, `queue_wait_ms`, `adapter_budget_remaining`, `auto_exit_latency`, `cache_hit_rate`, `circuit_open`, `orders_routed`, `orders_blocked_by_budget`.
- Logs: structured with correlation IDs per request/order; include adapter budget before/after.
- Traces: wrap OpenAlgo calls and order flows; surface correlation IDs to UI/Telegram.
- Alerts: repeated circuit opens, budget exhaustion, auto-exit skips, WS error rate spikes.

---

## 11) Data Model Additions (Plain Language)
- `quote_snapshots`: latest quotes per symbol with hash and timestamp for warm restart and diffing.
- `trailing_state`: per instance/symbol side state for TSL (highest/lowest, activated flag, last_seen_ts).
- `rate_limit_ledger`: rolling counters for RPS/RPM/orders/sec, per instance and endpoint.
- `ws_sessions`: active connections, last sequence sent, per-client caps, and auth scope.

---

## 12) Migration Plan (Zero Downtime, Clear Exit Criteria)
1) **Adapter first**: add token buckets, queues, coalescing, and metrics on REST; add OpenAlgo WS connections for quotes/LTP/depth with reconnect/backoff. Exit: no rate-limit breaches; stable WS connections.
2) **Cache-first REST**: add L1/L2 caches; REST quote/positions endpoints read caches. Exit: REST responses come from cache; OpenAlgo traffic drops vs baseline.
3) **WS gateway opt-in**: stream payloads mirroring REST snapshots; clients can opt in while keeping REST polling as safety. Exit: majority of sessions stable on WS; no data gaps.
4) **UI WS-first**: watchlists/positions/orders/trades consume WS deltas; REST used only for reconcile and control. Exit: polling disabled by default; error budget intact.
5) **Durable risk state**: persist trailing_state and quote_snapshots; auto-exit confirmed restart-safe. Exit: restart during session does not miss TSL state.
6) **Theme rollout**: add tokens and theme packs; store preference per user. Exit: theme switch instant; preference persists across devices.
7) **Clean-up**: remove unused polling timers; finalize dashboards for budgets and health. Exit: no dead code; docs updated.

---

## 13) Success Metrics (Definition of Done)
- 50–70% fewer OpenAlgo REST calls for quotes/funds/positions per active user compared to a pure polling baseline.
- Under 150 ms median quote fan-out from cache update to client; under 500 ms for order state change delivery.
- Zero rate-limit breaches in production under expected load.
- Auto-exit and quick-order flows match the documented rules, with restart-safe trailing.
- Theme switching is instant and persists; accessibility passes contrast checks.

---

## 14) Glossary (Plain Terms)
- **Quote delta**: only the fields that changed since the last message.
- **L1 cache**: in-memory store for fastest reads.
- **L2 cache**: database snapshot used to warm L1 on restart.
- **Token bucket**: counters that limit how many requests per time window are allowed.
- **Circuit breaker**: temporary stop after repeated failures to prevent spamming a bad endpoint.
- **Headroom slice**: reserved budget for critical UX (e.g., quotes) so other traffic cannot consume it all.
- **Sequence**: ever-increasing number to order WS messages and detect gaps.
