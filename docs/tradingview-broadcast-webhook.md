# TradingView Broadcast Webhook Requirements

This document describes a standalone webhook service that receives TradingView alerts in the same format used by OpenAlgo `placesmartorder` and fans the signal out to multiple OpenAlgo instances. The goal is to keep TradingView payloads simple, inject per-instance API keys server-side, and return a concise aggregated status.

## Architecture Overview
- **Ingress**: Single HTTPS endpoint `POST /webhook/tradingview/broadcast`, secured with a shared token header.
- **Validation**: Enforce the SmartOrder-like schema (see Payload Schema). Normalize defaults and uppercase `action`.
- **Fan-out**: For each configured OpenAlgo instance, POST the normalized payload (with that instance’s `apikey` injected) to `/api/v1/placesmartorder`.
- **Concurrency**: Dispatch downstream requests concurrently; throttle per target to respect rate limits.
- **Aggregation**: Summarize per-instance results; overall success if at least one target succeeded, otherwise 502.
- **Observability**: Log masked payloads, per-target statuses, retries, and latency.

## Endpoint & Ingress Requirements
- **Route**: `POST /webhook/tradingview/broadcast` (or `/webhook/tradingview/broadcast/:slug` to target a broadcast watchlist)
- **Auth**: Require `X-Webhook-Token: <token>` (env-driven). Optionally IP-allowlist TradingView ranges.
- **Content types**:
  - `application/json`
  - `text/plain` (body is JSON string)
  - `application/x-www-form-urlencoded` with one of `payload|data|json|message` containing JSON; otherwise use form fields directly.
- **Responses**:
  - `200` if ≥1 downstream success; `502` if all downstream calls fail; `4xx` for validation/auth errors.
  - Body includes per-instance results (status or error message), never downstream bodies.
  - Optional `watchlist` object returned when slug/ID is used (includes `id`, `name`, `webhook_slug`, `webhook_url`).

## Payload Schema (SmartOrder-compatible)
- **Required**:
  - `strategy` (string)
  - `exchange` (string; e.g., NSE/NFO/BSE/BFO/CDS/MCX)
  - `symbol` (string)
  - `action` (string; BUY or SELL, case-insensitive)
  - `position_size` (integer; target position size, can be negative for short)
  - `quantity` (integer ≥ 0; additional quantity to reach target)
- **Optional with defaults**:
  - `pricetype` (default `MARKET`; allowed: MARKET, LIMIT, SL, SL-M)
  - `product` (default `MIS`; allowed: MIS, NRML, CNC)
  - `price` (default `0`)
  - `trigger_price` (default `0`)
  - `disclosed_quantity` (default `0`)
- **Key handling**:
  - Ignore or overwrite any inbound `apikey`; inject per-target keys server-side.
  - Normalize strings (trim, uppercase `action`), apply defaults on missing values.

## Configuration
- **Environment variables**:
  - `WEBHOOK_TOKEN`: shared secret for ingress auth.
  - Broadcast targets are resolved from the assigned instances of a broadcast watchlist.
    ```json
    [
      { "name": "nyc", "url": "https://nyc.example.com", "apikey": "abc" },
      { "name": "lon", "url": "https://lon.example.com", "apikey": "def" }
    ]
    ```
  - Optional tuning:
    - `TRADINGVIEW_BROADCAST_TIMEOUT_MS` (default `3000`)
    - `TRADINGVIEW_BROADCAST_RETRIES` (default `2`)
    - `TRADINGVIEW_BROADCAST_RETRY_DELAY_MS` (default `250` + jitter)
    - `TRADINGVIEW_BROADCAST_DEFAULT_RPS` (default `2`)
  - Optional per-target throttle (tokens/sec) to honor OpenAlgo smart-order defaults (commonly 2/s).
- **Targets**:
  - If you call `/webhook/tradingview/broadcast/:slug` (or query `?watchlistId=123`), targets are derived from the assigned instances on that broadcast watchlist (only active instances with API keys and host URLs).
