import EventEmitter from 'events';
import WebSocket from 'ws';
import { log } from '../core/logger.js';
import { isCryptoBroker, isCryptoExchange } from '../utils/broker-type.util.js';
import { backoffMs } from '../integrations/openalgo/instance-health-tracker.service.js';

const MAX_SYMBOLS_PER_INSTANCE = 500;
const RETRY_MS = 3000;
// Reconnect delay doubles per consecutive failed attempt up to this cap, and resets once a
// connection authenticates. This replaces the fixed IST quote-blackout window: a server that is
// down overnight is retried every few minutes instead of every 3s, and picked up again within
// RETRY_MAX_MS of coming back, whatever the time. The app never gives up at this layer.
const RETRY_MAX_MS = 5 * 60 * 1000;
// Reconnects for several connections dropped by the same event (a shared proxy blip) are spread
// out rather than firing in lockstep.
const RETRY_JITTER_MS = 600;
// A connection can go "silently dead" - TCP still open, broker-side gone (common behind proxies/
// load balancers) - with no `close` event ever firing. Nothing here previously asked "are we
// actually still hearing from this socket"; market-data-feed.service.js's own 10-15s quote TTL
// eventually inferred it from stale REST-side data, which is slow and indirect. This watchdog
// asks directly: if a connection hasn't produced ANY message (quote, order update, auth, ping -
// anything JSON that parsed) in WS_LIVENESS_TIMEOUT_MS, treat it as dead and reconnect through
// the exact same path a real `close` event already uses.
const WS_LIVENESS_CHECK_MS = 15 * 1000;
const WS_LIVENESS_TIMEOUT_MS = 45 * 1000;
const ORDER_UPDATE_CACHE_MAX = 500;
const ORDER_UPDATE_CACHE_TTL_MS = 10 * 60 * 1000;

const keyToSymbol = (key) => {
  const [exchange, symbol] = key.split('|');
  return { exchange, symbol };
};

/**
 * The frames that move a connection from `current` to `desired` quote subscriptions: one batched
 * `unsubscribe` for what is no longer wanted and one batched `subscribe` for what is new, per the
 * v1 WebSocket spec (`symbols` array, mode by name). Sending one frame per symbol, and never
 * unsubscribing, used to leave every symbol a watchlist ever held streaming for the life of the
 * socket.
 */
export function quoteSubscriptionFrames(current, desired) {
  const frames = [];
  const removed = [...current].filter((k) => !desired.has(k));
  const added = [...desired].filter((k) => !current.has(k));
  if (removed.length) {
    frames.push({
      action: 'unsubscribe',
      symbols: removed.map((k) => ({ ...keyToSymbol(k), mode: 'Quote' })),
    });
  }
  if (added.length) {
    frames.push({ action: 'subscribe', mode: 'Quote', symbols: added.map(keyToSymbol) });
  }
  return frames;
}

/** One batched Depth `subscribe` per requested level, for entries not already subscribed. */
export function depthSubscriptionFrames(current, desired) {
  const byLevel = new Map();
  for (const [key, entry] of desired) {
    if (current.get(key) === entry.depth_level) continue;
    if (!byLevel.has(entry.depth_level)) byLevel.set(entry.depth_level, []);
    byLevel.get(entry.depth_level).push({ exchange: entry.exchange, symbol: entry.symbol });
  }
  return [...byLevel].map(([depth, symbols]) => ({ action: 'subscribe', mode: 'Depth', depth, symbols }));
}

/**
 * A `market_data` frame as the cache wants it. The spec puts `symbol`/`exchange` on the envelope
 * and only prices in `data`; reading them from `data` worked only for brokers that happen to
 * repeat them there.
 */
export function marketDataPayload(msg) {
  const q = msg?.data;
  if (msg?.type !== 'market_data' || !q) return null;
  return {
    ...q,
    exchange: String(msg.exchange || q.exchange || '').toUpperCase(),
    symbol: String(msg.symbol || q.symbol || '').toUpperCase(),
    mode: msg.mode,
  };
}

