// PostgreSQL extensions Flowplan uses when the server has them: pg_trgm
// for the full-text search (lib/search-store.ts) and pgvector for semantic
// search (lib/ai/vector-store.ts). Both are optional – without them the
// same features work, only slower.
//
// Where they live: an extension someone installed already is used where it
// is. Otherwise Flowplan installs it into a schema of its own,
// `flowplan_ext`, not into the instance's schema: a backup with pg_dump
// (lib/pg-backup.ts) covers the instance's schema, and a restore empties it
// – the extensions must survive that and are shared by every instance in
// the database. Without the right to create a schema, into the instance's
// schema (a restore leaves extension objects alone). pg_trgm is a "trusted"
// extension (any role with CREATE on the database may install it);
// pgvector is not, before version 0.8 at least: then an administrator
// installs it (`CREATE EXTENSION vector`), see the documentation.
import { db } from "./db-driver";

export const EXTENSION_SCHEMA = "flowplan_ext";

// The schema of an installed extension, installing it first when the server
// has it; null when it cannot be used. Inside a transaction: each attempt
// in a savepoint, so a refusal does not spoil it.
export async function extensionSchema(name: string, options: { install?: boolean } = {}): Promise<string | null> {
  const installed = async () =>
    (await db.one<{ schema: string }>("SELECT n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname=?", name))?.schema ?? null;
  const found = await installed();
  if (found || options.install === false) return found;
  if (!(await db.one("SELECT 1 FROM pg_available_extensions WHERE name=?", name))) return null;
  const attempt = async (sql: string) => {
    try {
      await db.tx(async () => {
        // Two instances (or test processes) at once: one after the other.
        await db.one("SELECT pg_advisory_xact_lock(hashtextextended('flowplan:extensions',0))");
        await db.exec(sql);
      });
      return true;
    } catch {
      return false;
    }
  };
  if (await attempt(`CREATE SCHEMA IF NOT EXISTS ${EXTENSION_SCHEMA}; CREATE EXTENSION IF NOT EXISTS ${name} SCHEMA ${EXTENSION_SCHEMA}`)) return await installed();
  if (await attempt(`CREATE EXTENSION IF NOT EXISTS ${name}`)) return await installed();
  return null;
}
