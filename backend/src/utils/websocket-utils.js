/**
 * Websocket utility helpers
 */

export function buildWebsocketUrl(hostUrl) {
  if (!hostUrl) return null;
  try {
    const parsed = new URL(hostUrl);
    const hostname = parsed.hostname;
    const port = parsed.port;

    if (parsed.protocol === 'https:') {
      const portSegment = port && port !== '443' ? `:${port}` : '';
      return `wss://${hostname}${portSegment}/ws`;
    }

    if (parsed.protocol === 'http:') {
      const portSegment = port && port !== '80' ? `:${port}` : ':8765';
      return `ws://${hostname}${portSegment}`;
    }

    return null;
  } catch (error) {
    return null;
  }
}