/**
 * The spec warns a broker WebSocket and an HTTPS postback can deliver the same transition twice,
 * and says to deduplicate on these three fields.
 */
export function orderUpdateKey(order) {
  return `${order?.orderid}|${order?.order_status}|${order?.filled_quantity}`;
}

/**
 * Whether an incoming message is an application-level heartbeat, and what to answer with if so.
 * Pulled out as a pure function so it's testable without opening a real socket - the connection
 * class it's used from opens one in its constructor, which has no place in a unit test.
 *
 * The exact envelope OpenAlgo's heartbeat uses isn't documented, so both a `type` and an
 * `action` convention are recognised (the rest of this protocol uses `type` for pushed data and
 * `action` for client-initiated commands - a ping could reasonably be either), and the reply
 * carries both keys for the same reason.
 */
export function pingReplyFor(msg) {
  if (!msg || (msg.type !== 'ping' && msg.action !== 'ping')) return null;
  return { type: 'pong', action: 'pong' };
}

/**
 * Pure decision the liveness watchdog runs against every connection - separated out from
 * `_startLivenessWatchdog` (below) so it's testable without a real socket, same reasoning as
 * `pingReplyFor` above. A connection currently reconnecting (`connected: false`) is never stale -
 * it's already on its own close/error path, this check exists only to catch the "socket object
 * still says open but nothing has arrived" case that path can't see.
 */
export function isConnectionStale(conn, now = Date.now()) {
  if (!conn || !conn.connected) return false;
  const last = conn.lastMessageAt || 0;
  return now - last >= WS_LIVENESS_TIMEOUT_MS;
}

function buildWsUrl(instance) {
  if (instance.websocket_url) return instance.websocket_url;
  const base = (instance.host_url || '').trim();
  if (!base) return null;
  // Convert http/https to ws/wss while keeping path
  try {
    const parsed = new URL(base);
    parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') + '/ws';
    return parsed.toString();
  } catch {
    return null;
  }
}

class OpenAlgoWsConnection {
  constructor(instance, onQuote, onStatus) {
    this.instance = instance;
    this.onQuote = onQuote;
    this.onStatus = onStatus;
    this.onDepth = null;
    this.onOrderUpdate = null;
    this.onOrderStream = null; // (instanceId, live) - see _setOrderStream
    this.ordersSubscribed = false;
    this.ws = null;
    this.connected = false;
    this.authed = false;
    this.closed = false;
    this.desired = new Set();
    this.depthDesired = new Map(); // key -> { exchange, symbol, depth_level }
    // What the server currently holds for this socket - reset on every (re)connect, since a new
    // socket starts with nothing subscribed.
    this.subscribed = new Set();
    this.depthSubscribed = new Map(); // key -> depth level
    this._connect();
  }

  _connect() {
    if (this.closed) return;
    try {
      const wsUrl = buildWsUrl(this.instance);
      if (!wsUrl) {
        log.warn('OpenAlgo WS missing URL', { instance: this.instance.name || this.instance.id });
        return;
      }
      this.ws = new WebSocket(wsUrl);
      this.ws.on('open', () => this._onOpen());
      this.ws.on('message', (data) => this._onMessage(data));
      this.ws.on('close', () => this._scheduleReconnect());
      this.ws.on('error', (err) => {
        // First failure of a streak is worth a warning; the rest of an outage is not.
        const level = this.reconnectAttempts ? 'debug' : 'warn';
        log[level]('OpenAlgo WS error', {
          instance: this.instance.name || this.instance.id,
          error: err.message,
          reconnectAttempts: this.reconnectAttempts || 0,
        });
      });
      // Protocol-level ping: the `ws` library answers this automatically at the socket level
      // with no application code required. This handler is redundant with that default and is
      // only here so a dropped connection shows up in logs as "server pinged, we're still
      // here" rather than as a silent gap.
      this.ws.on('ping', () => {
        log.debug('OpenAlgo WS ping received', { instance: this.instance.name || this.instance.id });
      });
    } catch (err) {
      log.warn('OpenAlgo WS connect failed', { instance: this.instance.name || this.instance.id, error: err.message });
      this._scheduleReconnect();
    }
  }

