# Simplifyed Admin

Simplifyed Admin is the control plane for running multiple OpenAlgo broker instances from a single, responsive dashboard. It combines watchlist management, quick‑order execution (equity, futures, and Buyer/Writer options modes), live market data, and broker health monitoring without breaching OpenAlgo rate limits.

---

## Highlights

- **Unified dashboard** – Collapsible navigation, stacked watchlists, help affordances, and quick access to positions and orders.
- **Buyer/Writer options workflow** – FLOAT_OFS strike selection, operating‑mode toggles, expiry management, option preview with auto‑resolved CE/PE symbols.
- **Shared market‑data feed** – Quotes, positions, and funds are polled once per interval and cached for every admin session.
- **Charting** – Historical candles per watchlist symbol (TradingView Lightweight Charts, self-hosted), with a candle cache that keeps chart traffic off the live trading rate limit and keeps charts readable while a broker is unreachable.
- **Multi-leg strategies & GTT** – Webhook-triggerable strategies with per-leg risk config, exit orders tracked as GTT triggers.
- **SQLite + services layer** – Instruments cache, option chain builder, expiry calendar, quick‑order execution engine, and health monitoring. One embedded database file, no external DB service.
- **Local email/password auth** – Built into the app, no external identity provider. `POST /api/v1/auth/register` bootstraps the first admin and then closes itself; further accounts are created by an admin under Settings → Access Control, with role-based permissions.
- **Docs as source of truth** – See [ARCHITECTURE.md](ARCHITECTURE.md) for the in‑depth architecture guide.

---

## Repository Layout

```
.
├── backend/
│   ├── public/                 # Front-end assets (dashboard.html, JS, CSS)
│   ├── src/                    # Express server, routes, services, integrations
│   ├── migrations/             # SQLite migrations (single squashed 000_initial_schema.js)
│   ├── scripts/                # Utility scripts (imports, maintenance)
│   ├── Test/                   # node:test: unit + services (offline logic), integration + live (real brokers)
│   ├── e2e/                    # Playwright browser tests against the real brokers
│   ├── package.json            # Backend dependencies + scripts
│   └── server.js               # Entry point (starts feed service + Express)
├── install.sh / uninstall-instance.sh  # Ubuntu production install/uninstall (Nginx + systemd + Let's Encrypt)
└── README.md                   # This file
```

> See [ARCHITECTURE.md](ARCHITECTURE.md) for the complete component breakdown.

---

## Installation

### Automated Installation (Recommended)

For production Ubuntu servers with domain and SSL:

```bash
# Clone the repository
git clone https://github.com/yourusername/simplifyed.git
cd simplifyed

# Run automated installer
sudo ./install.sh
```

The automated installer will:
- Install all dependencies (Node.js, Nginx, SQLite, etc.)
- Configure Nginx reverse proxy
- Obtain Let's Encrypt SSL certificate
- Set up systemd service for auto-start
- Configure firewall
- Initialize database and run migrations

**See [QUICKSTART.md](QUICKSTART.md) for a quick installation guide or [INSTALL.md](INSTALL.md) for detailed documentation.**

### Manual Installation (Development)

For local development or manual setup:

#### 1. Requirements

- Node.js 18+
- npm 9+
- SQLite 3 (CLI optional but helpful)

#### 2. Install dependencies

```bash
cd backend
npm install
```

#### 3. Configure environment

```bash
cp .env.example .env
```

`.env.example` documents every supported key. One is **required** - the server exits at startup without it:

```
JWT_SECRET=       # signs login tokens (REST and the WebSocket gateway)
```

Generate it with `openssl rand -hex 32`. Everything else has a working default.

One more key is worth setting deliberately: `WEBHOOK_TOKEN` is the *only* auth on the TradingView broadcast endpoint, which places live orders. Leave it empty and the endpoint rejects everything; set it and treat it as a trading credential. To replace it later, use **Settings → Access Control → Rotate token** - the new token takes effect immediately and overrides the `.env` value from then on.

#### 4. Run migrations

The server expects schema tables such as `application_settings`, `users`, `watchlists`, etc. If you see startup errors like `SQLITE_ERROR: no such table: users`, run:

```bash
cd backend
npm run migrate
```

Re-run this command after pulling new migrations.

#### 5. Build styling (optional for dev)

```bash
npm run build:css
```

During active development you can run Tailwind in watch mode via `npm run dev:css` (see `backend/package.json` if needed).

#### 6. Start the server

```bash
npm start            # production style
# or
npm run dev          # rebuilds CSS + restarts on change (if configured)
```

The dashboard is available at `http://localhost:3000`.

#### 7. Create the first account

No users exist yet, so bootstrap one:

```bash
curl -X POST http://localhost:3000/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"at-least-8-chars"}'
```

That first account is created as Admin, and the route then closes itself permanently - every later account is created by an admin under **Settings → Access Control**. If you lose the password, reset it from the CLI:

```bash
npm run set-password -- you@example.com new-password
```

---

## npm Scripts (backend)

