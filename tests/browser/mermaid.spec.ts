import { test, expect, type Page } from "@playwright/test";
import { DEFAULT_DIAGRAM } from "../../lib/mermaid-source";
async function fixture(page: Page, title: string, kind = "document") {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", {
      headers: { origin },
      data,
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const host = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    kind,
    title,
  });
  return {
    host,
    origin,
    command,
    read: async () => (await page.request.get(`/api/pages/${host.id}`)).json(),
  };
}
test("Mermaid diagrams validate, render several types, edit, undo, persist and respect locks", async ({
  page,
}, info) => {
  const f = await fixture(
    page,
    `Mermaid editor ${info.project.name} ${Date.now()}`,
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/#page=${f.host.id}`);
  await page
    .getByRole("button", { name: "Block hinzufügen", exact: true })
    .click();
  await page.locator(".slash-menu").getByRole("button", { name: /^Mermaid-Diagramm / }).click();
  const dialog = page.getByRole("dialog", {
    name: "Mermaid-Diagramm",
    exact: true,
  });
  const input = dialog.getByLabel("Mermaid-Quelltext", { exact: true });
  const preview = dialog.getByLabel("Diagrammvorschau");
  await expect(preview).toHaveAttribute("data-diagram-state", "ready", {
    timeout: 30000,
  });
  await input.fill("flowchart LR\nA[broken");
  await expect(preview).toHaveAttribute("data-diagram-state", "error");
  await expect(
    dialog.getByRole("button", { name: "Einfügen", exact: true }),
  ).toBeDisabled();
  await input.fill('flowchart LR\nA["<img src=x onerror=alert(1)>"]');
  await expect(preview).toContainText("ohne HTML");
  await expect(preview.locator("img")).toHaveCount(0);
  for (const source of [
    "sequenceDiagram\nAlice->>Bob: Hallo\nBob-->>Alice: Guten Tag",
    'pie title Aufwand\n"Planung" : 30\n"Umsetzung" : 70',
    "classDiagram\nTask <|-- Project\nTask : +title",
    DEFAULT_DIAGRAM,
  ]) {
    await input.fill(source);
    await expect(
      dialog.getByRole("button", { name: "Einfügen", exact: true }),
    ).toBeEnabled();
    await expect(preview.locator("img")).toBeVisible();
    expect(
      await preview
        .locator("img")
        .evaluate(
          (img: HTMLImageElement) => img.complete && img.naturalWidth > 0,
        ),
    ).toBe(true);
  }
  await dialog.getByRole("button", { name: "Einfügen", exact: true }).click();
  const block = page
    .getByLabel("Dokumentinhalt", { exact: true })
    .locator("[data-mermaid]");
  await expect(block).toHaveAttribute("data-diagram-state", "ready");
  await expect
    .poll(async () => (await f.read()).html)
    .toContain("data-mermaid=");
  expect((await f.read()).html).not.toMatch(/<svg|<img/);
  await page.reload();
  await expect(block).toHaveAttribute("data-diagram-state", "ready");
  await block.focus();
  await block.press("Enter");
  const edited = "sequenceDiagram\nTeam->>Flowplan: Gemeinsam planen";
  await input.fill(edited);
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(block).toHaveAttribute("data-mermaid", edited);
  await page.getByTitle("Rückgängig", { exact: true }).click();
  await expect(block).toHaveAttribute("data-mermaid", DEFAULT_DIAGRAM);
  await page.getByTitle("Wiederholen", { exact: true }).click();
  await expect(block).toHaveAttribute("data-mermaid", edited);
  await block.click();
  await input.fill("discard this draft");
  await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await expect(block).toHaveAttribute("data-mermaid", edited);
  await expect(block).toHaveAttribute("data-diagram-state", "ready");
  await page.screenshot({
    path: `test-results/${info.project.name}-mermaid.png`,
    fullPage: true,
    animations: "disabled",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await expect
    .poll(async () => (await f.read()).html)
    .toContain("Gemeinsam planen");
  await block.hover();
  await block.getByRole("button", { name: "Diagramm vergrößern" }).click();
  await expect(
    page.getByRole("dialog", { name: "Diagramm vergrößert" }),
  ).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await page.keyboard.press("Escape");
  await f.command({
    action: "page.update",
    pageId: f.host.id,
    patch: { locked: true },
  });
  await page.reload();
  await expect(block).toHaveAttribute("role", "figure");
  await block.click();
  await expect(dialog).toHaveCount(0);
  // Zoom and export work for readers as well.
  await expect(block).toHaveAttribute("data-diagram-state", "ready");
  const tools = block.getByRole("toolbar", { name: "Diagramm" });
  const svgDownload = page.waitForEvent("download");
  await tools.getByRole("button", { name: "Als SVG herunterladen" }).click();
  expect((await svgDownload).suggestedFilename()).toBe("diagramm.svg");
  const pngDownload = page.waitForEvent("download");
  await tools.getByRole("button", { name: "Als PNG herunterladen" }).click();
  const png = await pngDownload;
  expect(png.suggestedFilename()).toBe("diagramm.png");
  const { readFileSync } = await import("node:fs");
  expect(
    readFileSync((await png.path())!)
      .subarray(1, 4)
      .toString(),
  ).toBe("PNG");
  await tools.getByRole("button", { name: "Diagramm vergrößern" }).click();
  const viewer = page.getByRole("dialog", { name: "Diagramm vergrößert" });
  await expect(viewer).toBeVisible();
  await expect(viewer.locator("output")).toHaveText("100 %");
  const width = () =>
    viewer.locator("img").evaluate((img: HTMLImageElement) => img.offsetWidth);
  const before = await width();
  await viewer.getByRole("button", { name: "Vergrößern" }).click();
  await expect(viewer.locator("output")).toHaveText("150 %");
  expect(await width()).toBeGreaterThan(before);
  await viewer.getByRole("button", { name: "Schließen" }).click();
  await expect(viewer).toHaveCount(0);
  expect(errors).toEqual([]);
  await page.goto("/#home");
  await f.command({ action: "page.delete", pageId: f.host.id });
});
test("record diagrams render in feeds and public pages and can be edited by authorized guests", async ({
  page,
  browser,
}, info) => {
  const f = await fixture(
    page,
    `Mermaid record ${info.project.name} ${Date.now()}`,
    "database",
  );
  const d = await f.read();
  await f.command({
    action: "database.update",
    pageId: f.host.id,
    version: d.database.version,
    fields: d.database.fields,
    views: [{ id: "feed", name: "Feed", type: "feed", filters: [], sorts: [] }],
  });
  const row = await f.command({
    action: "row.create",
    pageId: f.host.id,
    cells: { title: "Diagram example" },
  });
  const readRow = async () =>
    (await page.request.get(`/api/pages/${f.host.id}/rows/${row.id}`)).json();
  const { htmlState, escaped } = await import("../../lib/document-server");
  await f.command({
    action: "row.document.sync",
    pageId: f.host.id,
    rowId: row.id,
    generation: (await readRow()).generation,
    update: Buffer.from(
      htmlState(
        `<div data-mermaid="${escaped(DEFAULT_DIAGRAM)}">${escaped(DEFAULT_DIAGRAM)}</div>`,
      ),
    ).toString("base64"),
  });
  await page.goto(`/#page=${f.host.id}`);
  const feed = page.getByRole("region", {
    name: "Datenbank-Feed",
    exact: true,
  });
  await expect(feed.locator("[data-mermaid]")).toHaveAttribute(
    "data-diagram-state",
    "ready",
  );
  await feed
    .getByRole("button", { name: "Diagram example", exact: true })
    .click();
  const entry = page.getByRole("dialog", { name: "Eintrag", exact: true });
  await entry
    .getByRole("button", { name: "Diagramm bearbeiten", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Mermaid-Diagramm",
    exact: true,
  });
  await dialog
    .getByLabel("Mermaid-Quelltext")
    .fill("flowchart TD\nStart --> Ziel");
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await entry.getByRole("button", { name: "Schließen", exact: true }).click();
  await expect.poll(async () => (await readRow()).html).toContain("Ziel");
  const link = await f.command({
    action: "share.create",
    pageId: f.host.id,
    role: "editor",
    name: "Diagram guest",
  });
  const visitor = await browser.newContext({
    viewport: page.viewportSize()!,
    isMobile: info.project.name === "mobile",
  });
  try {
    const guest = await visitor.newPage();
    await guest.goto(
      `${f.origin}/share/${link.token}/${f.host.id}?row=${row.id}`,
    );
    await expect(guest.locator("[data-mermaid]")).toHaveAttribute(
      "data-diagram-state",
      "ready",
    );
    await guest
      .getByRole("button", { name: "Inhalt bearbeiten", exact: true })
      .click();
    await guest
      .getByRole("button", { name: "Diagramm bearbeiten", exact: true })
      .click();
    const edit = guest.getByRole("dialog", {
      name: "Mermaid-Diagramm",
      exact: true,
    });
    await edit
      .getByLabel("Mermaid-Quelltext")
      .fill("flowchart LR\nGast --> Fertig");
    await edit.getByRole("button", { name: "Speichern", exact: true }).click();
    await guest
      .getByRole("button", { name: "Änderungen speichern", exact: true })
      .click();
    await expect(
      guest.getByText("Änderungen gespeichert", { exact: true }),
    ).toBeVisible();
    await expect(guest.locator("[data-mermaid]")).toHaveAttribute(
      "data-diagram-state",
      "ready",
    );
    expect((await readRow()).html).toContain("Fertig");
    expect((await readRow()).html).not.toMatch(/<img|<svg/);
  } finally {
    await visitor.close();
  }
  await page.goto("/#home");
  await f.command({ action: "page.delete", pageId: f.host.id });
});

test("diagram drafts follow moved blocks and survive concurrent changes and deletion", async ({
  page,
  browser,
}, info) => {
  const f = await fixture(
    page,
    `Mermaid collaboration ${info.project.name} ${Date.now()}`,
  );
  const { htmlState, escaped } = await import("../../lib/document-server");
  await f.command({
    action: "document.sync",
    pageId: f.host.id,
    generation: (await f.read()).generation,
    update: Buffer.from(
      htmlState(
        `<p>Start</p><div data-mermaid="${escaped(DEFAULT_DIAGRAM)}">${escaped(DEFAULT_DIAGRAM)}</div>`,
      ),
    ).toString("base64"),
  });
  await page.goto(`/#page=${f.host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true }),
    block = editor.locator("[data-mermaid]");
  await expect(block).toHaveAttribute("data-diagram-state", "ready");
  const context = await browser.newContext({
    viewport: page.viewportSize()!,
    isMobile: info.project.name === "mobile",
  });
  try {
    const other = await context.newPage();
    await other.request.post(`${f.origin}/api/auth/demo`, {
      headers: { origin: f.origin },
    });
    await other.goto(`${f.origin}/#page=${f.host.id}`);
    const otherEditor = other.getByLabel("Dokumentinhalt", { exact: true }),
      otherBlock = otherEditor.locator("[data-mermaid]");
    await expect(otherBlock).toHaveAttribute("data-diagram-state", "ready");
    await block.click();
    const dialog = page.getByRole("dialog", {
      name: "Mermaid-Diagramm",
      exact: true,
    });
    const first = "flowchart LR\nA --> Local1";
    await dialog.getByLabel("Mermaid-Quelltext").fill(first);
    await otherEditor.locator("p").first().click();
    await other.keyboard.press("Home");
    await other.keyboard.insertText("Prefix ");
    await expect(editor).toContainText("Prefix", { timeout: 10000 });
    await dialog
      .getByRole("button", { name: "Speichern", exact: true })
      .click();
    await expect(block).toHaveAttribute("data-mermaid", first);
    await expect(otherBlock).toHaveAttribute("data-mermaid", first, {
      timeout: 10000,
    });
    await block.click();
    const second = "flowchart LR\nA --> Local2",
      remote = "flowchart LR\nA --> Remote2";
    await dialog.getByLabel("Mermaid-Quelltext").fill(second);
    await otherBlock.click();
    const otherDialog = other.getByRole("dialog", {
      name: "Mermaid-Diagramm",
      exact: true,
    });
    await otherDialog.getByLabel("Mermaid-Quelltext").fill(remote);
    await otherDialog
      .getByRole("button", { name: "Speichern", exact: true })
      .click();
    await expect(block).toHaveAttribute("data-mermaid", remote, {
      timeout: 10000,
    });
    await dialog
      .getByRole("button", { name: "Speichern", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toContainText(
      "inzwischen geändert oder gelöscht",
    );
    await expect(dialog.getByLabel("Mermaid-Quelltext")).toHaveValue(second);
    await dialog
      .getByRole("button", { name: "Abbrechen", exact: true })
      .click();
    await block.click();
    await otherBlock.click();
    await otherDialog
      .getByRole("button", { name: "Diagramm löschen", exact: true })
      .click();
    await expect(block).toHaveCount(0, { timeout: 10000 });
    await dialog
      .getByRole("button", { name: "Speichern", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toContainText(
      "inzwischen geändert oder gelöscht",
    );
    await expect(dialog.getByLabel("Mermaid-Quelltext")).toHaveValue(remote);
    await dialog
      .getByRole("button", { name: "Abbrechen", exact: true })
      .click();
    await expect
      .poll(async () => (await f.read()).html)
      .not.toContain("data-mermaid");
  } finally {
    await context.close();
  }
  await page.goto("/#home");
  await f.command({ action: "page.delete", pageId: f.host.id });
});
