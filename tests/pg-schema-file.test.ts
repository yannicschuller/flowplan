// The PostgreSQL schema is read from its file (lib/db-driver/pg-schema-file.ts)
// instead of being bundled into every server chunk: the same content, read
// once, and shipped next to the standalone server (next.config.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import schemaJson from "../lib/db-driver/postgres-schema.json";
import { PG_SCHEMA_FILE, pgSchemaJson } from "../lib/db-driver/pg-schema-file";

test("the schema file reads as the bundled JSON did, once", () => {
  const schema = pgSchemaJson();
  assert.deepEqual(schema, schemaJson);
  assert.equal(pgSchemaJson(), schema, "read once");
  assert.ok(schema.tables.some((t) => t.name === "search_index"));
});

test("the standalone build ships the file and keeps the big shared packages external", () => {
  const config = readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");
  assert.ok(config.includes(`"./${PG_SCHEMA_FILE}"`), "outputFileTracingIncludes names the schema file");
  // One copy per process: bundled, each route chunk held its own (and a
  // second yjs failed the constructor checks of the first, #194).
  for (const name of ["yjs", "pdf-lib", "happy-dom", "emojibase-data"]) assert.ok(config.includes(`"${name}"`), `${name} external`);
});