- The webhook requires a watchlist id/slug so targets can be resolved from that watchlist.
- **Runtime**: Node.js (Express) or similar; HTTPS termination in front.

## Core Flow
1) Authenticate request via `X-Webhook-Token`.  
2) Parse body (json/text/form) into an object; reject if parsing fails.  
3) Validate and normalize against the schema; uppercase `action`; apply defaults.  
4) For each target instance:
   - Build payload: `{ ...normalized, apikey: target.apikey }`.
   - POST to `${target.url}/api/v1/placesmartorder` with a short timeout (2–3s).
   - Respect per-target throttle if configured.
5) Run fan-out concurrently (e.g., `Promise.allSettled`).  
6) Aggregate per-instance results; return 200 if any success, otherwise 502.  
7) Log masked input and per-target outcomes.

## Error Handling & Retries
- Retry downstream requests on 5xx/timeouts with small backoff (e.g., 2 retries, 200–400 ms jitter).
- Do not retry on downstream 4xx validation errors.
- Mask secrets (apikeys, tokens) in logs and error messages.

## Security
- Require the webhook token; reject missing/invalid token with 401.
- Do not echo downstream responses; only status and brief error messages.
- Keep downstream API keys server-side; never expose to TradingView.
- Enforce HTTPS; optionally IP-allowlist TradingView sources.

## Rate Limiting (Per Target)
- Default smart-order rate on OpenAlgo is commonly 2 requests/second.
- Implement a per-target token bucket or queue to avoid 429s.
- If queueing is enabled, consider max queue length; drop or 429 when full.

## Express Route Example (Node)
```js
import express from 'express';
import axios from 'axios';

// Targets are derived from the broadcast watchlist's assigned instances.
const router = express.Router();
const tryJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

router.post('/webhook/tradingview/broadcast', express.text({ type: '*/*' }), async (req, res) => {
  // Auth
  if (process.env.WEBHOOK_TOKEN && req.get('X-Webhook-Token') !== process.env.WEBHOOK_TOKEN) {
    return res.status(401).json({ status: 'error', message: 'Unauthorized' });
  }

  // Parse body
  let data = tryJson(req.body) || (req.is('application/json') ? req.body : null);
  if (!data && req.is('application/x-www-form-urlencoded')) {
    const field = ['payload', 'data', 'json', 'message'].find((k) => k in req.body);
    data = field ? tryJson(req.body[field]) : req.body;
  }
  if (!data) return res.status(400).json({ status: 'error', message: 'Request body must be valid JSON' });

  // TODO: validate/normalize per schema; uppercase action; apply defaults
  const normalized = {
    pricetype: 'MARKET',
    product: 'MIS',
    price: 0,
    trigger_price: 0,
    disclosed_quantity: 0,
    ...data,
  };
  normalized.action = String(normalized.action || '').toUpperCase();

  // Fan-out
  const results = await Promise.allSettled(targets.map((t) => {
    const payload = { ...normalized, apikey: t.apikey };
    return axios.post(`${t.url.replace(/\\/$/, '')}/api/v1/placesmartorder`, payload, { timeout: 3000 });
  }));

  const summary = results.map((r, i) =>
    r.status === 'fulfilled'
      ? { target: targets[i].name || targets[i].url, ok: true, status: r.value.status }
      : { target: targets[i].name || targets[i].url, ok: false, error: r.reason?.message }
  );
  const okCount = summary.filter((s) => s.ok).length;
  return res.status(okCount ? 200 : 502).json({ status: okCount ? 'ok' : 'error', results: summary });
});

export default router;
```

## Per-Target Throttle Sketch
```js
// Simple token bucket per target (tokens/sec)
class TokenBucket {
  constructor(rate, burst = rate) {
    this.rate = rate;
    this.capacity = burst;
    this.tokens = burst;
    this.last = Date.now();
  }
  take() {
    const now = Date.now();
    const delta = (now - this.last) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + delta * this.rate);
    this.last = now;
    if (this.tokens >= 1) { this.tokens -= 1; return true; }
    return false;
  }
}
```

