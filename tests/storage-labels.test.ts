import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The storage overview's parts are named in German on the server
// (lib/storage-overview.ts); the admin page translates every one of them
// (components/admin-storage.tsx, #121). A new part needs its translation.
test("every storage part label is translated on the admin page", () => {
  const server = readFileSync("lib/storage-overview.ts", "utf8");
  const page = readFileSync("components/admin-storage.tsx", "utf8");
  const labels = [...server.matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
  assert.ok(labels.length >= 15);
  for (const label of labels) assert.ok(page.includes(`case "${label}":`), `no translation for "${label}"`);
});
