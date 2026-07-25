# Simplifyed Admin

Simplifyed Admin is the control plane for running multiple OpenAlgo broker instances from a single, responsive dashboard. It combines watchlist management, quick‑order execution (equity, futures, and Buyer/Writer options modes), live market data, and broker health monitoring without breaching OpenAlgo rate limits.

---

## Highlights

- **Unified dashboard** – Collapsible navigation, stacked watchlists, help affordances, and quick access to positions and orders.
- **Buyer/Writer options workflow** – FLOAT_OFS strike selection, operating‑mode toggles, expiry management, option preview with auto‑resolved CE/PE symbols.
- **Shared market‑data feed** – Quotes, positions, and funds are polled once per interval and cached for every admin session.
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
│   ├── Test/                   # node:test unit/integration tests
│   ├── package.json            # Backend dependencies + scripts
│   └── server.js               # Entry point (starts feed service + Express)
├── import-instruments*.sh/py   # Helpers for seeding instruments cache
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

`.env.example` documents every supported key. Two are **required** - the server exits at startup if either is missing:

```
SESSION_SECRET=   # signs the session cookie used for WebSocket gateway auth
JWT_SECRET=       # signs local email/password login tokens
```

Generate each with `openssl rand -hex 32`. Everything else has a working default.

One more key is worth setting deliberately: `WEBHOOK_TOKEN` is the *only* auth on the TradingView broadcast endpoint, which places live orders. Leave it empty and the endpoint rejects everything; set it and treat it as a trading credential.

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
| `npm test`              | Runs the full `Test/` suite (`node --test`). |
| `npm run test:unit` | Runs just `Test/unit`. |
| `npm run lint` / `npm run format` | ESLint / Prettier over `src/`. |

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
| Quotes or positions missing | Ensure at least one watchlist is expanded. Verify the market-data instance role is set (primary/secondary) and that the shared feed is running (check logs). |
| Options quick order fails with “Symbol does not support options trading” | Edit the watchlist symbol and enable `tradable_options`, or ensure the underlying is mapped in the instruments cache. |
| Unable to see options expiries | Refresh instruments cache (import script) or call `/symbols/expiry?symbol=...&instanceId=...` once to seed the DB. |

Logs stream to stdout via Winston; check the console for `[info]`/`[warn]`/`[error]` entries. Market-data feed events also log each refresh cycle.

---

## Additional Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) – Full architecture reference (backend services, database schema, watchlist/strategy trading workflows, API surface).
- [INSTALL.md](INSTALL.md) / [QUICKSTART.md](QUICKSTART.md) / [BEGINNER_GUIDE.md](BEGINNER_GUIDE.md) – Production install via `install.sh`.
- `backend/.env.example` – Every supported environment variable, annotated.

Keep these documents updated whenever you enhance the application - they are the canonical reference for new contributors.
