# Simplifyed Admin

Simplifyed Admin is the control plane for running multiple OpenAlgo broker instances from a single, responsive dashboard. It combines watchlist management, quick‑order execution (equity, futures, and Buyer/Writer options modes), live market data, and broker health monitoring without breaching OpenAlgo rate limits.

---

## Highlights

- **Unified dashboard** – Collapsible navigation, stacked watchlists, help affordances, and quick access to positions and orders.
- **Buyer/Writer options workflow** – FLOAT_OFS strike selection, operating‑mode toggles, expiry management, option preview with auto‑resolved CE/PE symbols.
- **Shared market‑data feed** – Quotes, positions, and funds are polled once per interval and cached for every admin session.
- **SQLite + services layer** – Instruments cache, option chain builder, expiry calendar, quick‑order execution engine, and health monitoring.
- **Docs as source of truth** – See `docs/application_architecture.md` for the in‑depth architecture guide and `docs/market_data_feed_service.md` for the rate‑limit strategy.

---

## Repository Layout

```
.
├── backend/
│   ├── public/                 # Front-end assets (dashboard.html, JS, CSS)
│   ├── src/                    # Express server, routes, services, integrations
│   ├── migrations/             # SQLite migrations
│   ├── scripts/                # Utility scripts (imports, maintenance)
│   ├── package.json            # Backend dependencies + scripts
│   └── server.js               # Entry point (starts feed service + Express)
├── docs/                       # Living documentation (architecture, services, feeds)
├── Requirements/               # Functional specs (options workflow, option-chain guide)
├── import-instruments*.sh/py   # Helpers for seeding instruments cache
└── README.md                   # This file
```

> See `docs/application_architecture.md` for the complete component breakdown.

---

## Getting Started

### 1. Requirements

- Node.js 18+
- npm 9+
- SQLite 3 (CLI optional but helpful)

### 2. Install dependencies

```bash
cd backend
npm install
```

### 3. Configure environment

Copy `.env.example` (if provided) to `.env` and populate:

```
PORT=3000
SESSION_SECRET=replace-me
DATABASE_PATH=./database/simplifyed.db
OPENALGO_PROXY=          # optional
GOOGLE_CLIENT_ID=...     # optional (required for OAuth login)
GOOGLE_CLIENT_SECRET=...
TELEGRAM_BOT_TOKEN=...   # optional (alerting)
```

### 4. Run migrations

The server expects schema tables such as `application_settings`, `users`, `watchlists`, etc. If you see startup errors like `SQLITE_ERROR: no such table: users`, run:

```bash
cd backend
npm run migrate
```

Re-run this command after pulling new migrations.

### 5. Build styling (optional for dev)

```bash
npm run build:css
```

During active development you can run Tailwind in watch mode via `npm run dev:css` (see `backend/package.json` if needed).

### 6. Start the server

```bash
npm start            # production style
# or
npm run dev          # rebuilds CSS + restarts on change (if configured)
```

The dashboard is available at `http://localhost:3000`. Login is handled via the configured auth strategy (local/session or Google OAuth depending on environment).

---

## npm Scripts (backend)

| Script              | Description |
| ------------------- | ----------- |
| `npm start`         | Runs `server.js` once (production style). |
| `npm run dev`       | Starts the dev server with optional file watching (configure per need). |
| `npm run migrate`   | Runs pending SQLite migrations (`backend/migrations`). |
| `npm run build:css` | Builds Tailwind/DaisyUI CSS for `public/css`. |

> Unit tests were removed in this branch; reintroduce them under `backend/tests/` if required.

---

## Common Tasks

### Import instruments

Use one of the helper scripts to populate the `instruments` table (required for option-chain resolution and symbol search). Example:

```bash
./import-instruments.sh --exchange NFO --instance-id 12
```

### Seed settings/users

If you need default settings or an admin account, add seed data through migrations or SQLite CLI:

```bash
sqlite3 backend/database/simplifyed.db ".tables"
```

### Rebuild/refresh caches

- **Market data feed** starts automatically (quotes/positions/funds). Restart the server if you change feed configuration.
- **Expiry cache**: schedule auto-refresh via `expiry-management.service` or trigger manually via the `/symbols/expiry` route with `instanceId`.

---

## Troubleshooting

| Symptom | Fix |
| ------- | --- |
| `SQLITE_ERROR: no such table: ...` on startup | Run `npm run migrate` to create the expected schema. |
| Quotes or positions missing | Ensure at least one watchlist is expanded. Verify the market-data instance role is set (primary/secondary) and that the shared feed is running (check logs). |
| Options quick order fails with “Symbol does not support options trading” | Edit the watchlist symbol and enable `tradable_options`, or ensure the underlying is mapped in the instruments cache. |
| Unable to see options expiries | Refresh instruments cache (import script) or call `/symbols/expiry?symbol=...&instanceId=...` once to seed the DB. |

Logs stream to stdout via Winston; check the console for `[info]`/`[warn]`/`[error]` entries. Market-data feed events also log each refresh cycle.

---

## Additional Documentation

- `docs/application_architecture.md` – Full architecture reference (frontend modules, backend services, database schema, workflows).
- `docs/market_data_feed_service.md` – Shared feed design and rate-limit inventory.
- `Requirements/Options_Mode_Implementation_Guide_v1.4.md` – Functional specs for FLOAT_OFS / Buyer‑Writer options workflows.

Keep these documents updated whenever you enhance the application—they are the canonical reference for new contributors. If you add new routes or services, document them under `docs/` and reference them here.
