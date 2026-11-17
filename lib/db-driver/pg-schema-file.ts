// The PostgreSQL schema of this version (postgres-schema.json, 440 KB),
// read from its file when first needed. Imported as a module it became part
// of every server chunk that reached the database layer – some seventy
// copies in the build. The file ships next to the server
// (next.config.ts outputFileTracingIncludes); the server runs from the
// app's folder, as tests and scripts do from the checkout.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PgSchema } from "./pg-schema";

export const PG_SCHEMA_FILE = "lib/db-driver/postgres-schema.json";
let cached: PgSchema | null = null;
export function pgSchemaJson(): PgSchema {
  cached ??= JSON.parse(readFileSync(join(/*turbopackIgnore: true*/ process.cwd(), PG_SCHEMA_FILE), "utf8")) as PgSchema;
  return cached;
}
