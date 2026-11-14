import { test, expect, type Page } from "@playwright/test";

// While the server restarts (#284) the reverse proxy answers every request
// with its own page – Traefik's "404 page not found" (text/plain). The app
// stays on the page, keeps what was typed and sends it once the server is
// back, instead of leaving for that error page.
const origin = () => process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
async function fixture(page: Page, title: string, html: string) {
  await page.request.post("/api/auth/demo", { headers: { origin: origin() } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin: origin() }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const host = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, kind: "document", title });
  const read = async () => (await page.request.get(`/api/pages/${host.id}`)).json();
  const { htmlState } = await import("../../lib/document-server");
  await command({ action: "document.sync", pageId: host.id, generation: (await read()).generation, update: Buffer.from(htmlState(html)).toString("base64") });
  return { host, read };
}

test("a proxy's 404 during a server restart keeps the page and the typed text", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Once is enough.");
  test.setTimeout(120_000);
  const f = await fixture(page, `Neustart ${Date.now()}`, "<p>Vor dem Neustart</p>");
  await page.goto(`/#page=${f.host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.getByText("Vor dem Neustart")).toBeVisible({ timeout: 20_000 });
  const url = page.url();

  // The server goes away: the proxy says "404 page not found" to everything.
  const proxy = async (route: import("@playwright/test").Route) =>
    route.fulfill({ status: 404, contentType: "text/plain; charset=utf-8", body: "404 page not found\n" });
  await page.route("**/api/**", proxy);
  await editor.getByText("Vor dem Neustart").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" – während des Neustarts getippt");
  // The workspace's next reload (every 10 s; here at once) meets the proxy.
  await page.evaluate(() => window.dispatchEvent(new Event("flowplan:pages-changed")));
  await page.waitForTimeout(3000);
  expect(page.url()).toBe(url);
  await expect(page.getByText("404 page not found")).toHaveCount(0);
  await expect(editor).toContainText("während des Neustarts getippt");

  // The server is back: the text reaches it.
  await page.unroute("**/api/**", proxy);
  await expect.poll(async () => JSON.stringify(await f.read()), { timeout: 30_000 }).toContain("während des Neustarts getippt");
});
