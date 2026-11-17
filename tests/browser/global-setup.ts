import { request } from "@playwright/test";
import { testServers } from "./test-servers";

// Every spec signs in as the development demo account (POST /api/auth/demo).
// On a fresh data directory that account has not been through the
// introduction, so the first spec of a run (of a CI shard) gets "Willkommen
// bei Flowplan" over the page – once it has loaded, on top of whatever the
// spec opened. Marked as done here once, the specs no longer depend on which
// one runs first. Specs about the introduction open it themselves or use
// an account of their own. With TEST_SERVERS, on every worker's server.
export default async function globalSetup() {
  const servers = testServers();
  const origins = servers.length ? servers.map((server) => server.origin) : [process.env.TEST_BASE_URL || "http://127.0.0.1:3000"];
  await Promise.all(origins.map(onboard));
}

async function onboard(baseURL: string) {
  // German, as the specs' requests (playwright.config.ts): the first sign-in
  // creates the workspace and its sample pages in this language.
  const context = await request.newContext({
    baseURL,
    extraHTTPHeaders: { origin: new URL(baseURL).origin, "Accept-Language": "de-DE,de;q=0.9" },
  });
  try {
    if ((await context.post("/api/auth/demo")).ok()) await context.post("/api/command", { data: { action: "profile.onboarded" } });
  } catch {
    // No server yet or no demo sign-in: the specs report that themselves.
  } finally {
    await context.dispose();
  }
}