  _onOpen() {
    this.connected = true;
    // A fresh connection has heard nothing yet - stamp it now so the liveness watchdog's first
    // check doesn't immediately treat it as stale before the first real message arrives.
    this.lastMessageAt = Date.now();
    this.authed = false;
    this.subscribed = new Set();
    this.depthSubscribed = new Map();
    // Subscriptions wait for the auth ack (see _onMessage): the spec authenticates first, and
    // frames sent before it lands are refused by the proxy.
    this._send({ action: 'authenticate', api_key: this.instance.api_key });
    this.onStatus?.(this.instance.id, 'connected');
  }

  _onMessage(raw) {
    // Any inbound frame counts - the watchdog only cares whether the socket is actually
    // carrying traffic, not what kind. Stamped before the parse attempt below so even a
    // malformed-but-real message (caught and ignored further down) still proves liveness.
    this.lastMessageAt = Date.now();
    try {
      const msg = JSON.parse(raw.toString());
      const payload = marketDataPayload(msg);
      if (payload) {
        if (msg.mode === 3 || payload.depth) {
          this.onDepth?.(this.instance.id, payload);
        } else {
          this.onQuote?.(this.instance.id, payload);
        }
      }
      if (msg.type === 'order_update') {
        this.onOrderUpdate?.(this.instance.id, msg);
      }
      // The order stream counts as live only once OpenAlgo acknowledges subscribe_orders - that
      // ack, not the socket being open, is what REST order polling steps back for.
      if (msg.type === 'subscribe_orders') {
        this._setOrderStream(msg.status === 'success');
        if (msg.status !== 'success') {
          log.warn('OpenAlgo WS order stream refused', { instance: this.instance.name || this.instance.id, message: msg.message });
        }
      }
      if (msg.type === 'auth') {
        if (msg.status === 'success') {
          this.authed = true;
          this.reconnectAttempts = 0;
          // Account-level order fill/status stream - same connection as quotes. Brokers without
          // a push mechanism fall back to server-side orderbook polling upstream.
          this._send({ action: 'subscribe_orders' });
          this._syncSubscriptions();
        } else {
          log.warn('OpenAlgo WS auth failed', { instance: this.instance.name || this.instance.id, message: msg.message });
        }
      }
      // Application-level heartbeat, distinct from the protocol-level ping the `ws` library
      // already auto-answers above. Some WS deployments send this instead (or as well) because
      // it survives proxies/CDNs that strip raw WebSocket control frames - every subdomain this
      // app connects to is exactly that kind of proxied deployment.
      const pingReply = pingReplyFor(msg);
      if (pingReply) this._send(pingReply);
    } catch (err) {
      // ignore malformed messages
    }
  }

  /**
   * Drop the current socket without letting its own `close` event schedule another reconnect.
   * Terminating with the listeners still attached made every watchdog-triggered reconnect (and
   * every stop()) fire `close` -> _scheduleReconnect a second time, leaving two sockets per
   * instance - or, after stop(), a socket nobody owned.
   */
  _dropSocket() {
    if (!this.ws) return;
    this.ws.removeAllListeners();
    this.ws.on('error', () => { /* late error from a socket already abandoned */ });
    try { this.ws.terminate(); } catch (_) { /* socket is already closed */ }
    this.ws = null;
  }

  _setOrderStream(live) {
    if (this.ordersSubscribed === live) return;
    this.ordersSubscribed = live;
    this.onOrderStream?.(this.instance.id, live);
  }

