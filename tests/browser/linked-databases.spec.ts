import { test, expect, type Page } from "@playwright/test";
async function fixture(page: Page, suffix: string) {
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
  const create = (kind: string, title: string) =>
    command({
      action: "page.create",
      workspaceId: boot.workspace.id,
      spaceId: boot.spaces[0].id,
      kind,
      title,
    });
  const source = await create("database", `Linked source ${suffix}`),
    host = await create("document", `Linked overview ${suffix}`);
  const read = async (pid: string) =>
    (await page.request.get(`/api/pages/${pid}`)).json();
  const fields = [
    { id: "title", name: "Name", type: "text" },
    { id: "status", name: "Status", type: "select", options: ["Open", "Done"] },
  ];
  await command({
    action: "database.update",
    pageId: source.id,
    version: (await read(source.id)).database.version,
    fields,
    views: [
      { id: "table", name: "Tabelle", type: "table", filters: [], sorts: [] },
    ],
  });
  const ids: string[] = [];
  for (const [title, status] of [
    ["Alpha", "Open"],
    ["Beta", "Done"],
    ["Gamma", "Done"],
  ])
    ids.push(
      (
        await command({
          action: "row.create",
          pageId: source.id,
          cells: { title, status },
        })
      ).id,
    );
  return { source, host, command, read, ids, origin };
}
test("linked databases insert, filter independently, edit source records, add views and persist on mobile", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const f = await fixture(page, `${info.project.name} ${Date.now()}`);
  await page.goto(`/#page=${f.host.id}`);
  const insert = async () => {
    await page
      .getByRole("button", { name: "Block hinzufügen", exact: true })
      .click();
    await page.getByRole("button", { name: /^Verknüpfte Datenbank/ }).click();
    const picker = page.getByRole("dialog", {
      name: "Datenbank verknüpfen",
      exact: true,
    });
    await picker
      .getByLabel("Datenquelle suchen", { exact: true })
      .fill(f.source.title || "Linked source");
    // The create response contains only the ID; pick the unique source by its current title.
    await picker
      .getByRole("button", {
        name: (await f.read(f.source.id)).page.title,
        exact: true,
      })
      .click();
    await expect(picker).not.toBeVisible();
  };
  await insert();
  const embeds = page.locator(".linked-database");
  await expect(embeds).toHaveCount(1);
  await expect(embeds.first().locator(".title-cell")).toHaveText([
    "Alpha",
    "Beta",
    "Gamma",
  ]);
  await page
    .getByLabel("Dokumentinhalt", { exact: true })
    .locator(":scope > p")
    .last()
    .click();
  await insert();
  await expect(embeds).toHaveCount(2);
  await expect(embeds.nth(1).locator(".title-cell")).toHaveText([
    "Alpha",
    "Beta",
    "Gamma",
  ]);
  const first = embeds.first(),
    second = embeds.nth(1);
  await first.getByRole("button", { name: /^Filtern/ }).click();
  const filter = page.getByRole("dialog", {
    name: "Filter bearbeiten",
    exact: true,
  });
  await filter
    .getByRole("button", { name: "Bedingung hinzufügen", exact: true })
    .click();
  await filter
    .getByLabel("Filter-Eigenschaft", { exact: true })
    .selectOption("status");
  await filter.getByLabel("Filterwert", { exact: true }).selectOption("Done");
  await filter.getByRole("button", { name: "Anwenden", exact: true }).click();
  await expect(filter).not.toBeVisible();
  await expect(first.locator(".title-cell")).toHaveText(["Beta", "Gamma"]);
  await expect(second.locator(".title-cell")).toHaveText([
    "Alpha",
    "Beta",
    "Gamma",
  ]);
  await first.locator(".title-cell").filter({ hasText: "Beta" }).click();
  const entry = page.getByRole("dialog", { name: "Eintrag", exact: true });
  await entry
    .getByRole("combobox", { name: "Status", exact: true })
    .selectOption("Open");
  await expect
    .poll(
      async () =>
        (await f.read(f.source.id)).rows.find(
          (r: { id: string }) => r.id === f.ids[1],
        ).cells.status,
    )
    .toBe("Open");
  await entry
    .locator(".row-document .tiptap")
    .fill("Details from the linked view");
  await entry.getByRole("button", { name: "Schließen", exact: true }).click();
  await expect(first.locator(".title-cell")).toHaveText(["Gamma"]);
  await expect(second.locator(".title-cell")).toHaveText([
    "Alpha",
    "Beta",
    "Gamma",
  ]);
  await first.getByTitle("Ansicht hinzufügen", { exact: true }).click();
  const add = page.getByRole("dialog", {
    name: "Ansicht hinzufügen",
    exact: true,
  });
  await add.getByLabel("Name", { exact: true }).fill("Lokale Liste");
  await add
    .getByRole("combobox", { name: "Darstellung", exact: true })
    .selectOption("list");
  await add
    .getByRole("button", { name: "Ansicht erstellen", exact: true })
    .click();
  await expect(first.locator(".record-list-item")).toHaveCount(3);
  await expect(
    second.getByRole("button", { name: "Lokale Liste", exact: true }),
  ).toHaveCount(0);
  expect((await f.read(f.source.id)).database.views).toHaveLength(1);
  await page.reload();
  await expect(
    first.getByRole("button", { name: "Lokale Liste", exact: true }),
  ).toBeVisible();
  await expect(first.locator(".title-cell")).toHaveText(["Gamma"]);
  await expect(second.locator(".title-cell")).toHaveText([
    "Alpha",
    "Beta",
    "Gamma",
  ]);
  await second
    .getByRole("button", { name: "Eintrag verschieben: Gamma", exact: true })
    .press("Enter");
  const move = page.getByRole("dialog", {
    name: "Eintrag verschieben",
    exact: true,
  });
  await move
    .getByRole("button", { name: "An den Anfang", exact: true })
    .click();
  await expect(second.locator(".title-cell")).toHaveText([
    "Gamma",
    "Alpha",
    "Beta",
  ]);
  await expect(first.locator(".title-cell")).toHaveText(["Gamma"]);
  expect(
    (await f.read(f.source.id)).database.views[0].rowOrder,
  ).toBeUndefined();
  await second.locator(".title-cell").filter({ hasText: "Beta" }).click();
  await expect(entry.locator(".row-document .tiptap")).toContainText(
    "Details from the linked view",
  );
  await entry.getByRole("button", { name: "Schließen", exact: true }).click();
  await first.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `test-results/${info.project.name}-linked-databases.png`,
    fullPage: true,
    animations: "disabled",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  expect(errors).toEqual([]);
  await page.goto("/#home");
  await f.command({ action: "page.delete", pageId: f.host.id });
  await f.command({ action: "page.delete", pageId: f.source.id });
});

