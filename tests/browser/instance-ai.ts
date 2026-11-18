import { test, type APIRequestContext } from "@playwright/test";

// The instance's AI settings (Administration → KI, lib/ai/settings.ts) are
// one row for the whole server, and the files of a worker share their
// server. A spec that switches AI on (or off) would leave it so for every
// later file on the worker – notebook.spec.ts once failed because "In Text
// umwandeln" opened the instance's AI after an AI spec (#336). Every spec
// that changes them calls keepInstanceAi() once at the top of the file: each
// test then ends with the settings it found, passed or failed, whatever the
// order of the files.
export function keepInstanceAi() {
  let saved: Record<string, unknown> | null = null;
  test.beforeEach(async ({ playwright, baseURL }) => {
    saved = await withAdmin(playwright.request, baseURL!, async (request) => {
      const response = await request.get("/api/ai/admin");
      if (!response.ok()) throw new Error(`KI-Einstellungen nicht lesbar: ${await response.text()}`);
      return (await response.json()).settings as Record<string, unknown>;
    });
  });
  test.afterEach(async ({ playwright, baseURL }) => {
    if (!saved) return;
    const settings = saved;
    saved = null;
    await withAdmin(playwright.request, baseURL!, async (request) => {
      const response = await request.post("/api/command", { data: { action: "admin.ai", settings } });
      if (!response.ok()) throw new Error(`KI-Einstellungen nicht wiederhergestellt: ${await response.text()}`);
    });
  });
}

// The demo account administers the instance (POST /api/auth/demo); a
// context of its own leaves the test's page and its cookies alone.
async function withAdmin<T>(factory: { newContext: (options: object) => Promise<APIRequestContext> }, baseURL: string, run: (request: APIRequestContext) => Promise<T>) {
  const request = await factory.newContext({ baseURL, extraHTTPHeaders: { origin: new URL(baseURL).origin, "Accept-Language": "de-DE,de;q=0.9" } });
  try {
    const signIn = await request.post("/api/auth/demo");
    if (!signIn.ok()) throw new Error(`Demo-Anmeldung fehlgeschlagen: ${await signIn.text()}`);
    return await run(request);
  } finally {
    await request.dispose();
  }
}