  _scheduleReconnect() {
    this._dropSocket();
    this.connected = false;
    this.authed = false;
    this._setOrderStream(false);
    if (this.closed) return;
    this.reconnectAttempts = (this.reconnectAttempts || 0) + 1;
    const jitter = Math.round((Math.random() * 2 - 1) * RETRY_JITTER_MS);
    const delay = Math.max(500, backoffMs(this.reconnectAttempts, RETRY_MS, RETRY_MAX_MS) + jitter);
    setTimeout(() => this._connect(), delay);
    this.onStatus?.(this.instance.id, 'reconnecting');
  }

  _send(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  close() {
    this.closed = true;
    this._dropSocket();
    this.connected = false;
    this.authed = false;
    this._setOrderStream(false);
  }

  setDepthSubscription(symbol, depthLevel = 5) {
    const exchange = (symbol?.exchange || '').toUpperCase();
    const sym = (symbol?.symbol || '').toUpperCase();
    if (!exchange || !sym) return;
    const key = `${exchange}|${sym}`;
    this.depthDesired.set(key, { exchange, symbol: sym, depth_level: depthLevel });
    this._syncSubscriptions();
  }

  _syncSubscriptions() {
    if (!this.connected || !this.authed) return;
    quoteSubscriptionFrames(this.subscribed, this.desired).forEach((msg) => this._send(msg));
    this.subscribed = new Set(this.desired);
    depthSubscriptionFrames(this.depthSubscribed, this.depthDesired).forEach((msg) => this._send(msg));
    this.depthSubscribed = new Map([...this.depthDesired].map(([k, e]) => [k, e.depth_level]));
  }
}

class OpenAlgoWsService extends EventEmitter {
  constructor() {
    super();
    this.connections = new Map(); // instanceId -> connection
    this.instances = [];
    this.orderUpdateCache = new Map(); // orderid -> { order, receivedAt } - bounded, TTL'd below
    this.orderUpdateSeen = new Map(); // orderUpdateKey -> receivedAt, for the spec's dedupe rule
    this._livenessInterval = null;
  }

  start(instances = []) {
    this.instances = instances;
    instances.forEach((inst) => {
      if (!this.connections.has(inst.id)) {
        this.connections.set(
          inst.id,
          new OpenAlgoWsConnection(
            inst,
            (instanceId, quote) => this.emit('quote', { instanceId, quote }),
            (instanceId, status) => this.emit('status', { instanceId, status })
          )
        );
        const conn = this.connections.get(inst.id);
        conn.onDepth = (instanceId, depth) => this.emit('depth', { instanceId, depth });
        conn.onOrderStream = (instanceId, live) => this.emit('order_stream', { instanceId, live });
        conn.onOrderUpdate = (instanceId, order) => {
          if (this._isDuplicateOrderUpdate(order)) return;
          this._recordOrderUpdate(order);
          this.emit('order_update', { instanceId, order });
        };
      }
    });
    this._startLivenessWatchdog();
  }

  /**
   * Reconnects any connection that has gone silently dead - see the WS_LIVENESS_TIMEOUT_MS doc
   * comment at the top of this file for why this exists (a `close` event alone is not enough).
   * One shared interval for every connection, not one per connection - N sockets should not mean
   * N timers for the same check.
   */
  _startLivenessWatchdog() {
    if (this._livenessInterval) return;
    this._livenessInterval = setInterval(() => {
      const now = Date.now();
      for (const conn of this.connections.values()) {
        // The spec's `ping` action answers with `pong`, so a socket with nothing subscribed
        // (after hours, or orders-only) still proves it is alive instead of being torn down.
        if (conn.authed) conn._send({ action: 'ping' });
        if (!isConnectionStale(conn, now)) continue;
        log.warn('OpenAlgo WS liveness check failed - reconnecting', {
          instance: conn.instance?.name || conn.instance?.id,
          silentForMs: now - (conn.lastMessageAt || 0),
        });
        conn._scheduleReconnect();
      }
    }, WS_LIVENESS_CHECK_MS);
    this._livenessInterval.unref?.();
  }

