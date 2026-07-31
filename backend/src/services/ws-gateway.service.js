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

class WSGatewayService {
  constructor() {
    this.wss = null;
    this.seq = 0;
    this.enabled = false;
    this.path = '/stream';
    this.tokenValidator = null;
    this.instanceFilter = null;
    this._pingInterval = null;
  }

  start(server, { enabled = false, path = '/stream', tokenValidator = null, instanceFilter = null } = {}) {
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
    this.instanceFilter = instanceFilter;
    this.wss = new WebSocketServer({ server, path: this.path });
    this._wireEvents();
    this._startPingWatchdog();
    log.info('WS Gateway started', { path: this.path });
  }

  stop() {
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
        const lastSeqParam = url.searchParams.get('last_seq');

        const allowed = this.tokenValidator ? await this.tokenValidator(token, req) : true;
        if (!allowed) {
          ws.close(4401, 'unauthorized');
          return;
        }

        const topics = new Set((topicsParam || '').split(',').filter(Boolean));
        const clientMeta = { topics, lastSeq: lastSeqParam ? Number(lastSeqParam) : 0 };
        ws.meta = clientMeta;
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });

        ws.on('error', () => {});
        ws.send(JSON.stringify({ type: 'hello', seq: this._nextSeq() }));
      } catch (err) {
        log.warn('WS connection rejected', { error: err.message });
        ws.close(1011, 'internal error');
      }
    });

    marketDataFeedService.on('quotes:update', (payload) => this.broadcast('quotes:update', payload));
    marketDataFeedService.on('positions:update', (payload) => this.broadcast('positions:update', payload));
    marketDataFeedService.on('funds:update', (payload) => this.broadcast('funds:update', payload));
    // Relays openalgo-ws.service.js's server-to-broker order-update stream on to the browser, so
    // the frontend can confirm an ambiguous order-placement response from the push feed directly
    // instead of a REST round-trip (see quick-order-place.js's WS fuzzy-check).
    openalgoWsService.on('order_update', (payload) => this.broadcast('order_update', payload));
  }

  _nextSeq() {
    this.seq += 1;
    return this.seq;
  }

  async broadcast(topic, payload) {
    if (!this.wss) return;
    try {
      const filtered = await this._filterByInstance(payload);
      if (!filtered) return;
      const message = JSON.stringify({ topic, seq: this._nextSeq(), payload: filtered });
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

  async _filterByInstance(payload) {
    if (!this.instanceFilter) return payload;
    try {
      const allowed = await this.instanceFilter();
      const ids = Array.isArray(allowed) ? new Set(allowed) : new Set();
      if (payload?.instanceId && !ids.has(payload.instanceId)) return null;
      if (payload?.instance_id && !ids.has(payload.instance_id)) return null;
      return payload;
    } catch (err) {
      log.warn('WS instance filter failed', { error: err.message });
      return null;
    }
  }
}

const wsGatewayService = new WSGatewayService();
export default wsGatewayService;
