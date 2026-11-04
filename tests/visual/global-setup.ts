import { request } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { seedAccount, startProductionServer } from "../../scripts/production-server.mjs";
import { FIXED_TIME, STATE_FILE, STORAGE_FILE } from "./shared";

// One production server with an empty data directory for the whole run, an
// account and fixed example content (scripts/production-server.mjs).
export default async function globalSetup() {
  const server = await startProductionServer();
  const api = await request.newContext({ baseURL: server.origin, extraHTTPHeaders: { "Accept-Language": "de-DE,de;q=0.9" } });
  const ids = await seedAccount(api, server.origin);
  fixEditTimes(server.data);
  mkdirSync(dirname(STORAGE_FILE), { recursive: true });
  await api.storageState({ path: STORAGE_FILE });
  await api.dispose();
  writeFileSync(STATE_FILE, JSON.stringify({ origin: server.origin, ...ids }));
  return async () => {
    await server.stop();
  };
}

// The seed's edits land in whichever second the run reaches them, so the
// start page's "Zuletzt bearbeitet" came in a different order from run to
// run. The pages get fixed edit times just before FIXED_TIME instead (all
// "gerade eben"), newest first in this order.
const EDIT_ORDER = ["Projektbriefing", "Projekte", "Willkommen bei Flowplan", "Team-Handbuch"];
function fixEditTimes(dataDir: string) {
  const db = new DatabaseSync(join(dataDir, "flowplan.sqlite"));
  try {
    const set = db.prepare("UPDATE pages SET updated_at=? WHERE title=? AND deleted_at IS NULL");
    EDIT_ORDER.forEach((title, i) => {
      const at = new Date(FIXED_TIME.getTime() - (i + 1) * 5000).toISOString().slice(0, 19).replace("T", " ");
      set.run(at, title);
    });
  } finally {
    db.close();
  }
}
