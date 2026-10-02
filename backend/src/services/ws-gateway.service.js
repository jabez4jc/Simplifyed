/**
 * WebSocket Gateway (opt-in, feature-flagged)
 * Streams cache updates to connected clients using a simple topic envelope.
 */

import { WebSocketServer } from 'ws';
import marketDataFeedService from './market-data-feed.service.js';
import openalgoWsService from './openalgo-ws.service.js';
import { log } from '../core/logger.js';

// Standard `ws` idiom for pruning zombie clients (laptop sleep, network switch, a NAT/proxy that
// silently drops the connection): a `close` event isn't guaranteed to ever fire for those, so a
// client is pinged every PING_INTERVAL_MS and terminated if it didn't answer the PREVIOUS round -
// giving it a full interval to reply before being judged dead, not just one round-trip.
const PING_INTERVAL_MS = 30 * 1000;
// A busy symbol ticks many times a second; the browser gets the latest quote per symbol at most
// this often.
const QUOTE_FLUSH_MS = 250;

class WSGatewayService {
  constructor() {
    this.wss = null;
    this.enabled = false;
    this.path = '/stream';
    this.tokenValidator = null;
    this._pingInterval = null;
    this._pendingQuotes = new Map(); // instanceId|exchange|symbol -> latest quote
    this._quoteTimer = null;
  }

  start(server, { enabled = false, path = '/stream', tokenValidator = null } = {}) {
    if (!enabled) {
      log.info('WS Gateway disabled (WS_GATEWAY_ENABLED=false)');
      return;
    }
    if (!server) {
      log.warn('WS Gateway start skipped - no HTTP server provided');
      return;
    }
    this.enabled = true;
    this.path = path;
    this.tokenValidator = tokenValidator;
    this.wss = new WebSocketServer({ server, path: this.path });
    this._wireEvents();
    this._startPingWatchdog();
    log.info('WS Gateway started', { path: this.path });
  }

  stop() {
    clearTimeout(this._quoteTimer);
    this._quoteTimer = null;
    this._pendingQuotes.clear();
    if (this._pingInterval) {
      clearInterval(this._pingInterval);
      this._pingInterval = null;
    }
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    this.enabled = false;
  }

  _startPingWatchdog() {
    this._pingInterval = setInterval(() => {
      for (const client of this.wss.clients) {
        if (client.isAlive === false) {
          try { client.terminate(); } catch (_) { /* already gone */ }
          continue;
        }
        client.isAlive = false;
        try { client.ping(); } catch (_) { /* already gone */ }
      }
    }, PING_INTERVAL_MS);
    this._pingInterval.unref?.();
  }

  _wireEvents() {
    this.wss.on('connection', async (ws, req) => {
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const token = url.searchParams.get('token');
        const topicsParam = url.searchParams.get('topics');

        const allowed = this.tokenValidator ? await this.tokenValidator(token, req) : true;
        if (!allowed) {
          ws.close(4401, 'unauthorized');
          return;
        }

        const topics = new Set((topicsParam || '').split(',').filter(Boolean));
        ws.meta = { topics };
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });

        ws.on('error', () => {});
        ws.send(JSON.stringify({ type: 'hello' }));
      } catch (err) {
        log.warn('WS connection rejected', { error: err.message });
        ws.close(1011, 'internal error');
      }
    });

    marketDataFeedService.on('quotes:update', (payload) => this._queueQuotes(payload));
    marketDataFeedService.on('positions:update', (payload) => this.broadcast('positions:update', payload));
    marketDataFeedService.on('funds:update', (payload) => this.broadcast('funds:update', payload));
    // Relays openalgo-ws.service.js's server-to-broker order-update stream on to the browser, so
    // the frontend can confirm an ambiguous order-placement response from the push feed directly
    // instead of a REST round-trip (see quick-order-place.js's WS fuzzy-check).
    openalgoWsService.on('order_update', (payload) => this.broadcast('order_update', payload));
  }

  /** Keep only the newest quote per symbol and send the batch once per QUOTE_FLUSH_MS. */
  _queueQuotes({ instanceId, data }) {
    for (const q of data || []) {
      if (q?.symbol) this._pendingQuotes.set(`${instanceId}|${q.exchange}|${q.symbol}`, q);
    }
    if (!this._quoteTimer && this._pendingQuotes.size) {
      this._quoteTimer = setTimeout(() => this._flushQuotes(), QUOTE_FLUSH_MS);
      this._quoteTimer.unref?.();
    }
  }

  _flushQuotes() {
    this._quoteTimer = null;
    const byInstance = new Map();
    for (const [key, q] of this._pendingQuotes) {
      const instanceId = key.slice(0, key.indexOf('|'));
      if (!byInstance.has(instanceId)) byInstance.set(instanceId, []);
      byInstance.get(instanceId).push(q);
    }
    this._pendingQuotes.clear();
    for (const [instanceId, data] of byInstance) {
      this.broadcast('quotes:update', { instanceId: Number(instanceId), data });
    }
  }

  // Every instance's events are forwarded: gating on use_ws_quotes (resolved once at boot) dropped
  // positions/funds/order updates for any other instance and for any added later (H11).
  async broadcast(topic, payload) {
    if (!this.wss) return;
    try {
      const message = JSON.stringify({ topic, payload });
      for (const client of this.wss.clients) {
        if (client.readyState === client.OPEN) {
          if (client.meta?.topics?.size && !client.meta.topics.has(topic)) {
            continue;
          }
          client.send(message);
        }
      }
    } catch (err) {
      log.warn('WS broadcast failed', { error: err.message });
    }
  }
}

const wsGatewayService = new WSGatewayService();
export default wsGatewayService;
