/**
 * Which numbered migrations in backend/migrations/ the connected database has not applied yet.
 * The server refuses to start on any: running new code against an old schema fails later and
 * somewhere else, mid-request. The fix is always `npm run migrate`.
 */
import { readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');
const padVersion = (v) => String(v).trim().padStart(3, '0'); // legacy rows stored plain integers

export async function pendingMigrations(db) {
  const onDisk = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_.*\.js$/.test(f)).map((f) => f.slice(0, 3));
  const applied = new Set(
    (await db.all('SELECT version FROM schema_migrations').catch(() => [])).map((r) => padVersion(r.version))
  );
  return onDisk.filter((v) => !applied.has(v)).sort();
}
