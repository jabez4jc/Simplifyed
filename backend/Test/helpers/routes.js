/**
 * The app's real endpoint inventory, read off the mounted Express routers.
 *
 * Deliberately NOT a hand-written list. A checked-in list of 155 endpoints is a list that goes
 * stale the first time someone adds a route and forgets to update it - which is exactly the
 * moment the coverage check needed to fire. Walking router.stack means a new endpoint shows up
 * here the instant it is mounted, and the meta-test in Test/integration/contract.test.js fails
 * until it is covered.
 */

import apiV1Routes from '../../src/routes/v1/index.js';

/** Express keeps a regexp per mounted sub-router; recover the literal prefix from it. */
function prefixOf(layer) {
  if (layer.regexp?.fast_slash) return '';
  const source = layer.regexp?.source ?? '';
  const match = source.match(/^\^\\\/(?<seg>[^\\?]*)/);
  if (!match) return '';
  return '/' + match.groups.seg.replace(/\\\//g, '/');
}

function walk(stack, prefix, out) {
  for (const layer of stack) {
    if (layer.route) {
      const path = prefix + layer.route.path;
      for (const method of Object.keys(layer.route.methods)) {
        if (method === '_all') continue;
        out.push({ method: method.toUpperCase(), path: path === '' ? '/' : path });
      }
      continue;
    }
    if (layer.name === 'router' && layer.handle?.stack) {
      walk(layer.handle.stack, prefix + prefixOf(layer), out);
    }
  }
}

/** Every v1 endpoint as { method, path }, path relative to /api/v1. */
export function listV1Endpoints() {
  const out = [];
  walk(apiV1Routes.stack, '', out);
  return out.sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method));
}

/** Turn an Express path into a concrete URL by substituting :params. */
export function concrete(path, params = {}) {
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)\??/g, (_, name) =>
    String(params[name] ?? params.default ?? '1')
  );
}