  /**
   * Sync subscriptions across instances. Distributes symbols evenly (up to 500 per instance).
   * @param {Array<{symbol:string, exchange:string}>} symbols
   */
  syncAll(symbols = [], preferredInstances = new Map()) {
    if (this.connections.size === 0 && this.instances.length > 0) {
      this.start(this.instances);
    }
    if (this.connections.size === 0) return;
    const symbolsUpper = symbols.map((s) => ({
      symbol: (s.symbol || '').toUpperCase(),
      exchange: (s.exchange || '').toUpperCase(),
    }));

    const conns = Array.from(this.connections.values());
    // Reset the wanted set only; _syncSubscriptions below diffs it against what each socket
    // already holds, so an unchanged symbol is neither unsubscribed nor resubscribed.
    conns.forEach((c) => c.desired.clear());

    /**
     * Round-robin never checked whether a connection's BROKER could serve a symbol's exchange
     * at all. With a crypto instance and an Indian broker instance as the only two connections,
     * an Indian index (NIFTY, NSE_INDEX) had a coin-flip chance of being assigned to the crypto
     * connection - which has no NSE session to subscribe to, so no quote for that symbol ever
     * arrives on it. The symbol still shows as "subscribed" and the chart still polls, so the
     * failure is invisible: the snapshot just never updates, and gets older forever. Observed
     * live: NIFTY landed on the crypto connection and its cached quote was 190 days old.
     */
    const compatible = (conn, exchange) => (isCryptoExchange(exchange)
      ? isCryptoBroker(conn.instance?.broker)
      : !isCryptoBroker(conn.instance?.broker));

    const idxByBucket = new Map(); // 'crypto' | 'indian' -> next round-robin index
    for (const sym of symbolsUpper) {
      const key = `${sym.exchange}|${sym.symbol}`;
      const pool = conns.filter((c) => compatible(c, sym.exchange));
      if (!pool.length) continue; // no connection can possibly serve this exchange

      let targetConn = null;
      const preferredId = preferredInstances.get(key);
      if (preferredId && this.connections.has(preferredId)) {
        const candidate = this.connections.get(preferredId);
        if (pool.includes(candidate) && (candidate.desired.size || 0) < MAX_SYMBOLS_PER_INSTANCE) {
          targetConn = candidate;
        }
      }
      if (!targetConn) {
        const bucket = isCryptoExchange(sym.exchange) ? 'crypto' : 'indian';
        const idx = idxByBucket.get(bucket) || 0;
        targetConn = pool[idx % pool.length];
        idxByBucket.set(bucket, idx + 1);
      }
      if ((targetConn.desired.size || 0) >= MAX_SYMBOLS_PER_INSTANCE) {
        continue;
      }
      targetConn.desired.add(key);
    }

    conns.forEach((c) => c._syncSubscriptions());
  }

  /**
   * Introspection: current subscriptions per instance
   */
  getSubscriptions() {
    const subs = [];
    for (const [instanceId, conn] of this.connections.entries()) {
      const items = Array.from(conn.desired).map((k) => {
        const [exchange, symbol] = k.split('|');
        return { exchange, symbol };
      });
      subs.push({
        instanceId,
        instanceName: conn.instance?.name || null,
        websocketUrl: buildWsUrl(conn.instance),
        connected: conn.connected === true,
        subscriptionCount: items.length,
        symbols: items,
      });
    }
    return subs;
  }

  getActiveConnectionCount() {
    let count = 0;
    for (const [, conn] of this.connections.entries()) {
      if (conn.connected) count += 1;
    }
    return count;
  }

  getConnectedInstanceIds() {
    const ids = [];
    for (const [instanceId, conn] of this.connections.entries()) {
      if (conn.connected) ids.push(instanceId);
    }
    return ids;
  }

