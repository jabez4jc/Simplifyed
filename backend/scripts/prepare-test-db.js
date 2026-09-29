/**
 * Builds the template database every test file copies (see Test/helpers/db.js).
 *
 * Migrating once here instead of once per test file is the difference between a ~2s suite and a
 * ~40s one. Rebuilt from scratch each run so a schema change can never be masked by a stale file.
 */

import { rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const BACKEND_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REL = './database/test-template.db';
const ABS = join(BACKEND_ROOT, REL);

for (const suffix of ['', '-wal', '-shm']) {
  rmSync(ABS + suffix, { force: true });
}

const result = spawnSync(process.execPath, ['migrations/migrate.js'], {
  cwd: BACKEND_ROOT,
  env: { ...process.env, DATABASE_PATH: REL },
  stdio: 'inherit',
});

if (result.status !== 0) {
  console.error('Failed to build the test template database');
  process.exit(result.status ?? 1);
}

/**
 * The pre-existing unit tests call db.connect() directly and rely on the DATABASE_PATH the npm
 * script sets (./database/test.db). Seed that from the template too, so they get a clean schema
 * without paying for a second migration run - and so a stale test.db can never outlive a schema
 * change.
 */
import { copyFileSync } from 'fs';
for (const suffix of ['', '-wal', '-shm']) {
  rmSync(join(BACKEND_ROOT, './database/test.db') + suffix, { force: true });
}
copyFileSync(ABS, join(BACKEND_ROOT, './database/test.db'));
