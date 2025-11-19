import WebSocket from 'ws';
import config from '../core/config.js';
import { buildWebsocketUrl } from '../utils/websocket-utils.js';
import { ValidationError } from '../core/errors.js';
import { log } from '../core/logger.js';

class WebsocketTestService {
  async testConnection({ host_url, api_key, symbol = 'NIFTY', exchange = 'NSE', mode }) {
    if (!host_url || !api_key) {
      throw new ValidationError('Host URL and API key are required for websocket tests');
    }

    const wsUrl = buildWebsocketUrl(host_url);
    if (!wsUrl) {
      throw new ValidationError('Unable to determine websocket URL from host');
    }

    const websocketMode = mode || config.marketDataFeed.websocketMode || 2;

    return new Promise((resolve, reject) => {
      let resolved = false;
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        ws.close();
        resolve({ success: false, message: 'No data received in 5 seconds' });
      }, 5000);

      const cleanup = () => {
        clearTimeout(timer);
        ws.removeAllListeners();
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.terminate();
        }
      };

      ws.on('open', () => {
        ws.send(JSON.stringify({ action: 'authenticate', api_key }));
        ws.send(JSON.stringify({
          action: 'subscribe',
          symbol: symbol.toUpperCase(),
          exchange: exchange.toUpperCase(),
          mode: websocketMode,
        }));
      });

      ws.on('message', (message) => {
        if (resolved) return;
        try {
          const payload = JSON.parse(message.toString());
          if (payload.type === 'market_data' && payload.data) {
            resolved = true;
            cleanup();
            resolve({
              success: true,
              message: `Received ${payload.mode === 3 ? 'depth' : 'quote'} data for ${symbol}`,
              payload,
            });
          }
        } catch (error) {
          log.debug('Websocket test message parse failed', { error: error.message });
        }
      });

      ws.on('error', (error) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        reject(new ValidationError(`Websocket error: ${error.message}`));
      });

      ws.on('close', (code, reason) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve({
          success: false,
          message: `Websocket closed before data arrived (code ${code})`,
          reason: reason?.toString(),
        });
      });
    });
  }
}

export default new WebsocketTestService();
