import { test, expect, type Page } from "@playwright/test";

// The draw.io Flowplan ships (#454): the real draw.io from /drawio/<version>/
// edits a diagram without asking any other host and without breaking its
// own Content Security Policy; with offline use on, a page with a diagram
// keeps draw.io on the device, and the editor opens, edits and saves
// without a connection. Skipped when the build has no shipped copy
// (node scripts/drawio-fetch.mjs before npm run build:e2e).
test.use({ actionTimeout: 20_000 });
const origin = () => process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

async function fixture(page: Page, title: string) {
  await page.request.post("/api/auth/demo", { headers: { origin: origin() } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await page.request.post("/api/command", {
    headers: { origin: origin() },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, kind: "document", title },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const host = await created.json();
  return { boot, host, drawio: boot.instance?.drawio, read: async () => (await page.request.get(`/api/pages/${host.id}`)).json() };
}

// One shape more from draw.io's shape panel, then "Speichern & Beenden".
async function addShapeAndSave(page: Page) {
  const dialog = page.getByRole("dialog", { name: "draw.io-Diagramm", exact: true });
  const frame = dialog.frameLocator("iframe");
  await expect(frame.locator(".geDiagramContainer")).toBeVisible({ timeout: 60_000 });
  await frame.locator(".geSidebar a.geItem").first().click();
  await frame.getByRole("button", { name: /Speichern & Beenden/ }).first().click();
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
}
// Shapes of the stored diagram (its XML, escaped in the page's HTML).
const shapes = (html: string) => (html.match(/vertex=(?:"|&quot;)1/g) || []).length;

test("the shipped draw.io edits a diagram on Flowplan's origin, also offline", async ({ page, context }, info) => {
  test.setTimeout(240_000);
  const f = await fixture(page, `draw.io offline ${info.project.name} ${Date.now()}`);
  test.skip(!f.drawio?.bundled, "This build has no shipped draw.io (scripts/drawio-fetch.mjs).");
  const base = new URL(origin());
  const foreign: string[] = [];
  context.on("request", (request) => {
    const url = new URL(request.url());
    if (!["data:", "blob:"].includes(url.protocol) && url.host !== base.host) foreign.push(request.url());
  });
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("console", (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text())) problems.push(message.text());
  });

  await page.goto(`/#page=${f.host.id}`);
  await page.getByRole("button", { name: "Block hinzufügen", exact: true }).click();
  await page.locator(".slash-menu").getByRole("option", { name: /^draw\.io-Diagramm/ }).first().click();
  const dialog = page.getByRole("dialog", { name: "draw.io-Diagramm", exact: true });
  await expect(dialog).toBeVisible();
  // Nothing goes to diagrams.net: no notice about it.
  await expect(dialog.locator(".drawio-privacy")).toHaveCount(0);
  const src = new URL((await dialog.locator("iframe").getAttribute("src"))!);
  expect(src.origin + src.pathname).toBe(`${base.origin}/drawio/${f.drawio.bundled}/`);
  for (const [key, value] of Object.entries({ embed: "1", proto: "json", stealth: "1", lockdown: "1", pwa: "0", lang: "de" }))
    expect(src.searchParams.get(key), key).toBe(value);
  if (info.project.name !== "desktop") {
    // Phones: draw.io loads (its shape panel starts closed there) and closes.
    await expect(dialog.frameLocator("iframe").locator(".geDiagramContainer")).toBeVisible({ timeout: 60_000 });
    await dialog.frameLocator("iframe").getByRole("button", { name: "Beenden", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(foreign).toEqual([]);
    expect(problems).toEqual([]);
    return;
  }
  await addShapeAndSave(page);

  const block = page.getByLabel("Dokumentinhalt", { exact: true }).locator(".drawio-block");
  await expect(block).toHaveAttribute("data-drawio-state", "ready");
  await expect.poll(async () => shapes((await f.read()).html), { timeout: 20_000 }).toBe(1);
  const picture = decodeURIComponent((await block.locator("img").getAttribute("src"))!);
  expect(picture).toMatch(/^data:image\/svg\+xml/);
  expect(picture).toContain("<rect");
  expect(foreign).toEqual([]);
  expect(problems).toEqual([]);
  // draw.io's own service worker stays away (pwa=0).
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map((r) => new URL(r.scope).pathname))).not.toContain(
    `/drawio/${f.drawio.bundled}/`,
  );

  // Offline use on for this device, as Settings → Geräte does it, without
  // storing the whole (shared) test account.
  await page.evaluate(
    async ({ user, workspace }) => {
      await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      await (await caches.open("flowplan-settings")).put(
        "/__flowplan-offline",
        new Response(JSON.stringify({ user, workspace, since: Date.now() }), { headers: { "Content-Type": "application/json" } }),
      );
      // The worker reads the switch anew (components/offline.ts notifyWorker).
      (await navigator.serviceWorker.getRegistration())?.active?.postMessage({ type: "flowplan-offline" });
    },
    { user: f.boot.user.id, workspace: f.boot.workspace.id },
  );
  // The page with the diagram, now under the service worker: it keeps
  // draw.io's start files without the editor being opened.
  await page.reload();
  await expect(block).toHaveAttribute("data-drawio-state", "ready");
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  const cache = `flowplan-drawio-${f.drawio.bundled}`;
  const kept = () =>
    page.evaluate(async (name) => ((await caches.has(name)) ? (await (await caches.open(name)).keys()).map((r) => new URL(r.url).pathname) : []), cache);
  await expect.poll(kept, { timeout: 60_000 }).toEqual(
    expect.arrayContaining([`/drawio/${f.drawio.bundled}/`, `/drawio/${f.drawio.bundled}/js/app.min.js`, `/drawio/${f.drawio.bundled}/resources/dia_de.txt`]),
  );
  // The warm-up holds about what draw.io needs to start, not the whole copy.
  expect((await kept()).length).toBeLessThan(30);
  // The app's own files, as the offline copy stores them (components/offline.ts storeApp).
  await page.evaluate(async () => {
    const assets = (await (await fetch("/api/offline/assets")).json()) as { files: { path: string }[] };
    for (const file of assets.files) await fetch(file.path).catch(() => undefined);
  });

  // Without a connection (aborting cuts the service worker's own requests
  // as well, and routing switches the HTTP cache off).
  await context.setOffline(true);
  await context.route("**/*", (route) => route.abort("internetdisconnected"));
  await block.dblclick();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await addShapeAndSave(page);
  await expect(block).toHaveAttribute("data-drawio-state", "ready");
  // Back online: the change reaches the server through the document's sync.
  await context.unroute("**/*");
  await context.setOffline(false);
  await expect.poll(async () => shapes((await f.read()).html), { timeout: 60_000 }).toBe(2);
  expect(foreign).toEqual([]);
  expect(problems.filter((p) => !/internetdisconnected|Failed to load resource|ERR_INTERNET_DISCONNECTED/i.test(p))).toEqual([]);
});
