import EventEmitter from 'events';
import WebSocket from 'ws';
import { log } from '../core/logger.js';

const MAX_SYMBOLS_PER_INSTANCE = 500;
const RETRY_MS = 3000;

function serializeSubscribe(symbols) {
  return symbols.map((s) => ({
    action: 'subscribe',
    symbol: s.symbol,
    exchange: s.exchange,
    mode: 2, // Quote mode (includes LTP)
  }));
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
    this.ws = null;
    this.connected = false;
    this.desired = new Set();
    this._connect();
  }

  _connect() {
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
        log.warn('OpenAlgo WS error', { instance: this.instance.name || this.instance.id, error: err.message });
      });
    } catch (err) {
      log.warn('OpenAlgo WS connect failed', { instance: this.instance.name || this.instance.id, error: err.message });
      this._scheduleReconnect();
    }
  }

  _onOpen() {
    this.connected = true;
    this._send({ action: 'authenticate', api_key: this.instance.api_key });
    this._syncSubscriptions();
    this.onStatus?.(this.instance.id, 'connected');
  }

  _onMessage(raw) {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'market_data' && msg.data) {
        const q = msg.data;
        this.onQuote?.(this.instance.id, {
          ...q,
          exchange: (q.exchange || '').toUpperCase(),
          symbol: (q.symbol || '').toUpperCase(),
          mode: msg.mode,
        });
      }
      if (msg.type === 'auth' && msg.status !== 'success') {
        log.warn('OpenAlgo WS auth failed', { instance: this.instance.name || this.instance.id, message: msg.message });
      }
    } catch (err) {
      // ignore malformed messages
    }
  }

  _scheduleReconnect() {
    if (this.ws) {
      try { this.ws.terminate(); } catch (_) {}
    }
    this.connected = false;
    setTimeout(() => this._connect(), RETRY_MS);
    this.onStatus?.(this.instance.id, 'reconnecting');
  }

  _send(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  setSubscriptions(symbols) {
    this.desired = new Set(symbols.map((s) => `${s.exchange}|${s.symbol}`));
    this._syncSubscriptions();
  }

  _syncSubscriptions() {
    if (!this.connected || this.desired.size === 0) return;
    const symbols = Array.from(this.desired).map((key) => {
      const [exchange, symbol] = key.split('|');
      return { exchange, symbol };
    });
    serializeSubscribe(symbols).forEach((msg) => this._send(msg));
  }
}

class OpenAlgoWsService extends EventEmitter {
  constructor() {
    super();
    this.connections = new Map(); // instanceId -> connection
    this.instances = [];
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
      }
    });
  }

  /**
   * Sync subscriptions across instances. Distributes symbols evenly (up to 500 per instance).
   * @param {Array<{symbol:string, exchange:string}>} symbols
   */
  syncAll(symbols = [], preferredInstances = new Map()) {
    if (this.connections.size === 0) return;
    const symbolsUpper = symbols.map((s) => ({
      symbol: (s.symbol || '').toUpperCase(),
      exchange: (s.exchange || '').toUpperCase(),
    }));

    const conns = Array.from(this.connections.values());
    let idx = 0;
    conns.forEach((c) => c.setSubscriptions([])); // reset

    for (const sym of symbolsUpper) {
      const key = `${sym.exchange}|${sym.symbol}`;
      // Prefer instance with non-zero LTP if provided
      let targetConn = null;
      const preferredId = preferredInstances.get(key);
      if (preferredId && this.connections.has(preferredId)) {
        const candidate = this.connections.get(preferredId);
        if ((candidate.desired.size || 0) < MAX_SYMBOLS_PER_INSTANCE) {
          targetConn = candidate;
        }
      }
      if (!targetConn) {
        // Round-robin fallback
        targetConn = conns[idx % conns.length];
        idx += 1;
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
}

const openalgoWsService = new OpenAlgoWsService();
export default openalgoWsService;
