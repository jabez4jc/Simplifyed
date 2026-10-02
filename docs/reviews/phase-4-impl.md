# Phase 4 - Docs and repo hygiene: implementation notes

Docs and repo hygiene only. No broker gate (per §9.2). After the last commit, `npm run lint` is clean and `npm run test:logic` passes 437 of 437.

## Items

| Commit | Item | What changed |
|---|---|---|
| P4-1 | §8.1 Untrack junk | `git rm --cached` of `data/sessions.db` and `backend/database/live.db.instruments`, both added to `.gitignore`. Nothing in the code reads either. `backend/link-telegram-manual.md` was already removed in Phase 2 (F2), so there was nothing to do. |
| P4-2 | §8.2 O6 + O7 | Untracked and gitignored `.agent/`, `.codex/`, `.shared/`, `.claude/skills/{banner-design,brand,design,design-system,slides}` and `backend/public/vendor/` (files stay on disk). Removed `.githooks/pre-commit` and `scripts/sync-architecture.sh`, and ran `git config --unset core.hooksPath`. I ran `scripts/sync-vendor-charts.js` and diffed its output against the committed vendor tree: identical, so postinstall fully regenerates it. `install.sh` and `update.sh` use `npm ci`, which runs postinstall. |
| P4-3 | §8.3, §8.5, §8.6 | README: openalgo-charts instead of Lightweight Charts, dropped "expiry calendar", feed starts at boot (not "after first login") and no longer points at Settings > Advanced. `.env.example`: "Settings > Broker Connection". INSTALL and BEGINNER_GUIDE: the Telegram prompt is token plus chat ID (matches `install.sh`), and `TELEGRAM_BOT_USERNAME` is replaced by `TELEGRAM_DEFAULT_CHAT_ID`. `install.sh`: removed the dead `INSTANCE_POLL_INTERVAL_MS`, `MARKET_DATA_POLL_INTERVAL_MS` and `OPENALGO_*` keys, which nothing reads. `update.sh`: dropped the TradingView-broadcast wording from the optional-keys message. |
| P4-4 | §8.4 | `ARCHITECTURE.md` rewritten from 1,017 to 256 lines: runtime, layout, modules, data flow, settings sources, jobs, invariants, data model, frontend, test layers, ops. It has no references to `pnl.service.js`, `endpoints.js`, "33 scripts" or "Simple + Advanced". I checked its claims against the code (WAL, 5 s fresh-WS window, `computeSessionPnl`, gateway topics, purge cron times). |

## Skipped or already done

- `link-telegram-manual.md`: already deleted (F2).
- `.env.example` had no `TRADINGVIEW_*` or Telegram-linking keys left (C4/F2), and `update.sh` had no env migrations for deleted keys left; only the wording above needed fixing. The line-75 "Settings > Advanced" reference had moved to line 64 and is fixed.
- `QUICKSTART.md`: no removed features. Its "Advanced" heading is about the install method, not Settings.
- The `.claude/skills/ui-styling` and `ui-ux-pro-max` skills stay tracked, because O6 does not list them.

## Verification

- §9.3 final greps (`startServices`, `_cancelAll*`, `ANCHOR_OFS`, `quote_snapshots`, `TRADINGVIEW_`, `AUTO_EXIT_`, "removed noisy log" and the rest): all empty.
- `npm run lint`: clean. `npm run test:logic`: 437 pass, 0 fail.
- Broker gates: none required for Phase 4. Phase 2 and 3 gate caveats (open Kotak and Fyers items, unclassified Fyers live failures) are untouched and still need the owner's attention.
