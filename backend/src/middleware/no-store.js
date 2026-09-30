/**
 * Forbid caching of API responses.
 *
 * Express stamps an ETag on every res.json() and sets no Cache-Control. With neither
 * Cache-Control nor Expires present, a browser is free to apply HEURISTIC freshness and serve a
 * GET from its own cache without asking the server at all.
 *
 * For this API that is a correctness bug, not a stale optimisation. The dashboard's write flow is
 * "save, then immediately re-list" - so after editing an instance the operator saw the success
 * toast over a table still showing the pre-edit values, which from the outside is
 * indistinguishable from the save having failed. The same applies to every other edit screen.
 *
 * no-store rather than no-cache: these responses carry account balances, positions and masked
 * credentials, and there is no reason for any of it to be written to a disk cache on a shared
 * machine. Revalidation would fix the staleness; not storing it fixes the staleness and does not
 * leave the data lying around.
 */
export function noStore(req, res, next) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
}
