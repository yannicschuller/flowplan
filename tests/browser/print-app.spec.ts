import { test, expect } from "@playwright/test";

// The iPhone/iPad and Android app (#424): their web views ignore
// window.print(), so "Print / PDF" hands the lean copy – styles and pictures
// inside – to FlowplanApp.print, which opens the system's print dialog.
// The bridge is stubbed here as the app puts it into the page.
test("print in the app hands the lean copy to the app", async ({ page }) => {
  test.setTimeout(90_000);
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const title = `Druck App ${Date.now()}`;
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "document" },
  });
  const pageId = (await created.json()).id;
  type Request = { html: string; title: string; paper: string | null };
  await page.addInitScript(() => {
    const w = window as unknown as { requests: Request[]; printed: number; FlowplanApp: unknown };
    w.requests = [];
    w.printed = 0;
    window.print = () => void w.printed++;
    w.FlowplanApp = Object.freeze({ platform: "android", version: "1.2.0", print: (request: Request) => void w.requests.push(request) });
  });
  await page.goto(`/#page=${pageId}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await editor.click();
  await page.keyboard.type("Ein Absatz zum Drucken in der App.");
  await page.getByRole("button", { name: "Seitenaktionen" }).click();
  await page.getByRole("menuitem", { name: "Drucken / PDF" }).click();
  await page.getByRole("dialog", { name: "Drucken / PDF" }).getByRole("button", { name: "Drucken", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { requests: unknown[] }).requests.length)).toBe(1);
  const [request] = await page.evaluate(() => (window as unknown as { requests: Request[] }).requests);
  // The window's title, as the browser's print dialog has it.
  expect(request.title).toBe(await page.title());
  expect(request.paper === null || request.paper === "a4" || request.paper === "letter").toBe(true);
  // A document of its own: the copy, the instance's styles inside (no
  // stylesheet of the instance to load), the address for the rest.
  const doc = await page.evaluate((html) => {
    const parsed = new DOMParser().parseFromString(html, "text/html");
    return {
      text: parsed.querySelector(".page-content")?.textContent ?? "",
      body: parsed.body.textContent ?? "",
      styles: parsed.querySelectorAll("style").length,
      ownLinks: [...parsed.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].filter((l) => l.href.startsWith(location.origin)).length,
      base: parsed.querySelector("base")?.getAttribute("href"),
      printView: parsed.body.classList.contains("print-view"),
    };
  }, request.html);
  expect(doc.text).toContain("Ein Absatz zum Drucken in der App.");
  expect(doc.body).toContain(title);
  expect(doc.styles).toBeGreaterThan(0);
  expect(doc.ownLinks).toBe(0);
  expect(doc.base).toBe(`${new URL(origin).origin}/`);
  expect(doc.printView).toBe(true);
  // Neither the page nor a frame printed.
  expect(await page.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(0);
  await expect(page.locator("iframe.print-frame")).toHaveCount(0);
});
