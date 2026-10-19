# Live broker tests

These talk to **real OpenAlgo instances with real credentials**. They are excluded from
`npm test` and only run when you ask for them explicitly:

```bash
npm run test:live
```

## Why they are opt-in

`Test/unit` and `Test/services` are offline logic tests. `Test/integration` and `e2e/` also use
the real brokers, but only Jz Kotak, Jz Fyers and Jabez Crypto, copied into a throwaway database.
These live tests are the only ones that also use Maha and Ana, and they trade every order type the
app supports - against the broker it will be used with: its symbol formats, its rejection
messages, its analyzer mode.

## The safety rule

**Every order-placing test verifies, against the broker's own `/analyzer` endpoint, that the
instance is in analyzer mode — immediately before it places anything. If that check does not come
back affirmative, the test fails rather than placing the order.**

The local `is_analyzer_mode` column is *not* trusted for this. It is a cached copy of broker
state and can be wrong — the integration suite contains a test for exactly that drift. Asking the
broker is the only check that means anything, and it is made per test, not once at startup.

Instances are selected **by name** (see `ALLOWED_INSTANCES` in `live-orders.test.js`). An
instance that is not on that list is never touched, whatever mode it is in.

## Their own database

The live suites use `database/live.db` (`live-db.js`), never the `database/simplifyed.db` the
running app has open - two processes writing one SQLite file is what produced "database is
locked" mid-run. It is a snapshot taken on first use and kept, so past runs' orders (source
`live_test`) stay readable by the cleanup. Each run refreshes the instances (hosts and API keys
rotate on login) and the instruments cache (contracts expire) from the real database; nothing
flows back.

## Leaving nothing open

`cleanup.js` wraps the client so every order a suite sends is recorded. Each file's last test
calls `closeEverythingOpened`: it cancels whatever is still working on those symbols (this run's
plus every symbol recorded with source `live_test`), flattens their positions, re-reads the books
and fails if anything is still open. It touches only symbols a live test ordered - never an
instance's other positions - and only after the broker confirms analyzer mode.

## One file at a time

`npm run test:live` runs the files serially (`--test-concurrency=1`). They trade the same
symbols on the same instances with position-targeted orders, so two files running at once
change each other's positions - a NIFTY future ended up long 1,625 on Fyers when they ran in
parallel.
