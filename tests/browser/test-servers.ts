// The specs against the production build (scripts/build-e2e.mjs): with
// TEST_SERVERS=n, Playwright starts n servers of that build
// (scripts/e2e-server.mjs) and runs n workers, worker i against server i.
// Each server has a port and a data directory of its own – its own demo
// account, workspace and instance settings – so the specs, written for one
// worker on one server, stay as isolated from each other as on a CI shard of
// their own.
//
// Server i listens on the port of TEST_BASE_URL plus i, with the data
// directory FLOWPLAN_DATA_DIR followed by "w<i>" (letters and digits only:
// e2ee.spec.ts and inline-comments.spec.ts check the directory's name).
// playwright.config.ts sets TEST_BASE_URL and FLOWPLAN_DATA_DIR of each
// worker process to its server's before any spec is loaded (Playwright sets
// TEST_PARALLEL_INDEX in a worker before it reads the config); the specs
// read them as before.
//
// Without TEST_SERVERS the specs run in one worker against the server at
// TEST_BASE_URL, e.g. `npm run dev`.
export type TestServer = { index: number; origin: string; dataDir: string };

export function testServers(): TestServer[] {
  const count = Number(process.env.TEST_SERVERS || 0);
  if (!count) return [];
  if (!Number.isInteger(count) || count < 1) throw new Error(`TEST_SERVERS=${process.env.TEST_SERVERS}: a number of servers, 1 or more.`);
  // The values as given, kept before playwright.config.ts points a worker's
  // TEST_BASE_URL and FLOWPLAN_DATA_DIR at its own server.
  process.env.TEST_SERVERS_BASE_URL ??= process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  if (process.env.FLOWPLAN_DATA_DIR) process.env.TEST_SERVERS_DATA_DIR ??= process.env.FLOWPLAN_DATA_DIR;
  const first = new URL(process.env.TEST_SERVERS_BASE_URL);
  const dataDir = process.env.TEST_SERVERS_DATA_DIR;
  if (!dataDir) throw new Error("TEST_SERVERS needs FLOWPLAN_DATA_DIR, the base name of the servers' data directories.");
  return Array.from({ length: count }, (_, index) => ({
    index,
    origin: `${first.protocol}//${first.hostname}:${Number(first.port || 80) + index}`,
    dataDir: `${dataDir}w${index}`,
  }));
}
