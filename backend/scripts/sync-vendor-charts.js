/**
 * Copies openalgo-charts' browser build (ESM tiers) from node_modules into public/vendor,
 * same idiom as the pre-existing vendored lightweight-charts files - no bundler, served as
 * static files, imported by the browser as native ES modules. Runs on postinstall so
 * `npm install` / `npm update` re-syncs automatically whenever the dependency version moves.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'node_modules', 'openalgo-charts');
const dest = path.join(here, '..', 'public', 'vendor', 'openalgo-charts');

if (!fs.existsSync(src)) {
  console.warn('[sync-vendor-charts] openalgo-charts not installed, skipping');
  process.exit(0);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });

for (const file of fs.readdirSync(path.join(src, 'dist'))) {
  if (!file.endsWith('.mjs') && !file.endsWith('.mjs.map')) continue;
  fs.copyFileSync(path.join(src, 'dist', file), path.join(dest, file));
}
for (const file of ['LICENSE', 'NOTICE']) {
  const from = path.join(src, file);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dest, file));
}

const { version } = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(dest, 'VERSION'), `${version}\n`);
console.log(`[sync-vendor-charts] vendored openalgo-charts ${version} -> public/vendor/openalgo-charts`);

/**
 * OpenScript: the compiler/engine (`dist/core`) and the chart adapter (`dist/adapters/charts`).
 * Both are dependency-free native ESM trees with relative imports only, so they are served as-is.
 * The editor and CodeMirror adapters are left out: they import CodeMirror by bare specifier,
 * which a page with no bundler cannot resolve.
 */
const scriptSrc = path.join(here, '..', 'node_modules', 'openalgo-script');
const scriptDest = path.join(here, '..', 'public', 'vendor', 'openalgo-script');
if (fs.existsSync(scriptSrc)) {
  fs.rmSync(scriptDest, { recursive: true, force: true });
  for (const tree of ['core', 'adapters/charts']) {
    fs.cpSync(path.join(scriptSrc, 'dist', tree), path.join(scriptDest, tree), {
      recursive: true,
      filter: (from) => fs.statSync(from).isDirectory() || from.endsWith('.js'),
    });
  }
  for (const file of ['LICENSE', 'NOTICE']) {
    const from = path.join(scriptSrc, file);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(scriptDest, file));
  }
  const scriptVersion = JSON.parse(fs.readFileSync(path.join(scriptSrc, 'package.json'), 'utf8')).version;
  fs.writeFileSync(path.join(scriptDest, 'VERSION'), `${scriptVersion}\n`);
  console.log(`[sync-vendor-charts] vendored openalgo-script ${scriptVersion} -> public/vendor/openalgo-script`);
}