test("linked configuration conflicts retain drafts, source locks enforce rights and public editing preserves private embeds", async ({
  page,
  browser,
}, info) => {
  const f = await fixture(page, `${info.project.name} conflict ${Date.now()}`);
  const blockId = crypto.randomUUID(),
    d = await f.read(f.source.id);
  const { htmlState, escaped } = await import("../../lib/document-server");
  await f.command({
    action: "document.sync",
    pageId: f.host.id,
    generation: (await f.read(f.host.id)).generation,
    update: Buffer.from(
      htmlState(
        `<p>Overview</p><div data-linked-database="${blockId}" data-linked-source="${f.source.id}" data-linked-version="1" data-linked-views="${escaped(JSON.stringify(d.database.views))}">Linked database</div><p>End</p>`,
      ),
    ).toString("base64"),
  });
  const linked = async () =>
    (
      await page.request.get(`/api/pages/${f.host.id}/linked/${blockId}`)
    ).json();
  await page.goto(`/#page=${f.host.id}`);
  const embed = page.locator(".linked-database");
  await expect(embed.locator(".title-cell")).toHaveCount(3);
  await embed.getByRole("button", { name: /^Filtern/ }).click();
  const filter = page.getByRole("dialog", {
    name: "Filter bearbeiten",
    exact: true,
  });
  await filter
    .getByRole("button", { name: "Bedingung hinzufügen", exact: true })
    .click();
  await filter.getByLabel("Filterwert", { exact: true }).fill("Local draft");
  const current = await linked();
  await f.command({
    action: "linked.command",
    pageId: f.host.id,
    blockId,
    generation: (await f.read(f.host.id)).generation,
    sourceVersion: current.sourceVersion,
    mutation: {
      action: "database.update",
      version: current.database.version,
      fields: current.database.fields,
      views: [{ ...current.database.views[0], name: "Remote view" }],
    },
  });
  await expect(filter.getByRole("alert")).toContainText(
    "Dein Entwurf bleibt erhalten",
  );
  await expect(
    filter.getByRole("button", { name: "Anwenden", exact: true }),
  ).toBeDisabled();
  await expect(filter.getByRole("alert")).toContainText(
    "Dein Entwurf bleibt erhalten",
  );
  await expect(filter).toBeVisible();
  await expect(filter.getByLabel("Filterwert", { exact: true })).toHaveValue(
    "Local draft",
  );
  await filter.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await f.command({
    action: "page.update",
    pageId: f.source.id,
    patch: { locked: true },
  });
  await expect(
    embed.getByRole("button", { name: "Neu", exact: true }),
  ).toHaveCount(0);
  await expect(
    embed.getByTitle("Ansicht hinzufügen", { exact: true }),
  ).toBeVisible();
  const share = await f.command({
    action: "share.create",
    pageId: f.host.id,
    name: "Guest edit",
    role: "editor",
  });
  const context = await browser.newContext({
    viewport: page.viewportSize()!,
    isMobile: info.project.name === "mobile",
  });
  try {
    const guest = await context.newPage();
    await guest.goto(`${f.origin}/share/${share.token}`);
    await expect(guest.locator(".linked-database-placeholder")).toContainText(
      "Zugriff im Arbeitsbereich erforderlich",
    );
    await expect(guest.getByText("Alpha", { exact: true })).toHaveCount(0);
    expect(
      await guest
        .locator(".linked-database-placeholder")
        .getAttribute("data-linked-source"),
    ).toBeNull();
    await guest
      .getByRole("button", { name: "Inhalt bearbeiten", exact: true })
      .click();
    const editor = guest.getByLabel("Geteilten Inhalt bearbeiten", {
      exact: true,
    });
    await editor.press("ControlOrMeta+End");
    await guest.keyboard.insertText(" Guest text");
    await guest
      .getByRole("button", { name: "Änderungen speichern", exact: true })
      .click();
    await expect(
      guest.getByText("Änderungen gespeichert", { exact: true }),
    ).toBeVisible();
    expect((await linked()).database.views[0].name).toBe("Remote view");
  } finally {
    await context.close();
  }
  await f.command({ action: "page.delete", pageId: f.source.id });
  await expect(embed.locator(".title-cell")).toHaveCount(0, { timeout: 12000 });
  await expect(embed.getByRole("status")).toContainText(
    /nicht gefunden|nicht verfügbar/,
  );
  await page.goto("/#home");
  await f.command({ action: "page.delete", pageId: f.host.id });
});