  subscribeSymbol(instanceId, symbol) {
    const conn = this.connections.get(instanceId);
    if (!conn || !conn.connected) return false;
    const exchange = (symbol?.exchange || '').toUpperCase();
    const sym = (symbol?.symbol || '').toUpperCase();
    if (!exchange || !sym) return false;
    const key = `${exchange}|${sym}`;
    conn.desired.add(key);
    conn._syncSubscriptions();
    return true;
  }

  subscribeDepth(instanceId, symbol, depthLevel = 5) {
    const conn = this.connections.get(instanceId);
    if (!conn || !conn.connected) return false;
    conn.setDepthSubscription(symbol, depthLevel);
    return true;
  }

  /**
   * Whether this instance's order updates are arriving by push right now: socket open,
   * authenticated, and `subscribe_orders` acknowledged. REST order polling steps back only while
   * this is true (see polling.service.js).
   */
  isOrderStreamLive(instanceId) {
    const conn = this.connections.get(instanceId);
    return Boolean(conn?.connected && conn.authed && conn.ordersSubscribed);
  }

  hasActiveConnections() {
    return this.getActiveConnectionCount() > 0;
  }

  _isDuplicateOrderUpdate(order) {
    const key = orderUpdateKey(order);
    const seen = this.orderUpdateSeen.get(key);
    const now = Date.now();
    if (seen && now - seen < ORDER_UPDATE_CACHE_TTL_MS) return true;
    this.orderUpdateSeen.set(key, now);
    if (this.orderUpdateSeen.size > ORDER_UPDATE_CACHE_MAX) {
      this.orderUpdateSeen.delete(this.orderUpdateSeen.keys().next().value);
    }
    return false;
  }

  _recordOrderUpdate(order) {
    const orderId = order?.orderid;
    if (!orderId) return;
    this.orderUpdateCache.set(orderId, { order, receivedAt: Date.now() });
    if (this.orderUpdateCache.size > ORDER_UPDATE_CACHE_MAX) {
      // Map preserves insertion order - first key is the oldest. A simple FIFO bound is enough
      // here; this cache only needs to answer "did we hear about this order recently," not act
      // as a long-lived store.
      this.orderUpdateCache.delete(this.orderUpdateCache.keys().next().value);
    }
  }

  /**
   * Already-seen order_update for this orderid, if any and not expired. Read-only, no waiting.
   */
  getOrderUpdate(orderId) {
    const entry = this.orderUpdateCache.get(orderId);
    if (!entry) return null;
    if (Date.now() - entry.receivedAt > ORDER_UPDATE_CACHE_TTL_MS) {
      this.orderUpdateCache.delete(orderId);
      return null;
    }
    return entry.order;
  }

  /**
   * Resolves with the order_update payload for orderId - immediately if already cached, or as
   * soon as one arrives within timeoutMs, or null if neither happens. Callers (order-retry's
   * status confirmation) should fall back to a REST status check on null, same as before this
   * existed - this only ever gives a faster/more-reliable answer, never a worse one.
   */
  waitForOrderUpdate(orderId, timeoutMs = 1500) {
    const cached = this.getOrderUpdate(orderId);
    if (cached) return Promise.resolve(cached);
    if (!orderId) return Promise.resolve(null);

    return new Promise((resolve) => {
      let settled = false;
      const onUpdate = ({ order }) => {
        if (settled || order?.orderid !== orderId) return;
        settled = true;
        clearTimeout(timer);
        this.off('order_update', onUpdate);
        resolve(order);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.off('order_update', onUpdate);
        resolve(null);
      }, timeoutMs);
      this.on('order_update', onUpdate);
    });
  }

  stop() {
    for (const [, conn] of this.connections.entries()) {
      conn.close();
    }
    this.connections.clear();
    if (this._livenessInterval) {
      clearInterval(this._livenessInterval);
      this._livenessInterval = null;
    }
  }
}

const openalgoWsService = new OpenAlgoWsService();
export default openalgoWsService;