## Deployment
- Expose HTTPS with a valid certificate; ensure outbound connectivity to all OpenAlgo instances (VPN/tunnel if needed).
- Keep secrets (webhook token, instance API keys) in env/secret manager; avoid logging them.
- Timeouts: keep outbound timeouts short (2–3s) to avoid blocking TradingView; if latency is a concern, respond 202 and process async.

## Test Plan
- **Unit**: schema validation (valid/invalid payloads), action normalization, default application.
- **Integration**: run two mock downstream servers; post a sample payload and verify fan-out, aggregation, and masking.
- **Load/Rate**: burst tests to confirm per-target throttling avoids 429s; verify retry behavior on 5xx/timeouts.

## Extensibility
- Support additional OpenAlgo endpoints (placeorder, baskets, options) by allowing endpoint selection per target or by payload type.
- UI hooks (e.g., in Simplifyed): allow a “Broadcast webhook” watchlist to list target instances, show the webhook URL/token, and display the sample TradingView JSON to paste into alerts.
- Optional filtering: gate fan-out by symbol/exchange if you later want selective routing.

## Integration Steps for Simplifyed
The following assumes Simplifyed already manages instances and watchlists.

1) **Config model**  
   - Add a watchlist flag/type for broadcast (no symbols required).  
   - Ensure each instance record has `name`, `baseUrl`, `apiKey`.  
   - Store `WEBHOOK_TOKEN` in Simplifyed’s config/env.

2) **Server wiring**  
   - Add the `POST /webhook/tradingview/broadcast` route (Express code above) to the Simplifyed API server.  
   - Mount middleware: `express.text({ type: '*/*' })` plus `express.urlencoded({ extended: true })` to catch form posts.  
   - Add a small schema validator (e.g., Zod) to enforce the payload rules and defaults.

3) **Instance selection**  
   - For the broadcast watchlist, resolve the list of target instances (all, or those attached to that watchlist).  
   - Build broadcast targets dynamically from the watchlist's assigned instances.
     ```js
     const targets = instances.map(i => ({
       name: i.name,
       url: i.baseUrl,
       apikey: i.apiKey
     }));
     ```

4) **UI updates**  
   - In the watchlist UI, add “Broadcast webhook” as a special watchlist: no symbols, just associated instances.  
   - Display the generated webhook URL and `X-Webhook-Token` for the user to paste into TradingView.  
   - Show the sample JSON payload (SmartOrder format) in the UI for copy/paste.

5) **Persistence and secrets**  
   - Keep instance API keys server-side only. Do not expose them in the UI or logs.  
   - Store the webhook token in your existing secret mechanism (env, vault).  
   - Mask secrets in logs (apikeys, tokens).

6) **Rate limiting inside Simplifyed**  
   - Implement per-instance token buckets before calling OpenAlgo to avoid hitting `/placesmartorder` rate limits.  
   - Optionally surface throttle state in the UI (e.g., “delaying due to rate limit”).

7) **Testing in Simplifyed**  
   - Add an internal test page or CLI to POST a sample payload to `/webhook/tradingview/broadcast` (optionally `/broadcast/:slug`) and display per-instance results.  
   - Verify: auth failures (wrong token), validation failures (missing fields), partial downstream failures (one instance down), and throttle behavior.

8) **Deployment**  
   - Ensure Simplifyed’s public endpoint is HTTPS and reachable by TradingView.  
   - If instances are private, confirm Simplifyed host can reach them (VPN/tunnel).  
   - Set timeouts (2–3s) and retries as noted; consider 202 async mode if you need to respond immediately.

## Creating a Broadcast Watchlist (Simplifyed API)
- Create: `POST /api/v1/watchlists` with body `{ "name": "TV Broadcast", "type": "broadcast" }`.
- Assign instances: `POST /api/v1/watchlists/:id/instances` for each downstream OpenAlgo instance.
- Use the webhook: `POST /webhook/tradingview/broadcast/:slug` (slug returned with the watchlist) or `POST /webhook/tradingview/broadcast?watchlistId=:id`.
- The webhook fans out to all active instances assigned to the broadcast watchlist.
