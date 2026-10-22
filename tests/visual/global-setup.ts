import { request } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { seedAccount, startProductionServer } from "../../scripts/production-server.mjs";
import { STATE_FILE, STORAGE_FILE } from "./shared";

// One production server with an empty data directory for the whole run, an
// account and fixed example content (scripts/production-server.mjs).
export default async function globalSetup() {
  const server = await startProductionServer();
  const api = await request.newContext({ baseURL: server.origin, extraHTTPHeaders: { "Accept-Language": "de-DE,de;q=0.9" } });
  const ids = await seedAccount(api, server.origin);
  mkdirSync(dirname(STORAGE_FILE), { recursive: true });
  await api.storageState({ path: STORAGE_FILE });
  await api.dispose();
  writeFileSync(STATE_FILE, JSON.stringify({ origin: server.origin, ...ids }));
  return async () => {
    await server.stop();
  };
}
