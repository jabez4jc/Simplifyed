# Live broker tests

These talk to **real OpenAlgo instances with real credentials**. They are excluded from
`npm test` and only run when you ask for them explicitly:

```bash
npm run test:live
```

## Why they are opt-in

Everything else in `Test/` runs against a fake broker and a throwaway database. These do not.
They exist to answer the one question a fake cannot: does this application actually work against
the broker it will be used with — its symbol formats, its rejection messages, its analyzer mode.

## The safety rule

**Every order-placing test verifies, against the broker's own `/analyzer` endpoint, that the
instance is in analyzer mode — immediately before it places anything. If that check does not come
back affirmative, the test fails rather than placing the order.**

The local `is_analyzer_mode` column is *not* trusted for this. It is a cached copy of broker
state and can be wrong — the integration suite contains a test for exactly that drift. Asking the
broker is the only check that means anything, and it is made per test, not once at startup.

Instances are selected **by name** (see `ALLOWED_INSTANCES` in `live-orders.test.js`). An
instance that is not on that list is never touched, whatever mode it is in.

## One file at a time

`npm run test:live` runs the files serially (`--test-concurrency=1`). They trade the same
symbols on the same instances with position-targeted orders, so two files running at once
change each other's positions - a NIFTY future ended up long 1,625 on Fyers when they ran in
parallel. Every file closes what it opened and its last test checks the books are flat.
