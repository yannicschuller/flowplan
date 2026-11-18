// SQLite, two containers on one data folder (docker/entrypoint.sh): the one
// waiting for the lock writes .flowplan-waiting, and Administration →
// Überwachung shows it as a warning on both containers
// (lib/cluster/data-dir-lock.ts, lib/cluster/system.ts) until the file goes
// or is no longer rewritten. PostgreSQL has its own guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { onPostgres } from "./helpers/backend";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-data-dir-lock-"));
const { waitingContainer } = await import("../lib/cluster/data-dir-lock");
const { SINGLE_INSTANCE_STALE_MS } = await import("../lib/cluster/single-instance");
const { systemOverview } = await import("../lib/cluster/system");
const marker = join(process.env.FLOWPLAN_DATA_DIR, ".flowplan-waiting");

test("no marker: no warning", { skip: onPostgres && "PostgreSQL" }, async () => {
  rmSync(marker, { force: true });
  assert.equal(waitingContainer(), null);
  assert.equal((await systemOverview()).waitingContainer, null);
});

test("another container waits: the warning names it, with since and Litestream", { skip: onPostgres && "PostgreSQL" }, async () => {
  writeFileSync(marker, "since=1763470000\nhost=flowplan-new-abc\nlitestream=1\n");
  const w = waitingContainer();
  assert.ok(w);
  assert.equal(w.host, "flowplan-new-abc");
  assert.equal(w.since, 1763470000 * 1000);
  assert.equal(w.litestream, true);
  assert.equal(w.self, false);
  assert.deepEqual((await systemOverview()).waitingContainer?.host, "flowplan-new-abc");
});

test("this container waits (its hostname), without Litestream", { skip: onPostgres && "PostgreSQL" }, () => {
  writeFileSync(marker, `since=1763470000\nhost=${hostname()}\nlitestream=0\n`);
  const w = waitingContainer();
  assert.equal(w?.self, true);
  assert.equal(w?.litestream, false);
});

test("a marker not rewritten for a while belongs to a container that is gone", { skip: onPostgres && "PostgreSQL" }, () => {
  writeFileSync(marker, "since=1763470000\nhost=gone\nlitestream=1\n");
  const old = (Date.now() - SINGLE_INSTANCE_STALE_MS - 60_000) / 1000;
  utimesSync(marker, old, old);
  assert.equal(waitingContainer(), null);
  assert.ok(waitingContainer(old * 1000 + 1000), "fresh at the time it was written");
});

test("a damaged marker still warns (the file is there and fresh), without crashing", { skip: onPostgres && "PostgreSQL" }, () => {
  writeFileSync(marker, "garbage");
  const w = waitingContainer();
  assert.ok(w);
  assert.equal(w.host, "");
  assert.ok(w.since > 0);
});

test("PostgreSQL: the data folder marker is not used", { skip: !onPostgres && "needs PostgreSQL" }, () => {
  writeFileSync(marker, "since=1763470000\nhost=x\nlitestream=1\n");
  assert.equal(waitingContainer(), null);
});

test("Überwachung shows it with the existing conflict warning and links the docs", () => {
  const ui = readFileSync("components/settings/admin/monitoring.tsx", "utf8");
  const warning = ui.slice(ui.indexOf("function SecondInstanceWarning"), ui.indexOf("function System("));
  assert.match(warning, /s\.waitingContainer/);
  assert.match(warning, /className="mon-note warn" role="alert"/);
  assert.match(warning, /docs\("coolify-and-proxy", "sqlite-ohne-ueberlappung-ausrollen", "roll-out-sqlite-without-overlap"\)/);
  // Same marker name in the entrypoint and the app.
  assert.match(readFileSync("docker/entrypoint.sh", "utf8"), /WAITING="\$DATA\/\.flowplan-waiting"/);
});