| Script                  | Description |
| ----------------------- | ----------- |
| `npm start`             | Runs `server.js` once (production style). |
| `npm run dev`           | Restarts on file change (`node --watch`). |
| `npm run migrate`       | Runs pending SQLite migrations (`backend/migrations`). |
| `npm run migrate:rollback` | Rolls back the most recently applied migration. |
| `npm run build:css`     | Builds Tailwind/DaisyUI CSS for `public/css`. |
| `npm test`              | Offline logic tests, then the integration tests against the real brokers. |
| `npm run test:logic`    | `Test/unit` + `Test/services` - offline, no broker. |
| `npm run test:unit`     | Just `Test/unit`. |
| `npm run test:integration` | `Test/integration` - every route and flow on Jz Kotak, Jz Fyers and Jabez Crypto (analyzer mode), one file at a time. |
| `npm run test:e2e`      | Playwright browser tests on a copy of those three instances (port 3111). |
| `npm run test:live`     | Live order tests on all five instances, including Maha and Ana. |
| `npm run test:all`      | `npm test`, then `npm run test:e2e`. |
| `npm run lint` / `npm run format` | ESLint / Prettier over `src/`. |

Every test that touches a broker uses the real instances in `database/simplifyed.db` (copied, never written), confirms analyzer mode at the broker before any order, and closes everything it opened. There is no fake broker. See [ARCHITECTURE.md §13.5](ARCHITECTURE.md) for the rules.

---

## Using the Dashboard

| Page | What it is for |
| --- | --- |
| **Dashboard** | Totals for real-money and simulated (analyzer) accounts: P&L, trades, turnover, balance. |
| **Instances** | Your OpenAlgo accounts. Add one (Test Connection detects the broker), edit, switch between Analyzer and Live, set session target/max loss and a quantity multiplier. |
| **Watchlists** | Symbols you trade, mapped to the instances that should receive the orders. Expand a row to trade it; set targets and stop-losses in points or % of entry. A *broadcast* watchlist shows the TradingView webhook URL to paste into an alert. |
| **Chart** | Candles for any watchlist symbol, with indicators, drawing tools and order entry. |
| **Positions** | Open positions per instance, with exit buttons. |
| **Orders** | The live order book per instance, and one Order history of everything this app sent (filter by instance and status; "From" shows Watchlist, Strategy, Webhook, Manual or Test). |
| **Trades** | Fills per instance. |
| **Strategies** | Multi-leg strategies: add legs, Execute on all mapped instances, Exit All, or trigger from TradingView. |
| **Daily P&L** | End-of-day P&L snapshots. |
| **Notifications** | Health and system alerts. |
| **Settings** | *General*: order costs, trading hours, and two broker limits (orders per second, response timeout). *Access Control*: users, roles and the webhook token. *Data Management*: instruments and CSV import/export. *System Status*: health. |

**Kill switch** (top bar, red): after a confirmation, it cancels every pending order, closes every open position on every instance (live and analyzer, with LIMIT orders), and switches every instance to analyzer mode. Going back to live is manual, per instance. If a live instance still has positions it cannot close, it is left live and named in the result so you can close them at the broker.

Indian exchanges only ever receive LIMIT orders (SEBI); a "market" order is priced from live depth or quotes. Crypto takes MARKET unless you give a price.

---

## Common Tasks

### Instruments (symbols and contracts)

The instruments cache fills itself: it is refreshed from a healthy instance when it goes stale, crypto contracts are refreshed daily at 17:31 IST, and expired contracts are dropped. To refresh by hand, use **Settings → Data Management** (fetch from an instance, or upload an OpenAlgo symbols CSV).

### Accounts

The first admin is created with `POST /api/v1/auth/register` (it closes once any user exists); everyone else is added under **Settings → Access Control**. A lost password is reset there by an admin, or on the server with `npm run set-password -- <email> <new-password>`.

### Caches

- **Market data feed** starts automatically (quotes/positions/funds) after the first login. Its intervals are under Settings → Advanced → Market data.
- **Expiries** are read from the instruments cache; `/symbols/expiry?...&instanceId=` fetches them from the broker when the cache has none.

### Uninstall an instance

Use the uninstall script to completely remove a specific instance:

```bash
# Auto-detect installed instances and prompt
sudo ./uninstall-instance.sh

# Or target a specific instance identifier (e.g., dev, staging, prod)
sudo ./uninstall-instance.sh --instance dev

# Or target a specific install directory
sudo ./uninstall-instance.sh --dir /opt/simplifyed-dev
```

---

## Troubleshooting

| Symptom | Fix |
| ------- | --- |
| `SQLITE_ERROR: no such table: ...` on startup | Run `npm run migrate` to create the expected schema. |
| Quotes or positions missing | Tick "Use this instance for market data" on at least one healthy instance (Instances → Edit), and check the feed status pill in the top bar. |
| Options quick order fails with “Symbol does not support options trading” | Edit the watchlist symbol and enable `tradable_options`, or ensure the underlying is mapped in the instruments cache. |
| Unable to see options expiries | Refresh the instruments cache under Settings → Data Management. |

Logs stream to stdout via Winston; check the console for `[info]`/`[warn]`/`[error]` entries. Market-data feed events also log each refresh cycle.

---

## Additional Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) – Full architecture reference (backend services, database schema, watchlist/strategy trading workflows, API surface).
- [INSTALL.md](INSTALL.md) / [QUICKSTART.md](QUICKSTART.md) / [BEGINNER_GUIDE.md](BEGINNER_GUIDE.md) – Production install via `install.sh`.
- `backend/.env.example` – Every supported environment variable, annotated.

Keep these documents updated whenever you enhance the application - they are the canonical reference for new contributors.
