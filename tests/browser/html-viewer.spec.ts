import { test, expect } from "@playwright/test";

// The HTML viewer (#398): an uploaded HTML file becomes a card in the
// document; its preview shows the page in an empty sandbox – the content is
// there, its script never runs, nothing is loaded from elsewhere – with the
// note and the download. "Skripte ausführen" runs the file's scripts in a
// sandbox of their own: no access to the app, its cookies or the network.

// A page whose script would change its own and the app's title and the
// text, and whose inline handler would too.
const FILE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Original-Titel</title>
<style>h1 { color: rgb(200, 30, 30); }</style>
<link rel="stylesheet" href="https://example.com/fremd.css">
<script>document.title = "Skript lief"; try { parent.document.title = "Skript lief"; } catch (e) {}
document.addEventListener("securitypolicyviolation", (e) => { if (e.violatedDirective.startsWith("connect-src")) document.getElementById("netz-csp").textContent = e.violatedDirective; });
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("flag").textContent = "verändert";
  const probe = (id, f) => { const el = document.getElementById(id); try { el.textContent = "offen: " + f(); } catch (e) { el.textContent = "gesperrt: " + e.name; } };
  probe("eltern", () => parent.document.title);
  probe("keks", () => document.cookie);
  fetch("/api/bootstrap", { credentials: "include" }).then(() => { document.getElementById("netz").textContent = "offen"; }, (e) => { document.getElementById("netz").textContent = "gesperrt: " + e.name; });
});</script>
</head><body>
<h1>Grüße aus der Datei</h1>
<p id="flag">unverändert</p>
<p id="eltern">-</p><p id="keks">-</p><p id="netz">-</p><p id="netz-csp">-</p><p id="bild">-</p>
<img src="https://example.com/fremd.png" alt="extern" onerror="document.getElementById('bild').textContent = 'onerror'">
<form action="https://example.com/"><button>Senden</button></form>
</body></html>`;

test("an HTML file opens in a sandboxed preview: content shown, script not run", async ({ page }, info) => {
  test.setTimeout(90_000);
  const mobile = info.project.name === "mobile";
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // Requests to elsewhere: answered ones, and why the others failed.
  const external: string[] = [];
  const blocked: string[] = [];
  page.on("response", (r) => {
    if (r.url().startsWith("https://example.com/")) external.push(r.url());
  });
  page.on("requestfailed", (r) => {
    if (r.url().startsWith("https://example.com/")) blocked.push(r.failure()?.errorText || "");
  });
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    if (!response.ok()) throw new Error(await response.text());
    return response.json();
  };
  const p = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `HTML ${info.project.name} ${Date.now()}`, kind: "document" });
  const buffer = Buffer.from(FILE);

  if (!mobile) {
    // Uploaded in the editor (/datei): the file becomes a card.
    await page.goto(`/#page=${p.id}`);
    const text = page.locator(".ProseMirror").first();
    await text.click();
    await page.keyboard.type("Bericht:");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/datei");
    const item = page.getByRole("listbox").getByRole("option", { name: /Bild oder Datei/ });
    await expect(item).toBeVisible();
    const chooser = page.waitForEvent("filechooser");
    await item.click();
    await (await chooser).setFiles({ name: "bericht.html", mimeType: "text/html", buffer });
  } else {
    // On the phone the same card, from the API.
    const response = await page.request.post("/api/upload", { headers: { origin }, multipart: { pageId: p.id, file: { name: "bericht.html", mimeType: "text/html", buffer } } });
    expect(response.ok()).toBe(true);
    const uploaded = (await response.json()) as { url: string; mime: string };
    // Stored as a plain download, never as a page.
    expect(uploaded.mime).toBe("application/octet-stream");
    const data = await (await page.request.get(`/api/pages/${p.id}`)).json();
    const { htmlState } = await import("../../lib/document-server");
    await command({
      action: "document.sync",
      workspaceId: boot.workspace.id,
      pageId: p.id,
      generation: data.generation,
      update: Buffer.from(htmlState(`<p>Bericht:</p><div data-html-file="true" data-title="bericht.html" class="html-block"><a href="${uploaded.url}">bericht.html</a></div>`)).toString("base64"),
    });
    await page.goto(`/#page=${p.id}`);
  }
  const appTitle = await page.title();
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  const card = editor.getByRole("button", { name: "Vorschau von „bericht.html“ öffnen" });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText("HTML · Vorschau öffnen");

  const loaded = page.waitForResponse((r) => /\/api\/files\/[\w-]+\/html$/.test(r.url()) && r.request().method() === "GET");
  await card.click();
  const viewer = page.getByRole("dialog", { name: "bericht.html" });
  await expect(viewer).toBeVisible();
  await expect(viewer).toContainText("Skripte und externe Inhalte sind abgeschaltet.");
  await expect(viewer.getByRole("link", { name: "Herunterladen" })).toHaveAttribute("download", "bericht.html");
  const frame = viewer.locator("iframe.html-viewer-frame");
  // The empty sandbox: everything off.
  await expect(frame).toHaveAttribute("sandbox", "");
  const response = await loaded;
  expect(response.status()).toBe(200);
  const headers = response.headers();
  expect(headers["content-type"]).toBe("text/html; charset=utf-8");
  expect(headers["content-security-policy"]).toContain("default-src 'none'");
  expect(headers["content-security-policy"]).toMatch(/(^|; )sandbox(;|$)/);
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["set-cookie"]).toBeUndefined();

  // The content is shown, with its own styles …
  const inside = page.frameLocator("iframe.html-viewer-frame");
  await expect(inside.getByRole("heading", { name: "Grüße aus der Datei" })).toBeVisible({ timeout: 10_000 });
  await expect(inside.locator("h1")).toHaveCSS("color", "rgb(200, 30, 30)");
  // … but no script ran: the text, the page's title and the app's title
  // are as they were.
  await expect(inside.locator("#flag")).toHaveText("unverändert");
  for (const probe of ["#eltern", "#keks", "#netz", "#bild"]) await expect(inside.locator(probe)).toHaveText("-");
  const child = page.frames().find((f) => /\/api\/files\/[\w-]+\/html$/.test(f.url()));
  expect(child).toBeTruthy();
  expect(await child!.title()).toBe("Original-Titel");
  expect(await page.title()).toBe(appTitle);
  expect(await page.title()).not.toContain("Skript lief");
  // Nothing was fetched from elsewhere (stylesheet, picture): the policy
  // stopped each request before it left the browser.
  expect(external).toEqual([]);
  for (const reason of blocked) expect(reason).toMatch(/csp/i);

  // Run scripts: the frame reloads with allow-scripts alone and the
  // policy that runs inline scripts only.
  const run = viewer.getByRole("button", { name: "Skripte ausführen" });
  await expect(run).toBeVisible();
  await expect(viewer).toContainText("ohne Zugriff auf Flowplan");
  const scripted = page.waitForResponse((r) => /\/api\/files\/[\w-]+\/html\?scripts=1$/.test(r.url()));
  await run.click();
  const scriptedHeaders = (await scripted).headers();
  expect(scriptedHeaders["content-security-policy"]).toContain("script-src 'unsafe-inline'");
  expect(scriptedHeaders["content-security-policy"]).toContain("connect-src 'none'");
  expect(scriptedHeaders["content-security-policy"]).toMatch(/(^|; )sandbox allow-scripts(;|$)/);
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  await expect(frame).toHaveAttribute("src", /\/html\?scripts=1$/);
  await expect(viewer).toContainText("Skripte laufen abgeschottet, ohne Netzwerk.");
  // The script ran …
  await expect(inside.locator("#flag")).toHaveText("verändert", { timeout: 10_000 });
  await expect(inside.locator("#bild")).toHaveText("onerror");
  // … in an origin of its own: the app's document, the cookies and the
  // network are out of reach.
  await expect(inside.locator("#eltern")).toHaveText(/^gesperrt: SecurityError$/);
  await expect(inside.locator("#keks")).toHaveText(/^gesperrt: SecurityError$/);
  await expect(inside.locator("#netz")).toHaveText(/^gesperrt: TypeError$/);
  await expect(inside.locator("#netz-csp")).toHaveText(/^connect-src/);
  const running = page.frames().find((f) => /\/html\?scripts=1$/.test(f.url()));
  expect(running).toBeTruthy();
  expect(await running!.title()).toBe("Skript lief");
  expect(await page.title()).toBe(appTitle);
  expect(external).toEqual([]);
  for (const reason of blocked) expect(reason).toMatch(/csp/i);

  // Stop scripts: inert again.
  await viewer.getByRole("button", { name: "Skripte anhalten" }).click();
  await expect(frame).toHaveAttribute("sandbox", "");
  await expect(viewer).toContainText("Skripte und externe Inhalte sind abgeschaltet.");
  await expect(inside.getByRole("heading", { name: "Grüße aus der Datei" })).toBeVisible({ timeout: 10_000 });
  await expect(inside.locator("#flag")).toHaveText("unverändert");

  // "Bei dieser Datei immer zulassen" (#425): remembered in the account,
  // so the next opening starts with scripts running; unticked, it asks again.
  const close = async () => {
    await page.keyboard.press("Escape");
    if (await viewer.isVisible()) await viewer.getByRole("button", { name: "Schließen" }).click();
    await expect(viewer).toBeHidden();
  };
  const always = viewer.getByRole("checkbox", { name: "Bei dieser Datei immer zulassen" });
  await expect(always).not.toBeChecked();
  const saved = page.waitForResponse((r) => r.url().endsWith("/api/command") && r.request().postDataJSON()?.action === "profile.htmlScripts");
  await always.check();
  expect((await saved).ok()).toBe(true);
  await expect(always).toBeChecked();
  // Ticking runs them right away.
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  await expect(viewer).toContainText("ändert sich die Datei, fragt Flowplan erneut");
  await close();
  await card.click();
  await expect(viewer).toBeVisible();
  await expect(always).toBeChecked();
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  await expect(frame).toHaveAttribute("src", /\/html\?scripts=1$/);
  await expect(viewer).toContainText("Skripte laufen abgeschottet, ohne Netzwerk.");
  await expect(inside.locator("#flag")).toHaveText("verändert", { timeout: 10_000 });
  await expect(inside.locator("#netz")).toHaveText(/^gesperrt: TypeError$/);
  // Unticked: forgotten; scripts keep running for this opening only.
  const forgotten = page.waitForResponse((r) => r.url().endsWith("/api/command") && r.request().postDataJSON()?.action === "profile.htmlScripts");
  await always.uncheck();
  expect((await forgotten).ok()).toBe(true);
  await expect(always).not.toBeChecked();
  await expect(viewer).not.toContainText("ändert sich die Datei, fragt Flowplan erneut");
  await close();
  await card.click();
  await expect(viewer).toBeVisible();
  await expect(viewer).toContainText("Skripte und externe Inhalte sind abgeschaltet.");
  await expect(frame).toHaveAttribute("sandbox", "");
  await expect(always).not.toBeChecked();
  await expect(inside.locator("#flag")).toHaveText("unverändert", { timeout: 10_000 });

  await close();
  expect(errors).toEqual([]);
});
