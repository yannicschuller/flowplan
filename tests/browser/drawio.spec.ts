import { test, expect, type Page } from "@playwright/test";

// draw.io diagrams (#110): inserted from the slash menu, edited in draw.io's
// embed mode, stored as diagram and cleaned picture, edited again, undone
// and deleted. draw.io itself is not asked: a stand-in page at the default
// address speaks its postMessage protocol (init → load → save → export).
const FIRST = '<mxfile><diagram id="a" name="Seite-1">erste</diagram></mxfile>';
const SECOND = '<mxfile><diagram id="a" name="Seite-1">zweite</diagram></mxfile>';
const picture = (label: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80" viewBox="0 0 200 80" onload="window.parent.pwned=1"><script>window.parent.pwned=2</script><rect width="200" height="80" fill="#dde"/><text x="20" y="45">${label}</text><image href="https://tracker.example/x.png"/></svg>`;

// The stand-in for draw.io: answers load and export like draw.io does.
const js = (value: string) => JSON.stringify(value).replaceAll("<", "\\u003c");
const STAND_IN = `<!doctype html><meta charset="utf-8"><body>
<p id="loaded"></p><button id="save">Speichern und beenden</button><button id="exit">Beenden</button>
<script>
const FIRST = ${js(FIRST)}, SECOND = ${js(SECOND)};
const PICTURES = { [FIRST]: ${js(picture("Erste Fassung"))}, [SECOND]: ${js(picture("Zweite Fassung"))} };
let current = "";
const send = (message) => parent.postMessage(JSON.stringify(message), "*");
addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.action === "load") {
    current = message.xml ? SECOND : FIRST;
    document.getElementById("loaded").textContent = message.xml ? "geladen: " + message.xml : "neu";
    send({ event: "load" });
  }
  if (message.action === "export" && message.format === "xmlsvg") {
    const svg = PICTURES[current];
    send({ event: "export", format: "xmlsvg", xml: current, data: "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svg))) });
  }
});
document.getElementById("save").onclick = () => send({ event: "save", xml: current, exit: true });
document.getElementById("exit").onclick = () => send({ event: "exit", modified: false });
send({ event: "init" });
</script>`;

async function fixture(page: Page, title: string) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, kind: "document", title },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const host = await created.json();
  return { host, drawio: boot.instance?.drawio, read: async () => (await page.request.get(`/api/pages/${host.id}`)).json() };
}

test("draw.io diagrams: insert, show the cleaned picture, edit, undo and delete", async ({ page }, info) => {
  test.setTimeout(120_000);
  const f = await fixture(page, `draw.io ${info.project.name} ${Date.now()}`);
  test.skip(!f.drawio, "DRAWIO_URL is not usable on this server.");
  const opened: string[] = [];
  await page.route(`${f.drawio.origin}/**`, (route) => {
    opened.push(route.request().url());
    return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: STAND_IN });
  });
  // Nothing of a diagram may load from elsewhere.
  const tracked: string[] = [];
  await page.route("https://tracker.example/**", (route) => {
    tracked.push(route.request().url());
    return route.abort();
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // The development server's badge covers the phone toolbar's undo button.
  await page.addInitScript(() =>
    addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = "nextjs-portal { display: none !important; }";
      document.head.append(style);
    }),
  );
  await page.goto(`/#page=${f.host.id}`);

  await page.getByRole("button", { name: "Block hinzufügen", exact: true }).click();
  await page.locator(".slash-menu").getByRole("option", { name: /^draw\.io-Diagramm/ }).first().click();
  const dialog = page.getByRole("dialog", { name: "draw.io-Diagramm", exact: true });
  await expect(dialog).toBeVisible();
  if (f.drawio.external) await expect(dialog.locator(".drawio-privacy")).toContainText("diagrams.net");
  const frame = dialog.frameLocator("iframe");
  await expect(frame.locator("#loaded")).toHaveText("neu");
  const address = new URL(opened[0]);
  for (const [key, value] of Object.entries({ embed: "1", proto: "json", ui: "kennedy", lang: "de" })) expect(address.searchParams.get(key)).toBe(value);
  await frame.getByRole("button", { name: "Speichern und beenden" }).click();
  await expect(dialog).toHaveCount(0);

  const block = page.getByLabel("Dokumentinhalt", { exact: true }).locator(".drawio-block");
  await expect(block).toHaveAttribute("data-drawio-state", "ready");
  const source = async () => decodeURIComponent((await block.locator("img").getAttribute("src"))!.replace(/^data:image\/svg\+xml;charset=utf-8,/, ""));
  expect(await source()).toContain("Erste Fassung");
  expect(await source()).not.toMatch(/onload|<script|tracker\.example/);
  await expect.poll(async () => (await f.read()).html, { timeout: 20_000 }).toContain("erste");
  const stored = (await f.read()).html as string;
  expect(stored).toContain("data-drawio-svg=");
  expect(stored).not.toMatch(/pwned|tracker\.example/);

  // Edit again (double-click): draw.io gets the stored diagram.
  await block.dblclick();
  await expect(frame.locator("#loaded")).toHaveText(`geladen: ${FIRST}`);
  await frame.getByRole("button", { name: "Speichern und beenden" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(source).toContain("Zweite Fassung");
  // One step back, then forward.
  await page.getByTitle("Rückgängig", { exact: true }).click();
  await expect.poll(source).toContain("Erste Fassung");
  await page.getByTitle("Wiederholen", { exact: true }).click();
  await expect.poll(source).toContain("Zweite Fassung");
  // Leaving draw.io without saving changes nothing.
  await block.focus();
  await block.press("Enter");
  await frame.getByRole("button", { name: "Beenden", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(source).toContain("Zweite Fassung");

  // After a reload the picture comes from the page, without draw.io.
  const before = opened.length;
  await page.reload();
  await expect(block).toHaveAttribute("data-drawio-state", "ready");
  expect(await source()).toContain("Zweite Fassung");
  expect(opened.length).toBe(before);

  await block.hover();
  await block.getByRole("button", { name: "Diagramm löschen" }).click();
  await expect(block).toHaveCount(0);
  await expect.poll(async () => (await f.read()).html, { timeout: 20_000 }).not.toContain("data-drawio");
  expect(tracked).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
  expect(errors).toEqual([]);
});
