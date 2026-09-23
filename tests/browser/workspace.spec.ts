import { test, expect } from "@playwright/test";
test("workspace, documents, databases and mobile navigation", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page
    .getByRole("button", { name: "Lokalen Arbeitsbereich öffnen" })
    .click();
  await expect(page.getByRole("heading", { name: /Alex/ })).toBeVisible();
  await page.screenshot({
    path: `test-results/${testInfo.project.name}-home.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: /Eine Idee festhalten/ }).click();
  const title = `Test ${testInfo.project.name} ${Date.now()}`;
  await page.getByPlaceholder("Wie heißt deine Seite?").fill(title);
  await page
    .getByRole("button", { name: "Seite erstellen", exact: true })
    .click();
  const editor = page.getByRole("textbox", { name: "Dokumentinhalt" });
  await expect(page.locator(".tiptap")).toBeVisible();
  await page.locator(".tiptap").click();
  await page.keyboard.type("Gemeinsam planen und Ideen festhalten.");
  await expect(page.locator(".tiptap")).toContainText("Gemeinsam planen");
  await page.waitForTimeout(2500);
  await page.reload();
  await expect(page.locator(".tiptap")).toContainText("Gemeinsam planen");
  await page
    .getByRole("button", { name: "Block hinzufügen", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Aufgabenliste Schritt für Schritt abhaken" })
    .click();
  await expect(page.locator(".tiptap")).toBeFocused();
  await page.keyboard.type("Erste Aufgabe");
  await expect(page.locator(".tiptap")).toContainText("Erste Aufgabe");
  await page.screenshot({
    path: `test-results/${testInfo.project.name}-editor.png`,
    fullPage: true,
  });
  if (testInfo.project.name === "mobile")
    await page.getByRole("button", { name: "Navigation öffnen" }).click();
  await page
    .getByRole("button", { name: "Produkt-Roadmap", exact: true })
    .first()
    .click();
  await expect(page.locator(".data-table")).toBeVisible();
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await expect(page.locator(".board")).toBeVisible();
  await page.getByRole("button", { name: "Neu", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Eintrag", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Schließen", exact: true }).click();
  await page.getByRole("button", { name: "Kalender", exact: true }).click();
  await expect(page.locator(".calendar-grid")).toBeVisible();
  await page.screenshot({
    path: `test-results/${testInfo.project.name}-calendar.png`,
    fullPage: true,
  });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
  expect(errors).toEqual([]);
});
test("anonymous and CSRF requests cannot access protected APIs", async ({
  request,
}) => {
  expect((await request.get("/api/admin")).status()).toBe(401);
  expect((await request.get("/api/bootstrap")).status()).toBe(401);
  expect(
    (
      await request.post("/api/auth/demo", {
        headers: { origin: "https://evil.example" },
      })
    ).status(),
  ).toBe(403);
});

test("public forms store submissions, search finds content and admin is protected", async ({
  request,
}) => {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  expect(
    (await request.post("/api/auth/demo", { headers: { origin } })).ok(),
  ).toBe(true);
  const boot = await (await request.get("/api/bootstrap")).json();
  expect((await request.get("/api/admin")).status()).toBe(403);
  const command = async (body: Record<string, unknown>) => {
    const r = await request.post("/api/command", {
      headers: { origin },
      data: body,
    });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  const page = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: "Form integration test",
    kind: "database",
  });
  await command({
    action: "form.update",
    pageId: page.id,
    enabled: true,
    internal: false,
    anonymous: true,
  });
  const data = await (await request.get(`/api/pages/${page.id}`)).json();
  const result = await request.post(`/api/forms/${data.form.token}`, {
    headers: { origin },
    data: { cells: { title: "UniqueFormSubmission", priority: "Hoch" } },
  });
  expect(result.ok()).toBe(true);
  const rows = await (await request.get(`/api/pages/${page.id}`)).json();
  expect(rows.rows).toHaveLength(1);
  expect(rows.rows[0].created_by).toBeNull();
  const search = await (
    await request.get(
      `/api/search?workspace=${boot.workspace.id}&q=UniqueFormSubmission`,
    )
  ).json();
  expect(search.some((p: { id: string }) => p.id === page.id)).toBe(true);
  await command({ action: "page.publish", pageId: page.id, enabled: true });
  const published = await (await request.get(`/api/pages/${page.id}`)).json();
  expect(
    (await request.get(`/share/${published.page.public_token}`)).ok(),
  ).toBe(true);
  await command({ action: "page.delete", pageId: page.id });
  expect(
    (await request.get(`/share/${published.page.public_token}`)).status(),
  ).toBe(404);
  expect(
    (
      await request.post(`/api/forms/${data.form.token}`, {
        headers: { origin },
        data: { cells: { title: "blocked" } },
      })
    ).status(),
  ).toBe(404);
});

test("rich record documents and reusable templates persist", async ({
  page,
}, testInfo) => {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", {
      headers: { origin },
      data,
    });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  const database = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Record editor ${testInfo.project.name}`,
    kind: "database",
  });
  const row = await command({
    action: "row.create",
    pageId: database.id,
    cells: { title: "Rich details", status: "In Arbeit" },
  });
  await page.goto(`/#page=${database.id}`);
  await page.getByText("Rich details", { exact: true }).click();
  const editor = page.locator(".row-document .tiptap");
  await expect(editor).toBeVisible();
  await editor.fill("Projektbriefing mit gemeinsamem Dokument.");
  await page
    .getByRole("dialog", { name: "Eintrag", exact: true })
    .getByRole("button", { name: "Schließen", exact: true })
    .click();
  await expect
    .poll(async () => {
      const r = await page.request.get(
        `/api/pages/${database.id}/rows/${row.id}`,
      );
      return (await r.json()).html;
    })
    .toContain("Projektbriefing");
  await page.getByText("Rich details", { exact: true }).click();
  await expect(page.locator(".row-document .tiptap")).toContainText(
    "Projektbriefing",
  );
  await page
    .getByRole("button", { name: "Als Vorlage speichern", exact: true })
    .click();
  const template = page.getByRole("dialog", {
    name: "Datensatzvorlage speichern",
  });
  await template.getByLabel("Name").fill("Briefing-Vorlage");
  await template
    .getByRole("button", { name: "Vorlage speichern", exact: true })
    .click();
  await expect(template).not.toBeVisible();
  await page
    .getByRole("dialog", { name: "Eintrag", exact: true })
    .getByRole("button", { name: "Schließen", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Datensatzvorlagen", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Datensatzvorlagen", exact: true })
    .getByRole("button", { name: "Verwenden", exact: true })
    .click();
  await expect(page.locator(".row-document .tiptap")).toContainText(
    "Projektbriefing",
  );
  await page.screenshot({
    path: `test-results/${testInfo.project.name}-record-document.png`,
    fullPage: true,
  });
  await page
    .getByRole("dialog", { name: "Eintrag", exact: true })
    .getByRole("button", { name: "Schließen", exact: true })
    .click();
  await command({ action: "page.delete", pageId: database.id });
});

test("sidebar moves pages and browser history restores the selected page", async ({
  page,
}, testInfo) => {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", {
      headers: { origin },
      data,
    });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  const parent = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: "Navigation parent",
  });
  const child = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: "Navigation child",
  });
  await page.goto("/#page=" + parent.id);
  await expect(page.locator(".tiptap")).toBeVisible();
  if (testInfo.project.name === "desktop") {
    await page
      .getByRole("button", { name: "Navigation schließen", exact: true })
      .click();
    await expect(page.locator(".sidebar")).not.toBeVisible();
  }
  await page
    .getByRole("button", { name: "Navigation öffnen", exact: true })
    .click();
  if (testInfo.project.name === "desktop") {
    await page
      .locator(`[data-page-id="${child.id}"]`)
      .dragTo(page.locator(`[data-page-id="${parent.id}"]`));
    await expect
      .poll(
        async () =>
          (await (await page.request.get("/api/pages/" + child.id)).json()).page
            .parent_id,
      )
      .toBe(parent.id);
  }
  await page
    .locator(`[data-page-id="${child.id}"]`)
    .getByRole("button", { name: "Navigation child", exact: true })
    .click();
  await expect(page.locator(".breadcrumb")).toContainText("Navigation child");
  await page.goBack();
  await expect(page.locator(".breadcrumb")).toContainText("Navigation parent");
  await command({ action: "page.delete", pageId: parent.id });
  if (testInfo.project.name === "mobile")
    await command({ action: "page.delete", pageId: child.id });
});

test("published subpages expose referenced media to visitors and revoke access immediately", async ({
  page,
  browser,
}, testInfo) => {
  const { htmlState } = await import("../../lib/document-server");
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", {
      headers: { origin },
      data,
    });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  const root = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: "Public guide",
  });
  const child = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: "Public media",
    parentId: root.id,
  });
  const picture = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
    "base64",
  );
  const uploaded = await page.request.post("/api/upload", {
    headers: { origin },
    multipart: {
      pageId: child.id,
      file: { name: "test.png", mimeType: "image/png", buffer: picture },
    },
  });
  expect(uploaded.ok()).toBe(true);
  const file = await uploaded.json();
  const doc = await (await page.request.get("/api/pages/" + child.id)).json();
  await command({
    action: "document.sync",
    pageId: child.id,
    generation: doc.generation,
    update: Buffer.from(
      htmlState(
        `<h2>A shared image</h2><img src="${file.url}" alt="Published picture"><p><a href="/#page=${root.id}">Back to guide</a></p>`,
      ),
    ).toString("base64"),
  });
  await command({
    action: "page.publish",
    pageId: root.id,
    enabled: true,
    includeChildren: true,
  });
  const shared = await (await page.request.get("/api/pages/" + root.id)).json();
  const token = shared.page.public_token;
  const visitor = await browser.newContext({
    viewport:
      testInfo.project.name === "mobile"
        ? { width: 390, height: 844 }
        : { width: 1440, height: 1000 },
  });
  const publicTab = await visitor.newPage();
  await publicTab.goto(origin + "/share/" + token);
  await publicTab.getByRole("link", { name: /Public media/ }).click();
  await expect(
    publicTab.getByRole("heading", { name: "A shared image" }),
  ).toBeVisible();
  const image = publicTab.getByRole("img", { name: "Published picture" });
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((i: HTMLImageElement) => i.naturalWidth))
    .toBe(1);
  const url = `${origin}/api/share/${token}/files/${file.id}`;
  const head = await visitor.request.head(url);
  expect(head.status()).toBe(200);
  expect(head.headers()["content-length"]).toBe(String(picture.length));
  expect((await head.body()).length).toBe(0);
  expect(
    (
      await visitor.request.get(
        `${origin}/api/share/00000000-0000-0000-0000-000000000000/files/${file.id}`,
      )
    ).status(),
  ).toBe(404);
  expect(
    (
      await visitor.request.get(url, { headers: { range: "bytes=0-7" } })
    ).status(),
  ).toBe(206);
  expect((await visitor.request.get(origin + file.url)).status()).toBe(401);
  await publicTab.screenshot({
    path: `test-results/${testInfo.project.name}-published.png`,
    fullPage: true,
  });
  await command({ action: "page.publish", pageId: root.id, enabled: false });
  expect((await visitor.request.get(url)).status()).toBe(404);
  expect(
    (
      await visitor.request.get(`${origin}/share/${token}/${child.id}`)
    ).status(),
  ).toBe(404);
  await visitor.close();
  await command({ action: "page.delete", pageId: root.id });
});

test("content archives download and restore through settings with files intact", async ({
  page,
}, testInfo) => {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", {
      headers: { origin },
      data,
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const title = `Archive ${testInfo.project.name} ${Date.now()}`;
  const workspace = await command({ action: "workspace.create", name: title });
  const boot = await (
    await page.request.get("/api/bootstrap?workspace=" + workspace.id)
  ).json();
  const document = await command({
    action: "page.import",
    workspaceId: workspace.id,
    spaceId: boot.spaces[0].id,
    title: "Archived guide",
    content: "<h2>Archive content</h2>",
    format: "html",
  });
  const source = Buffer.from("Restore this exact attachment.");
  const uploaded = await page.request.post("/api/upload", {
    headers: { origin },
    multipart: {
      pageId: document.id,
      file: { name: "attachment.txt", mimeType: "text/plain", buffer: source },
    },
  });
  expect(uploaded.ok()).toBe(true);
  await page.goto("/");
  if (testInfo.project.name === "mobile")
    await page
      .getByRole("button", { name: "Navigation öffnen", exact: true })
      .click();
  await page.locator(".workspace-switch").click();
  await page.getByRole("menuitem", { name: new RegExp(title) }).click();
  if (testInfo.project.name === "mobile")
    await page
      .getByRole("button", { name: "Navigation öffnen", exact: true })
      .click();
  await page
    .getByRole("button", { name: "Einstellungen", exact: true })
    .click();
  await page.getByRole("button", { name: "Daten", exact: true }).click();
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "ZIP mit Dateien exportieren", exact: true })
    .click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^flowplan-.*\.zip$/);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(chunk);
  const archive = Buffer.concat(chunks);
  expect(archive.subarray(0, 2).toString()).toBe("PK");
  const responsePromise = page.waitForResponse(
    (r) => r.url().includes("/api/backup?") && r.request().method() === "POST",
  );
  await page.locator('input[type=file][accept=".zip"]').setInputFiles({
    name: "restore.zip",
    mimeType: "application/zip",
    buffer: archive,
  });
  const response = await responsePromise;
  expect(response.ok(), await response.text()).toBe(true);
  const restored = await response.json();
  expect(restored.pages).toBe(2);
  expect(restored.files).toBe(1);
  await expect(
    page.getByText("2 Seiten und 1 Datei importiert.", { exact: true }),
  ).toBeVisible();
  const newPage = restored.pageIds[document.id],
    copied = await (await page.request.get("/api/pages/" + newPage)).json();
  expect(copied.html).toContain("Archive content");
  const restoredExport = await page.request.get(
    "/api/backup?workspace=" + workspace.id,
  );
  expect(restoredExport.ok()).toBe(true);
  await page.screenshot({
    path: `test-results/${testInfo.project.name}-archive-settings.png`,
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
});

test("bulk editing and per-view columns work on desktop and mobile", async ({
  page,
}, testInfo) => {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", {
      headers: { origin },
      data,
    });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  const database = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: "Bulk and columns " + testInfo.project.name,
    kind: "database",
  });
  for (const title of ["Bulk first", "Bulk second"])
    await command({
      action: "row.create",
      pageId: database.id,
      cells: { title, status: "Nicht begonnen" },
    });
  const read = async () =>
    await (await page.request.get("/api/pages/" + database.id)).json();
  await page.goto("/#page=" + database.id);
  await page
    .getByRole("checkbox", { name: "Bulk first auswählen", exact: true })
    .check();
  await page
    .getByRole("checkbox", { name: "Bulk second auswählen", exact: true })
    .check();
  await page
    .getByRole("button", { name: "Gemeinsam bearbeiten", exact: true })
    .click();
  const bulk = page.getByRole("dialog", {
    name: "Einträge gemeinsam bearbeiten",
  });
  await bulk.getByLabel("Eigenschaft", { exact: true }).selectOption("status");
  await bulk
    .getByRole("combobox", { name: "Status", exact: true })
    .selectOption("Erledigt");
  await bulk
    .getByRole("button", { name: "Änderung anwenden", exact: true })
    .click();
  await expect(bulk).not.toBeVisible();
  expect(
    (await read()).rows.every(
      (r: { cells: { status: string } }) => r.cells.status === "Erledigt",
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Ansicht und Eigenschaften", exact: true })
    .click();
  const settings = page.getByRole("dialog", { name: "Ansicht konfigurieren" });
  await settings
    .getByRole("button", { name: "Status nach oben", exact: true })
    .click();
  await expect
    .poll(async () => (await read()).database.views[0].fieldOrder?.[0])
    .toBe("status");
  await settings
    .getByRole("spinbutton", { name: "Aufgabe Breite in Pixeln", exact: true })
    .fill("340");
  await settings
    .getByRole("spinbutton", { name: "Aufgabe Breite in Pixeln", exact: true })
    .press("Tab");
  await expect
    .poll(async () => (await read()).database.views[0].columnWidths?.title)
    .toBe(340);
  await settings
    .getByRole("button", { name: "Schließen", exact: true })
    .click();
  await page.reload();
  await expect(page.locator("th[data-field-id]").first()).toHaveAttribute(
    "data-field-id",
    "status",
  );
  await expect(page.locator('th[data-field-id="title"]')).toHaveCSS(
    "width",
    "340px",
  );
  if (testInfo.project.name === "desktop") {
    const handle = page.getByRole("separator", {
      name: "Aufgabe: Spaltenbreite",
      exact: true,
    });
    const bounds = await handle.boundingBox();
    await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + 10);
    await page.mouse.down();
    await page.mouse.move(bounds!.x + bounds!.width / 2 + 40, bounds!.y + 10);
    await page.mouse.up();
    await expect
      .poll(async () => (await read()).database.views[0].columnWidths.title)
      .toBe(380);
  }
  await page.getByText("Bulk first", { exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Eintrag", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("dialog", { name: "Eintrag", exact: true })
    .getByRole("button", { name: "Schließen", exact: true })
    .click();
  await page
    .getByRole("checkbox", {
      name: "Alle sichtbaren Einträge auswählen",
      exact: true,
    })
    .check();
  await page
    .getByRole("toolbar", { name: "Ausgewählte Einträge" })
    .getByRole("button", { name: "Duplizieren", exact: true })
    .click();
  await expect.poll(async () => (await read()).rows.length).toBe(4);
  await expect(
    page.getByRole("toolbar", { name: "Ausgewählte Einträge" }),
  ).not.toBeVisible();
  await page
    .getByRole("checkbox", {
      name: "Alle sichtbaren Einträge auswählen",
      exact: true,
    })
    .check();
  await page
    .getByRole("toolbar", { name: "Ausgewählte Einträge" })
    .getByRole("button", { name: "Löschen", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Einträge löschen", exact: true })
    .getByRole("button", { name: "Einträge löschen", exact: true })
    .click();
  await expect.poll(async () => (await read()).rows.length).toBe(0);
  await page.screenshot({
    path: `test-results/${testInfo.project.name}-database-columns.png`,
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await command({ action: "page.delete", pageId: database.id });
});

test("form designer publishes required questions and custom confirmation", async ({
  page,
  browser,
}, testInfo) => {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", {
      headers: { origin },
      data,
    });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  const database = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: "Designed form " + testInfo.project.name,
    kind: "database",
  });
  await page.goto("/#page=" + database.id);
  await page.getByRole("button", { name: "Formular", exact: true }).click();
  await page
    .getByRole("button", { name: "Formular gestalten", exact: true })
    .click();
  const design = page.getByRole("dialog", { name: "Formular gestalten" });
  await design
    .getByLabel("Formulartitel", { exact: true })
    .fill("Dein Feedback");
  await design
    .getByLabel("Beschreibung", { exact: true })
    .fill("Hilf uns bei der nächsten Version.");
  await design
    .getByRole("checkbox", { name: "Aufgabe ist Pflichtfeld", exact: true })
    .check();
  await design
    .getByLabel("Hinweis zu Aufgabe", { exact: true })
    .fill("Was sollen wir verbessern?");
  await design
    .locator(".form-field-design")
    .filter({ has: page.getByText("Priorität", { exact: true }) })
    .getByRole("checkbox", { name: "Sichtbar", exact: true })
    .uncheck();
  await design
    .getByRole("button", { name: "Status nach oben", exact: true })
    .click();
  await design
    .getByLabel("Beschriftung der Senden-Schaltfläche", { exact: true })
    .fill("Feedback senden");
  await design
    .getByLabel("Titel nach dem Absenden", { exact: true })
    .fill("Danke fürs Feedback");
  await design
    .getByLabel("Bestätigungstext", { exact: true })
    .fill("Deine Idee ist bei uns angekommen.");
  await design
    .getByRole("button", { name: "Formular speichern", exact: true })
    .click();
  await expect(design).not.toBeVisible();
  await page
    .getByRole("checkbox", { name: "Formular aktivieren", exact: true })
    .check();
  await expect(
    page.getByRole("checkbox", { name: "Formular aktivieren", exact: true }),
  ).toBeChecked();
  await page
    .getByRole("checkbox", { name: "Nur für Mitglieder", exact: true })
    .uncheck();
  await expect(
    page.getByRole("checkbox", { name: "Nur für Mitglieder", exact: true }),
  ).not.toBeChecked();
  await page
    .getByRole("checkbox", { name: "Anonyme Antworten", exact: true })
    .check();
  await expect(
    page.getByRole("checkbox", { name: "Anonyme Antworten", exact: true }),
  ).toBeChecked();
  const data = await (
    await page.request.get("/api/pages/" + database.id)
  ).json();
  const visitor = await browser.newContext({
      viewport:
        testInfo.project.name === "mobile"
          ? { width: 390, height: 844 }
          : { width: 1440, height: 1000 },
    }),
    tab = await visitor.newPage();
  await tab.goto(`${origin}/forms/${data.form.token}`);
  await expect(
    tab.getByRole("heading", { name: "Dein Feedback", exact: true }),
  ).toBeVisible();
  await expect(tab.locator(".form-question legend").first()).toHaveText(
    "Status",
  );
  await expect(
    tab.getByRole("combobox", { name: "Priorität", exact: true }),
  ).toHaveCount(0);
  await tab
    .getByRole("button", { name: "Feedback senden", exact: true })
    .click();
  await expect(tab.locator(".form-question").getByRole("alert")).toContainText(
    "Aufgabe: Bitte ausfüllen.",
  );
  expect(
    (
      await visitor.request.post(`${origin}/api/forms/${data.form.token}`, {
        headers: { origin },
        data: { cells: { priority: "Hoch" } },
      })
    ).status(),
  ).toBe(400);
  await tab
    .getByRole("textbox", { name: "Aufgabe", exact: true })
    .fill("A new idea");
  await tab
    .getByRole("textbox", { name: "Aufgabe", exact: true })
    .press("Enter");
  await expect(
    tab.getByRole("heading", { name: "Danke fürs Feedback", exact: true }),
  ).toBeVisible();
  await expect(
    tab.getByText("Deine Idee ist bei uns angekommen.", { exact: true }),
  ).toBeVisible();
  const final = await (
    await page.request.get("/api/pages/" + database.id)
  ).json();
  expect(final.rows).toHaveLength(1);
  expect(final.rows[0].cells.title).toBe("A new idea");
  expect(final.rows[0].created_by).toBeNull();
  await tab.screenshot({
    path: `test-results/${testInfo.project.name}-form-confirmation.png`,
    fullPage: true,
  });
  await visitor.close();
  await command({ action: "page.delete", pageId: database.id });
});

test("saved page templates create complete independent databases from the gallery", async ({
  page,
}, testInfo) => {
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
  const source = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Template source ${testInfo.project.name}`,
    kind: "database",
  });
  await command({
    action: "row.create",
    pageId: source.id,
    cells: { title: "Start milestone", status: "In Arbeit" },
  });
  await command({
    action: "row.create",
    pageId: source.id,
    cells: { title: "Launch milestone", status: "Nicht begonnen" },
  });
  await page.goto(`/#page=${source.id}`);
  await page.getByText("Start milestone", { exact: true }).click();
  await page
    .locator(".row-document .tiptap")
    .fill("Reusable project instructions.");
  await page
    .getByRole("dialog", { name: "Eintrag", exact: true })
    .getByRole("button", { name: "Schließen", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/pages/${source.id}`)).json())
          .rows[0].content,
    )
    .toContain("Reusable project instructions");
  await page
    .getByRole("button", { name: "Seitenaktionen", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Als Vorlage speichern", exact: true })
    .click();
  const name = `Project template ${testInfo.project.name} ${Date.now()}`;
  const save = page.getByRole("dialog", {
    name: "Vorlage speichern",
    exact: true,
  });
  await save.getByLabel("Name", { exact: true }).fill(name);
  await save.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(save).not.toBeVisible();
  if (testInfo.project.name === "mobile")
    await page
      .getByRole("button", { name: "Navigation öffnen", exact: true })
      .click();
  await page.getByRole("button", { name: "Vorlagen", exact: true }).click();
  const gallery = page.getByRole("dialog", { name: "Vorlagen", exact: true });
  await gallery
    .locator(".utility-row")
    .filter({ hasText: name })
    .getByRole("button", { name: "Verwenden", exact: true })
    .click();
  await expect(gallery).not.toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Seitentitel", exact: true }),
  ).toHaveValue(name);
  await expect(
    page.getByText("Start milestone", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Launch milestone", { exact: true }),
  ).toBeVisible();
  const copiedId = new URL(page.url()).hash.replace("#page=", "");
  expect(copiedId).not.toBe(source.id);
  await page.getByText("Start milestone", { exact: true }).click();
  await expect(page.locator(".row-document .tiptap")).toContainText(
    "Reusable project instructions",
  );
  await page
    .locator(".row-document .tiptap")
    .fill("Edited only in the copied project.");
  await page
    .getByRole("dialog", { name: "Eintrag", exact: true })
    .getByRole("button", { name: "Schließen", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/pages/${copiedId}`)).json())
          .rows[0].content,
    )
    .toContain("Edited only");
  const original = await (
    await page.request.get(`/api/pages/${source.id}`)
  ).json();
  expect(original.rows[0].content).toContain("Reusable project instructions");
  await command({ action: "page.delete", pageId: copiedId });
  await command({ action: "page.delete", pageId: source.id });
});

test("page emoji search saves localized icons and survives reload", async ({
  page,
}, testInfo) => {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const response = await page.request.post("/api/command", {
    headers: { origin },
    data: {
      action: "page.create",
      workspaceId: boot.workspace.id,
      spaceId: boot.spaces[0].id,
      title: `Emoji page ${testInfo.project.name}`,
    },
  });
  const created = await response.json();
  await page.goto(`/#page=${created.id}`);
  await page
    .getByRole("button", { name: "Seiten-Icon ändern", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Seiten-Icon", exact: true });
  await expect(dialog.getByRole("status")).toContainText("Emojis gefunden");
  await page.screenshot({
    path: `test-results/${testInfo.project.name}-emoji-picker.png`,
  });
  await dialog
    .getByRole("searchbox", { name: "Emoji suchen", exact: true })
    .fill("Rakete");
  await dialog.getByRole("button", { name: "Rakete 🚀", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Seiten-Icon ändern", exact: true }),
  ).toContainText("🚀");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Seiten-Icon ändern", exact: true }),
  ).toContainText("🚀");
  await page
    .getByRole("button", { name: "Seiten-Icon ändern", exact: true })
    .click();
  await dialog
    .getByRole("searchbox", { name: "Emoji suchen", exact: true })
    .fill("winkende Hand");
  await dialog.getByLabel("Hautton", { exact: true }).selectOption("5");
  await dialog
    .getByRole("button", {
      name: "winkende Hand: dunkle Hautfarbe 👋🏿",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", { name: "Seiten-Icon ändern", exact: true }),
  ).toContainText("👋🏿");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.delete", pageId: created.id },
  });
});

test("saved template management renames, changes visibility, deletes and restores", async ({
  page,
}, testInfo) => {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", {
      headers: { origin },
      data,
    });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  const source = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: "Managed template source",
  });
  const name = `Managed template ${testInfo.project.name} ${Date.now()}`;
  await command({ action: "template.save", pageId: source.id, name });
  await page.goto("/");
  if (testInfo.project.name === "mobile")
    await page
      .getByRole("button", { name: "Navigation öffnen", exact: true })
      .click();
  await page.getByRole("button", { name: "Vorlagen", exact: true }).click();
  const gallery = page.getByRole("dialog", { name: "Vorlagen", exact: true });
  await gallery
    .getByRole("button", { name: `${name} bearbeiten`, exact: true })
    .click();
  const edit = page.getByRole("dialog", {
    name: "Vorlage bearbeiten",
    exact: true,
  });
  await edit.getByLabel("Name", { exact: true }).fill(name + " renamed");
  await edit
    .getByRole("checkbox", { name: "Nur für mich sichtbar", exact: true })
    .check();
  await edit
    .getByRole("button", { name: "Änderungen speichern", exact: true })
    .click();
  await expect(edit).not.toBeVisible();
  const row = gallery
    .locator(".saved-template-row")
    .filter({ hasText: name + " renamed" });
  await expect(row).toContainText("Nur für mich");
  await row
    .getByRole("button", { name: `${name} renamed löschen`, exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Vorlage löschen", exact: true })
    .getByRole("button", { name: "In den Papierkorb", exact: true })
    .click();
  await expect(row).not.toBeVisible();
  await gallery.getByRole("checkbox", { name: /Vorlagen-Papierkorb/ }).check();
  await row
    .getByRole("button", { name: "Wiederherstellen", exact: true })
    .click();
  await expect(row).not.toBeVisible();
  await gallery
    .getByRole("checkbox", { name: /Vorlagen-Papierkorb/ })
    .uncheck();
  await expect(row).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await command({ action: "page.delete", pageId: source.id });
});

test("iOS web app metadata and push settings are available without prompting on page load", async ({
  page,
}, testInfo) => {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.addInitScript(() => {
    (
      window as typeof window & { notificationPrompts: number }
    ).notificationPrompts = 0;
    const request = Notification.requestPermission.bind(Notification);
    Notification.requestPermission = (...args) => {
      (window as typeof window & { notificationPrompts: number })
        .notificationPrompts++;
      return request(...args);
    };
  });
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.goto("/#settings");
  await page
    .getByRole("button", { name: "Benachrichtigungen", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Push-Benachrichtigungen", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/zum Home-Bildschirm hinzufügen/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Push aktivieren", exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { notificationPrompts: number })
          .notificationPrompts,
    ),
  ).toBe(0);
  expect(
    await page.evaluate(
      async () =>
        !!(await navigator.serviceWorker.getRegistration("/"))?.active,
    ),
  ).toBe(true);
  const manifest = await (
    await page.request.get("/manifest.webmanifest")
  ).json();
  expect(manifest.display).toBe("standalone");
  expect(manifest.id).toBe("/");
  expect(
    manifest.icons.some((i: { sizes: string }) => i.sizes === "192x192"),
  ).toBe(true);
  expect((await page.request.get("/icons/apple-touch-icon.png")).ok()).toBe(
    true,
  );
  await expect(
    page.locator('meta[name="apple-mobile-web-app-capable"]'),
  ).toHaveAttribute("content", "yes");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
});

test("independent guest links provide read, comment and edit access with revocation", async ({
  page,
  browser,
}, testInfo) => {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", {
      headers: { origin },
      data,
    });
    expect(response.ok()).toBe(true);
    return response.json();
  };
  const created = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Shared roles ${testInfo.project.name}`,
  });
  await page.goto(`/#page=${created.id}`);
  await page.getByRole("button", { name: "Teilen", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Seite teilen",
    exact: true,
  });
  const tokens: Record<string, string> = {};
  for (const [role, name] of [
    ["viewer", "Leselink"],
    ["commenter", "Feedbacklink"],
    ["editor", "Bearbeitungslink"],
  ]) {
    await dialog.getByLabel("Linkname", { exact: true }).fill(name);
    await dialog
      .getByLabel("Linkberechtigung", { exact: true })
      .selectOption(role);
    await dialog
      .getByRole("button", { name: "Freigabelink erstellen", exact: true })
      .click();
    const input = dialog.getByLabel(`Link ${name}`, { exact: true });
    await expect(input).toBeVisible();
    tokens[role] = (await input.inputValue()).split("/").pop()!;
  }
  // Close the member editor so its initial CRDT normalization does not race the guest draft.
  await dialog.getByRole("button", { name: "Schließen", exact: true }).click();
  await page.goto("/#home");
  const guestContext = await browser.newContext({
    viewport: page.viewportSize()!,
    isMobile: testInfo.project.name === "mobile",
  });
  const guest = await guestContext.newPage();
  try {
    await guest.goto(`${origin}/share/${tokens.viewer}`);
    await expect(
      guest.getByText("Dein Link: Lesen", { exact: true }),
    ).toBeVisible();
    await expect(
      guest.getByRole("button", { name: "Inhalt bearbeiten", exact: true }),
    ).toHaveCount(0);
    const forbidden = await guest.request.post(
      `${origin}/api/share/${tokens.viewer}`,
      {
        headers: { origin },
        data: {
          action: "comment",
          pageId: created.id,
          name: "Gast",
          body: "Verboten",
        },
      },
    );
    expect(forbidden.status()).toBe(403);
    await guest.goto(`${origin}/share/${tokens.commenter}`);
    await guest
      .getByLabel("Dein Name", { exact: true })
      .fill("Gast im Browser");
    await guest
      .getByLabel("Kommentar", { exact: true })
      .fill("Feedback ohne Benutzerkonto");
    await guest
      .getByRole("button", { name: "Kommentar veröffentlichen", exact: true })
      .click();
    await expect(
      guest.getByText("Feedback ohne Benutzerkonto", { exact: true }),
    ).toBeVisible();
    await expect(
      guest.getByRole("button", { name: "Inhalt bearbeiten", exact: true }),
    ).toHaveCount(0);
    await guest.goto(`${origin}/share/${tokens.editor}`);
    await guest
      .getByRole("button", { name: "Inhalt bearbeiten", exact: true })
      .click();
    await guest
      .getByLabel("Seitentitel", { exact: true })
      .fill("Vom Gast bearbeitet");
    const editor = guest.getByRole("textbox", {
      name: "Geteilten Inhalt bearbeiten",
      exact: true,
    });
    await editor.fill("Gemeinsame Inhalte über einen Bearbeitungslink.");
    await guest
      .getByRole("button", { name: "Änderungen speichern", exact: true })
      .click();
    await expect(
      guest.getByRole("heading", { name: "Vom Gast bearbeitet", exact: true }),
    ).toBeVisible();
    await guest.reload();
    await expect(
      guest.getByText("Gemeinsame Inhalte über einen Bearbeitungslink.", {
        exact: true,
      }),
    ).toBeVisible();
    expect(
      await guest.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    await guest.screenshot({
      path: `test-results/${testInfo.project.name}-shared-page.png`,
      fullPage: true,
    });
    const csrf = await guest.request.post(
      `${origin}/api/share/${tokens.editor}`,
      {
        headers: { origin: "https://unrelated.example" },
        data: {
          action: "comment",
          pageId: created.id,
          name: "Gast",
          body: "Blocked",
        },
      },
    );
    expect(csrf.status()).toBe(403);
    await command({
      action: "page.update",
      pageId: created.id,
      patch: { locked: true },
    });
    await page.goto(`/#page=${created.id}`);
    await page.getByRole("button", { name: "Teilen", exact: true }).click();
    await dialog
      .getByRole("button", {
        name: "Widerrufen: Bearbeitungslink",
        exact: true,
      })
      .click();
    await expect(
      dialog.getByLabel("Link Bearbeitungslink", { exact: true }),
    ).toHaveCount(0);
    expect(
      (
        await guest.request.get(`${origin}/api/share/${tokens.editor}`)
      ).status(),
    ).toBe(404);
    expect(
      (
        await guest.request.get(`${origin}/api/share/${tokens.viewer}`)
      ).status(),
    ).toBe(200);
    expect(
      (
        await guest.request.get(`${origin}/api/share/${tokens.commenter}`)
      ).status(),
    ).toBe(200);
    const internal = await (
      await page.request.get(`/api/pages/${created.id}`)
    ).json();
    expect(
      internal.comments.some(
        (c: { body: string }) => c.body === "Feedback ohne Benutzerkonto",
      ),
    ).toBe(true);
  } finally {
    await guestContext.close();
    await command({ action: "page.delete", pageId: created.id });
  }
});

test("rollup property picker, progress display and relation board groups work on desktop and mobile", async ({
  page,
}, testInfo) => {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const res = await page.request.post("/api/command", {
      headers: { origin },
      data,
    });
    expect(res.ok(), await res.text()).toBe(true);
    return res.json();
  };
  const create = async (title: string) =>
    command({
      action: "page.create",
      workspaceId: boot.workspace.id,
      spaceId: boot.spaces[0].id,
      kind: "database",
      title,
    });
  const target = await create(`Rollup tasks ${testInfo.project.name}`),
    source = await create(`Rollup projects ${testInfo.project.name}`);
  const targetData = await (
    await page.request.get(`/api/pages/${target.id}`)
  ).json();
  await command({
    action: "database.update",
    pageId: target.id,
    version: targetData.database.version,
    views: targetData.database.views,
    fields: [
      { id: "title", name: "Aufgabe", type: "text" },
      { id: "hours", name: "Stunden", type: "number" },
      { id: "done", name: "Erledigt", type: "checkbox" },
    ],
  });
  const first = await command({
      action: "row.create",
      pageId: target.id,
      cells: { title: "Analyse", hours: 4, done: true },
    }),
    second = await command({
      action: "row.create",
      pageId: target.id,
      cells: { title: "Umsetzung", hours: 6, done: false },
    });
  const sourceData = await (
    await page.request.get(`/api/pages/${source.id}`)
  ).json();
  await command({
    action: "database.update",
    pageId: source.id,
    version: sourceData.database.version,
    views: sourceData.database.views,
    fields: [
      { id: "title", name: "Projekt", type: "text" },
      {
        id: "tasks",
        name: "Aufgaben",
        type: "relation",
        relationPage: target.id,
      },
    ],
  });
  const project = await command({
    action: "row.create",
    pageId: source.id,
    cells: { title: "Website", tasks: [first.id, second.id] },
  });
  await page.goto(`/#page=${source.id}`);
  await page
    .getByRole("button", { name: "Eigenschaft hinzufügen", exact: true })
    .click();
  const property = page.getByRole("dialog", {
    name: "Eigenschaft hinzufügen",
    exact: true,
  });
  await property
    .getByLabel("Eigenschaftsname", { exact: true })
    .fill("Gesamtstunden");
  await property
    .getByLabel("Eigenschaftstyp", { exact: true })
    .selectOption("rollup");
  await property
    .getByLabel("Rollup-Relation", { exact: true })
    .selectOption("tasks");
  await property
    .getByLabel("Rollup-Eigenschaft", { exact: true })
    .selectOption("hours");
  await property
    .getByLabel("Rollup-Berechnung", { exact: true })
    .selectOption("sum");
  await property
    .getByLabel("Rollup-Darstellung", { exact: true })
    .selectOption("bar");
  await property.getByLabel("Rollup-Zielwert", { exact: true }).fill("20");
  await property
    .getByRole("button", { name: "Speichern", exact: true })
    .click();
  await expect(property).not.toBeVisible();
  await expect(
    page.getByRole("progressbar", { name: "Gesamtstunden", exact: true }),
  ).toHaveAttribute("aria-valuenow", "10");
  await page.reload();
  await expect(
    page.getByRole("progressbar", { name: "Gesamtstunden", exact: true }),
  ).toHaveAttribute("aria-valuemax", "20");
  await page.getByRole("cell", { name: "Website", exact: true }).click();
  const record = page.getByRole("dialog", { name: "Eintrag", exact: true });
  await record
    .getByRole("searchbox", { name: "Aufgaben: Einträge suchen", exact: true })
    .fill("Umsetzung");
  await expect(
    record.getByRole("checkbox", { name: "Analyse", exact: true }),
  ).toHaveCount(0);
  await record
    .getByRole("checkbox", { name: "Umsetzung", exact: true })
    .uncheck();
  await expect(
    record.getByRole("progressbar", { name: "Gesamtstunden", exact: true }),
  ).toHaveAttribute("aria-valuenow", "4");
  await record.getByRole("button", { name: "Schließen", exact: true }).click();
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await page.getByTitle("Ansicht und Eigenschaften", { exact: true }).click();
  const config = page.getByRole("dialog", {
    name: "Ansicht konfigurieren",
    exact: true,
  });
  await config.getByLabel("Gruppieren nach").selectOption("tasks");
  await expect(config.locator("fieldset")).toBeEnabled();
  await config.getByRole("button", { name: "Schließen", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Gruppe Analyse", exact: true }),
  ).toContainText("Website");
  await expect(
    page.getByRole("region", { name: "Gruppe Umsetzung", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.screenshot({
    path: `test-results/${testInfo.project.name}-relation-board.png`,
    fullPage: true,
  });
  const latest = await (
    await page.request.get(`/api/pages/${source.id}`)
  ).json();
  expect(
    latest.rows.find((r: { id: string }) => r.id === project.id).cells.tasks,
  ).toEqual([first.id]);
  await command({ action: "page.delete", pageId: source.id });
  await command({ action: "page.delete", pageId: target.id });
});

test("bidirectional relations create an inverse property and synchronize both editors", async ({
  page,
}, testInfo) => {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const result = await page.request.post("/api/command", {
      headers: { origin },
      data,
    });
    expect(result.ok(), await result.text()).toBe(true);
    return result.json();
  };
  const create = async (title: string) =>
    command({
      action: "page.create",
      workspaceId: boot.workspace.id,
      spaceId: boot.spaces[0].id,
      kind: "database",
      title,
    });
  const source = await create(`Two-way projects ${testInfo.project.name}`),
    target = await create(`Two-way tasks ${testInfo.project.name}`);
  // Keep both tables compact on narrow screens.
  for (const p of [source, target]) {
    const d = await (await page.request.get(`/api/pages/${p.id}`)).json();
    await command({
      action: "database.update",
      pageId: p.id,
      version: d.database.version,
      views: d.database.views,
      fields: [{ id: "title", name: "Name", type: "text" }],
    });
  }
  const a = await command({
      action: "row.create",
      pageId: source.id,
      cells: { title: "Website" },
    }),
    b = await command({
      action: "row.create",
      pageId: target.id,
      cells: { title: "Analyse" },
    });
  await page.goto(`/#page=${source.id}`);
  await page
    .getByRole("button", { name: "Eigenschaft hinzufügen", exact: true })
    .click();
  const property = page.getByRole("dialog", {
    name: "Eigenschaft hinzufügen",
    exact: true,
  });
  await property
    .getByLabel("Eigenschaftsname", { exact: true })
    .fill("Aufgaben");
  await property
    .getByLabel("Eigenschaftstyp", { exact: true })
    .selectOption("relation");
  await property
    .getByLabel("Verknüpfte Datenbank", { exact: true })
    .selectOption(target.id);
  await property
    .getByRole("checkbox", { name: "Bidirektional verknüpfen", exact: true })
    .check();
  await property
    .getByLabel("Name der Rückrelation", { exact: true })
    .fill("Projekte");
  await expect(
    property.getByRole("button", { name: "Speichern", exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    path: `test-results/${testInfo.project.name}-two-way-dialog.png`,
    fullPage: true,
  });
  await property
    .getByRole("button", { name: "Speichern", exact: true })
    .click();
  await expect(property).not.toBeVisible();
  await page.getByRole("cell", { name: "Website", exact: true }).click();
  const record = page.getByRole("dialog", { name: "Eintrag", exact: true });
  await record.getByRole("checkbox", { name: "Analyse", exact: true }).check();
  await expect
    .poll(async () => {
      const data = await (
        await page.request.get(`/api/pages/${target.id}`)
      ).json();
      const field = data.database.fields.find(
        (f: { name: string }) => f.name === "Projekte",
      );
      return data.rows.find((r: { id: string }) => r.id === b.id).cells[
        field.id
      ];
    })
    .toEqual([a.id]);
  await record.getByRole("button", { name: "Schließen", exact: true }).click();
  await page.goto(`/#page=${target.id}`);
  await page.getByRole("cell", { name: "Analyse", exact: true }).click();
  await expect(
    record.getByRole("checkbox", { name: "Website", exact: true }),
  ).toBeChecked();
  await record
    .getByRole("checkbox", { name: "Website", exact: true })
    .uncheck();
  await expect
    .poll(async () => {
      const data = await (
        await page.request.get(`/api/pages/${source.id}`)
      ).json();
      const field = data.database.fields.find(
        (f: { name: string }) => f.name === "Aufgaben",
      );
      return data.rows.find((r: { id: string }) => r.id === a.id).cells[
        field.id
      ];
    })
    .toEqual([]);
  await record.getByRole("button", { name: "Schließen", exact: true }).click();
  await page.getByRole("button", { name: "≡ Projekte", exact: true }).click();
  const edit = page.getByRole("dialog", {
    name: "Eigenschaft bearbeiten",
    exact: true,
  });
  await expect(
    edit.getByRole("checkbox", {
      name: "Bidirektional verknüpfen",
      exact: true,
    }),
  ).toBeChecked();
  await edit
    .getByRole("checkbox", { name: "Bidirektional verknüpfen", exact: true })
    .uncheck();
  await edit.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(edit).not.toBeVisible();
  await page.reload();
  const latest = await (
    await page.request.get(`/api/pages/${source.id}`)
  ).json();
  expect(latest.relationPairs).toHaveLength(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await command({ action: "page.delete", pageId: source.id });
  await command({ action: "page.delete", pageId: target.id });
});

test("manual row order supports desktop drag, mobile actions, independent views and explicit sort removal", async ({
  page,
}, testInfo) => {
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
  const p = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Manual order ${testInfo.project.name}`,
    kind: "database",
  });
  const read = async () =>
    (await page.request.get(`/api/pages/${p.id}`)).json();
  const initial = await read();
  await command({
    action: "database.update",
    pageId: p.id,
    version: initial.database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "value", name: "Wert", type: "number" },
      {
        id: "status",
        name: "Status",
        type: "select",
        options: ["Todo", "Done"],
      },
    ],
    views: [
      { id: "table", name: "Tabelle", type: "table", filters: [], sorts: [] },
      {
        id: "board",
        name: "Board",
        type: "board",
        groupBy: "status",
        filters: [],
        sorts: [],
      },
      { id: "list", name: "Liste", type: "list", filters: [], sorts: [] },
      {
        id: "gallery",
        name: "Galerie",
        type: "gallery",
        filters: [],
        sorts: [],
      },
    ],
  });
  const ids: string[] = [];
  for (const [index, title] of ["Alpha", "Beta", "Gamma", "Delta"].entries())
    ids.push(
      (
        await command({
          action: "row.create",
          pageId: p.id,
          cells: {
            title,
            value: 4 - index,
            status: index < 2 ? "Todo" : "Done",
          },
        })
      ).id,
    );
  await page.goto(`/#page=${p.id}`);
  const tableOrder = async () =>
    page
      .locator(".data-table tbody tr")
      .evaluateAll((rows) => rows.map((r) => r.getAttribute("data-row-id")));
  const handle = (title: string) =>
    page.getByRole("button", {
      name: `Eintrag verschieben: ${title}`,
      exact: true,
    });
  const dialog = page.getByRole("dialog", {
    name: "Eintrag verschieben",
    exact: true,
  });
  if (testInfo.project.name === "desktop") {
    await handle("Gamma").dragTo(page.locator(`tr[data-row-id="${ids[0]}"]`), {
      targetPosition: { x: 120, y: 5 },
    });
  } else {
    await handle("Gamma").tap();
    await dialog
      .getByRole("button", { name: "An den Anfang", exact: true })
      .tap();
    await expect(dialog).not.toBeVisible();
  }
  await expect.poll(tableOrder).toEqual([ids[2], ids[0], ids[1], ids[3]]);
  await page.reload();
  await expect.poll(tableOrder).toEqual([ids[2], ids[0], ids[1], ids[3]]);
  if (testInfo.project.name === "desktop")
    await handle("Beta").press("Alt+ArrowUp");
  else {
    await handle("Beta").tap();
    await dialog.getByRole("button", { name: "Nach oben", exact: true }).tap();
    await expect(dialog).not.toBeVisible();
  }
  await expect.poll(tableOrder).toEqual([ids[2], ids[1], ids[0], ids[3]]);
  await page.getByRole("button", { name: "Board", exact: true }).click();
  const todo = page.getByRole("region", { name: "Gruppe Todo", exact: true });
  if (testInfo.project.name === "desktop") {
    await handle("Delta").dragTo(todo.locator(`[data-row-id="${ids[0]}"]`), {
      targetPosition: { x: 70, y: 5 },
    });
  } else {
    await page.locator(`[data-row-id="${ids[3]}"] .record-card`).click();
    const record = page.getByRole("dialog", { name: "Eintrag", exact: true });
    await record
      .getByRole("combobox", { name: "Status", exact: true })
      .selectOption("Todo");
    await expect
      .poll(
        async () =>
          (await read()).rows.find((r: { id: string }) => r.id === ids[3]).cells
            .status,
      )
      .toBe("Todo");
    await record
      .getByRole("button", { name: "Schließen", exact: true })
      .click();
    await todo
      .getByRole("button", { name: "Eintrag verschieben: Delta", exact: true })
      .tap();
    await dialog
      .getByRole("button", { name: "An den Anfang", exact: true })
      .tap();
    await expect(dialog).not.toBeVisible();
  }
  await expect
    .poll(async () =>
      todo
        .locator(".record-card-wrap")
        .evaluateAll((rows) => rows.map((r) => r.getAttribute("data-row-id"))),
    )
    .toEqual([ids[3], ids[0], ids[1]]);
  await page.getByRole("button", { name: "Liste", exact: true }).click();
  await handle("Beta").click();
  await dialog.getByRole("button", { name: "Ans Ende", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect
    .poll(async () =>
      page
        .locator(".record-list-item")
        .evaluateAll((rows) => rows.map((r) => r.getAttribute("data-row-id"))),
    )
    .toEqual([ids[0], ids[2], ids[3], ids[1]]);
  await page.getByRole("button", { name: "Galerie", exact: true }).click();
  await expect
    .poll(async () =>
      page
        .locator(".record-card-wrap")
        .evaluateAll((rows) => rows.map((r) => r.getAttribute("data-row-id"))),
    )
    .toEqual(ids);
  await handle("Delta").click();
  await dialog
    .getByLabel("Bezugseintrag", { exact: true })
    .selectOption(ids[1]);
  await dialog
    .getByLabel("Verschiebeposition", { exact: true })
    .selectOption("before");
  await dialog
    .getByRole("button", { name: "Hierhin verschieben", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect
    .poll(async () =>
      page
        .locator(".record-card-wrap")
        .evaluateAll((rows) => rows.map((r) => r.getAttribute("data-row-id"))),
    )
    .toEqual([ids[0], ids[3], ids[1], ids[2]]);
  const current = await read();
  await command({
    action: "database.update",
    pageId: p.id,
    version: current.database.version,
    fields: current.database.fields,
    views: current.database.views.map((v: { id: string }) =>
      v.id === "table"
        ? { ...v, sorts: [{ field: "value", direction: "asc" }] }
        : v,
    ),
  });
  await page.reload();
  await expect.poll(tableOrder).toEqual([ids[3], ids[2], ids[1], ids[0]]);
  await handle("Alpha").click();
  await dialog
    .getByRole("button", { name: "An den Anfang", exact: true })
    .click();
  const confirm = page.getByRole("dialog", {
    name: "Sortierung aufheben?",
    exact: true,
  });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Abbrechen", exact: true }).click();
  expect((await read()).database.views[0].sorts).toHaveLength(1);
  await handle("Alpha").click();
  await dialog
    .getByRole("button", { name: "An den Anfang", exact: true })
    .click();
  await confirm
    .getByRole("button", {
      name: "Sortierung aufheben und verschieben",
      exact: true,
    })
    .click();
  await expect(confirm).not.toBeVisible();
  await expect.poll(tableOrder).toEqual([ids[0], ids[3], ids[2], ids[1]]);
  expect((await read()).database.views[0].sorts).toHaveLength(0);
  await handle("Delta").click();
  await page.screenshot({
    path: `test-results/${testInfo.project.name}-row-order.png`,
    fullPage: true,
    animations: "disabled",
  });
  await dialog.getByRole("button", { name: "Schließen", exact: true }).click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await command({ action: "page.publish", pageId: p.id, enabled: true });
  const token = (await read()).page.public_token;
  const guest = await page.context().newPage();
  await guest.goto(`/share/${token}`);
  await expect(guest.locator("tbody tr td:first-child")).toHaveText([
    "Alpha",
    "Delta",
    "Gamma",
    "Beta",
  ]);
  await guest.close();
  await command({ action: "page.delete", pageId: p.id });
});

test("nested filters preview and persist AND/OR groups and retain drafts on concurrent updates", async ({
  page,
}, testInfo) => {
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
  const p = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    kind: "database",
    title: `Nested filters ${testInfo.project.name}`,
  });
  const read = async () =>
    (await page.request.get(`/api/pages/${p.id}`)).json();
  const initial = await read();
  await command({
    action: "database.update",
    pageId: p.id,
    version: initial.database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      {
        id: "status",
        name: "Status",
        type: "select",
        options: ["Open", "Done"],
      },
      { id: "priority", name: "Priorität", type: "number" },
      { id: "date", name: "Termin", type: "date" },
    ],
    views: [
      { id: "table", name: "Tabelle", type: "table", filters: [], sorts: [] },
      {
        id: "board",
        name: "Board",
        type: "board",
        filters: [],
        sorts: [],
        groupBy: "status",
      },
    ],
  });
  for (const cells of [
    { title: "Alpha", status: "Open", priority: 4, date: "2026-11-01" },
    { title: "Beta", status: "Open", priority: 1, date: "2026-09-25" },
    { title: "Gamma", status: "Done", priority: 4, date: "2026-09-01" },
    { title: "Delta", status: "Open", priority: 1, date: "2026-11-01" },
  ])
    await command({ action: "row.create", pageId: p.id, cells });
  await page.goto(`/#page=${p.id}`);
  await page.getByRole("button", { name: /^Filtern/ }).click();
  const dialog = page.getByRole("dialog", {
      name: "Filter bearbeiten",
      exact: true,
    }),
    root = dialog.getByRole("group", { name: "Alle Filter", exact: true });
  const actions = root.locator(":scope > .filter-group-actions");
  await actions
    .getByRole("button", { name: "Bedingung hinzufügen", exact: true })
    .click();
  const first = dialog.getByRole("group", { name: "Bedingung 1", exact: true });
  await first
    .getByLabel("Filter-Eigenschaft", { exact: true })
    .selectOption("status");
  await first.getByLabel("Filterwert", { exact: true }).selectOption("Open");
  await actions
    .getByRole("button", { name: "Gruppe hinzufügen", exact: true })
    .click();
  const nested = dialog.getByRole("group", {
    name: "Filtergruppe 2",
    exact: true,
  });
  await expect(
    nested.getByLabel("Filtergruppe 2: Verknüpfung", { exact: true }),
  ).toHaveValue("or");
  const priority = dialog.getByRole("group", {
    name: "Bedingung 2.1",
    exact: true,
  });
  await priority
    .getByLabel("Filter-Eigenschaft", { exact: true })
    .selectOption("priority");
  await priority
    .getByLabel("Filterbedingung", { exact: true })
    .selectOption("gte");
  await priority.getByLabel("Filterwert", { exact: true }).fill("3");
  await nested
    .getByRole("button", { name: "Bedingung hinzufügen", exact: true })
    .click();
  const due = dialog.getByRole("group", { name: "Bedingung 2.2", exact: true });
  await due
    .getByLabel("Filter-Eigenschaft", { exact: true })
    .selectOption("date");
  await due
    .getByLabel("Filterbedingung", { exact: true })
    .selectOption("before");
  await due.getByLabel("Filterwert", { exact: true }).fill("2026-10-01");
  await expect(dialog.getByRole("status")).toContainText("2 von 4 Einträgen");
  expect((await read()).database.views[0].filterGroup).toBeUndefined();
  await dialog.evaluate((el) => el.scrollTo(0, 0));
  await page.screenshot({
    path: `test-results/${testInfo.project.name}-nested-filters.png`,
    fullPage: true,
    animations: "disabled",
  });
  expect(await dialog.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
    false,
  );
  await dialog.getByRole("button", { name: "Anwenden", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator("tbody .title-cell")).toHaveText(["Alpha", "Beta"]);
  await page.reload();
  await expect(page.locator("tbody .title-cell")).toHaveText(["Alpha", "Beta"]);
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await expect(page.locator(".record-card")).toHaveCount(4);
  await page.getByRole("button", { name: "Tabelle", exact: true }).click();
  await page.getByRole("button", { name: /^Filtern/ }).click();
  await root
    .getByLabel("Alle Filter: Verknüpfung", { exact: true })
    .selectOption("or");
  await expect(dialog.getByRole("status")).toContainText("4 von 4 Einträgen");
  await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await expect(page.locator("tbody .title-cell")).toHaveText(["Alpha", "Beta"]);
  await page.getByRole("button", { name: /^Filtern/ }).click();
  await nested
    .locator(":scope > .filter-group-actions")
    .getByRole("button", { name: "Gruppe hinzufügen", exact: true })
    .click();
  const third = dialog.getByRole("group", {
    name: "Filtergruppe 2.3",
    exact: true,
  });
  await third
    .locator(":scope > .filter-group-actions")
    .getByRole("button", { name: "Gruppe hinzufügen", exact: true })
    .click();
  const fourth = dialog.getByRole("group", {
    name: "Filtergruppe 2.3.2",
    exact: true,
  });
  await expect(
    fourth.getByRole("button", { name: "Gruppe hinzufügen", exact: true }),
  ).toBeDisabled();
  expect(await dialog.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
    false,
  );
  await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await page.getByRole("button", { name: /^Filtern/ }).click();
  await priority.getByLabel("Filterwert", { exact: true }).fill("4");
  const current = await read();
  await command({
    action: "database.update",
    pageId: p.id,
    version: current.database.version,
    fields: current.database.fields,
    views: current.database.views.map((v: { id: string }) =>
      v.id === "table" ? { ...v, name: "Aktuelle Ansicht" } : v,
    ),
  });
  // A second collaborator changes the view while this unsaved draft stays open.
  await expect(
    dialog.getByText(/Die Ansicht wurde inzwischen geändert/),
  ).toBeVisible({ timeout: 15000 });
  await expect(priority.getByLabel("Filterwert", { exact: true })).toHaveValue(
    "4",
  );
  await expect(
    dialog.getByRole("button", { name: "Anwenden", exact: true }),
  ).toBeDisabled();
  await dialog
    .getByRole("button", {
      name: "Entwurf verwerfen und neu laden",
      exact: true,
    })
    .click();
  await expect(priority.getByLabel("Filterwert", { exact: true })).toHaveValue(
    "3",
  );
  await dialog
    .getByRole("button", { name: "Alle Filter entfernen", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Anwenden", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator("tbody .title-cell")).toHaveText([
    "Alpha",
    "Beta",
    "Gamma",
    "Delta",
  ]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await command({ action: "page.delete", pageId: p.id });
});

test("chart views aggregate filtered rows, persist settings, export and open source entries", async ({
  page,
}, testInfo) => {
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
  const p = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    kind: "database",
    title: `Charts ${testInfo.project.name}`,
  });
  const read = async () =>
    (await page.request.get(`/api/pages/${p.id}`)).json();
  const initial = await read();
  await command({
    action: "database.update",
    pageId: p.id,
    version: initial.database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      {
        id: "status",
        name: "Status",
        type: "select",
        options: ["Open", "Done"],
      },
      { id: "amount", name: "Aufwand", type: "number" },
      { id: "date", name: "Termin", type: "date" },
    ],
    views: [
      { id: "table", name: "Tabelle", type: "table", filters: [], sorts: [] },
    ],
  });
  for (const cells of [
    { title: "Alpha", status: "Open", amount: 3, date: "2026-09-23" },
    { title: "Beta", status: "Open", amount: 2, date: "2026-09-24" },
    { title: "Gamma", status: "Done", amount: 7, date: "2026-10-01" },
    { title: "Delta", amount: 0 },
  ])
    await command({ action: "row.create", pageId: p.id, cells });
  await page.goto(`/#page=${p.id}`);
  await page.getByTitle("Ansicht hinzufügen", { exact: true }).click();
  const create = page.getByRole("dialog", {
    name: "Ansicht hinzufügen",
    exact: true,
  });
  await create.getByLabel("Name", { exact: true }).fill("Auswertung");
  await create
    .getByRole("combobox", { name: "Darstellung", exact: true })
    .selectOption("chart");
  await create
    .getByRole("button", { name: "Ansicht erstellen", exact: true })
    .click();
  const chart = page.getByRole("region", {
    name: "Datenbankdiagramm",
    exact: true,
  });
  await expect(chart).toBeVisible();
  const configure = async () =>
    chart
      .getByRole("button", { name: "Diagramm konfigurieren", exact: true })
      .click();
  const dialog = page.getByRole("dialog", {
    name: "Diagramm konfigurieren",
    exact: true,
  });
  const apply = async () => {
    await dialog.getByRole("button", { name: "Anwenden", exact: true }).click();
    await expect(dialog).not.toBeVisible();
  };
  await configure();
  await dialog
    .getByRole("combobox", { name: "Berechnung", exact: true })
    .selectOption("sum");
  await expect(
    dialog.getByRole("combobox", { name: "Messwert", exact: true }),
  ).toHaveValue("amount");
  await apply();
  await expect(chart.locator("tbody tr")).toHaveText([
    "Done71",
    "Ohne Wert01",
    "Open52",
  ]);
  await chart
    .locator("svg")
    .getByRole("button", { name: "Open: 5 · 2 Einträge", exact: true })
    .click();
  const details = page.getByRole("dialog", {
    name: "Einträge · Open",
    exact: true,
  });
  await expect(
    details.getByRole("button", { name: "Alpha 3", exact: true }),
  ).toBeVisible();
  await details.getByRole("button", { name: "Alpha 3", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Eintrag", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByLabel("Datenbank durchsuchen", { exact: true }).fill("Alpha");
  await expect(chart.locator("tbody tr")).toHaveText(["Open31"]);
  await page.getByLabel("Datenbank durchsuchen", { exact: true }).fill("");
  await configure();
  await dialog
    .getByRole("combobox", { name: "Diagrammtyp", exact: true })
    .selectOption("line");
  await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await expect(chart.locator('svg[aria-label="Säulendiagramm"]')).toBeVisible();
  await configure();
  await dialog
    .getByRole("combobox", { name: "Diagrammtyp", exact: true })
    .selectOption("line");
  await dialog
    .getByRole("combobox", { name: "Gruppierung", exact: true })
    .selectOption("date");
  await dialog
    .getByRole("combobox", { name: "Datumsintervall", exact: true })
    .selectOption("month");
  await apply();
  await expect(chart.locator("tbody tr")).toHaveText([
    "2026-0952",
    "2026-1071",
    "Ohne Wert01",
  ]);
  await expect(chart.locator('svg[aria-label="Liniendiagramm"]')).toBeVisible();
  await configure();
  await dialog
    .getByRole("combobox", { name: "Diagrammtyp", exact: true })
    .selectOption("donut");
  await dialog
    .getByRole("combobox", { name: "Gruppierung", exact: true })
    .selectOption("status");
  await apply();
  await expect(chart.locator('svg[aria-label="Donutdiagramm"]')).toBeVisible();
  const downloading = page.waitForEvent("download");
  await chart
    .getByRole("button", { name: "Auswertung als CSV", exact: true })
    .click();
  const exported = await downloading;
  expect(exported.suggestedFilename()).toBe("Auswertung-Auswertung.csv");
  const stream = await exported.createReadStream();
  const chunks = [];
  for await (const chunk of stream!) chunks.push(chunk);
  expect(Buffer.concat(chunks).toString()).toContain("Open,5,2");
  await page.reload();
  await page.getByRole("button", { name: "Auswertung", exact: true }).click();
  await expect(chart.locator('svg[aria-label="Donutdiagramm"]')).toBeVisible();
  await page.screenshot({
    path: `test-results/${testInfo.project.name}-database-chart.png`,
    fullPage: true,
    animations: "disabled",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await configure();
  await dialog
    .getByRole("combobox", { name: "Diagrammtyp", exact: true })
    .selectOption("horizontal");
  const current = await read();
  const chartView = current.database.views.find(
    (v: { type: string }) => v.type === "chart",
  );
  await command({
    action: "database.update",
    pageId: p.id,
    version: current.database.version,
    fields: current.database.fields,
    views: current.database.views.map((v: { id: string }) =>
      v.id === chartView.id
        ? { ...v, filters: [{ field: "status", op: "eq", value: "Open" }] }
        : v,
    ),
  });
  await expect(
    dialog.getByText(/Die Ansicht wurde inzwischen geändert/),
  ).toBeVisible({ timeout: 15000 });
  await expect(
    dialog.getByRole("combobox", { name: "Diagrammtyp", exact: true }),
  ).toHaveValue("horizontal");
  await expect(
    dialog.getByRole("button", { name: "Anwenden", exact: true }),
  ).toBeDisabled();
  await dialog
    .getByRole("button", {
      name: "Entwurf verwerfen und neu laden",
      exact: true,
    })
    .click();
  await dialog
    .getByRole("combobox", { name: "Diagrammtyp", exact: true })
    .selectOption("horizontal");
  await apply();
  await expect(chart.locator('svg[aria-label="Balkendiagramm"]')).toBeVisible();
  await expect(chart.locator("tbody tr")).toHaveText(["Open52"]);
  await page.getByRole("button", { name: "Tabelle", exact: true }).click();
  await expect(page.locator("tbody .title-cell")).toHaveCount(4);
  await command({ action: "page.delete", pageId: p.id });
});

test("feed views show rich documents, load more entries and preserve searchable configurable previews", async ({
  page,
}, testInfo) => {
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
  const p = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    kind: "database",
    title: `Feed ${testInfo.project.name}`,
  });
  const read = async () =>
    (await page.request.get(`/api/pages/${p.id}`)).json();
  const initial = await read();
  await command({
    action: "database.update",
    pageId: p.id,
    version: initial.database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      {
        id: "status",
        name: "Status",
        type: "select",
        options: ["Open", "Done"],
      },
    ],
    views: [
      { id: "table", name: "Tabelle", type: "table", filters: [], sorts: [] },
    ],
  });
  const ids: string[] = [];
  for (let i = 0; i < 21; i++)
    ids.push(
      (
        await command({
          action: "row.create",
          pageId: p.id,
          cells: {
            title:
              i === 0
                ? "Feed Alpha"
                : i === 1
                  ? "Feed Beta"
                  : `Eintrag ${i + 1}`,
            status: i === 1 ? "Done" : "Open",
          },
        })
      ).id,
    );
  const { htmlState } = await import("../../lib/document-server");
  for (const [rowId, html] of [
    [
      ids[0],
      '<h2>Release-Notizen</h2><p>Ein <strong>formatierter</strong> Beitrag.</p><ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked></label><div><p>Abnahme abgeschlossen</p></div></li></ul><div data-math="x^2 + y^2" class="math-block">x^2 + y^2</div><details><summary>Weitere Details</summary><div><p>Zusätzliche Informationen</p></div></details>',
    ],
    [ids[1], "<p>Nur im Dokument steht diese Suchnadel.</p>"],
  ]) {
    const doc = await (
      await page.request.get(`/api/pages/${p.id}/rows/${rowId}`)
    ).json();
    await command({
      action: "row.document.sync",
      pageId: p.id,
      rowId,
      generation: doc.generation,
      update: Buffer.from(htmlState(html)).toString("base64"),
    });
  }
  await command({
    action: "comment.create",
    pageId: p.id,
    rowId: ids[0],
    body: "Ein Kommentar im Feed",
  });
  await page.goto(`/#page=${p.id}`);
  await page.getByTitle("Ansicht hinzufügen", { exact: true }).click();
  const create = page.getByRole("dialog", {
    name: "Ansicht hinzufügen",
    exact: true,
  });
  await create.getByLabel("Name", { exact: true }).fill("Feed");
  await create
    .getByRole("combobox", { name: "Darstellung", exact: true })
    .selectOption("feed");
  await create
    .getByRole("button", { name: "Ansicht erstellen", exact: true })
    .click();
  const feed = page.getByRole("region", {
    name: "Datenbank-Feed",
    exact: true,
  });
  await expect(feed.getByRole("article")).toHaveCount(20);
  const alpha = feed.getByRole("article", { name: "Feed Alpha", exact: true });
  await expect(
    alpha.getByRole("heading", { name: "Release-Notizen", exact: true }),
  ).toBeVisible();
  await expect(alpha.locator(".feed-document strong")).toHaveText(
    "formatierter",
  );
  await expect(alpha.getByRole("checkbox")).toBeChecked();
  await expect(alpha.getByRole("checkbox")).toBeDisabled();
  await expect(alpha.locator(".katex")).toBeVisible();
  await expect(
    alpha.getByRole("button", {
      name: "1 Kommentare zu Feed Alpha",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    await alpha.locator(".feed-document").getAttribute("contenteditable"),
  ).toBeNull();
  await page.screenshot({
    path: `test-results/${testInfo.project.name}-database-feed.png`,
    fullPage: true,
    animations: "disabled",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await feed
    .getByRole("button", { name: "Weitere 1 Einträge anzeigen", exact: true })
    .click();
  await expect(feed.getByRole("article")).toHaveCount(21);
  await page
    .getByLabel("Datenbank durchsuchen", { exact: true })
    .fill("Suchnadel");
  await expect(feed.getByRole("article")).toHaveCount(1);
  await expect(
    feed.getByRole("article", { name: "Feed Beta", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Datenbank durchsuchen", { exact: true }).fill("");
  await expect(feed.getByRole("article")).toHaveCount(20);
  await alpha
    .getByRole("button", { name: "1 Kommentare zu Feed Alpha", exact: true })
    .click();
  const entry = page.getByRole("dialog", { name: "Eintrag", exact: true });
  await expect(
    entry.getByText("Ein Kommentar im Feed", { exact: true }),
  ).toBeVisible();
  const editor = page.locator(".row-document .tiptap");
  await expect(editor).toBeVisible();
  await editor.fill("Aktualisierter Feed-Inhalt");
  await entry.getByRole("button", { name: "Schließen", exact: true }).click();
  await expect(alpha.locator(".feed-document")).toContainText(
    "Aktualisierter Feed-Inhalt",
    { timeout: 15000 },
  );
  await page.getByTitle("Ansicht und Eigenschaften", { exact: true }).click();
  const settings = page.getByRole("dialog", {
    name: "Ansicht konfigurieren",
    exact: true,
  });
  await settings
    .getByLabel("Feed-Dokumentinhalt", { exact: true })
    .selectOption("compact");
  await expect
    .poll(
      async () =>
        (await read()).database.views.find(
          (v: { type: string }) => v.type === "feed",
        ).feed?.content,
    )
    .toBe("compact");
  await settings.getByRole("checkbox", { name: "Status", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await read()).database.views.find(
          (v: { type: string }) => v.type === "feed",
        ).hiddenFields,
    )
    .toEqual(["status"]);
  await settings
    .getByRole("checkbox", { name: "Erstellungsdatum anzeigen", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await read()).database.views.find(
          (v: { type: string }) => v.type === "feed",
        ).feed?.showDate,
    )
    .toBe(false);
  await settings
    .getByRole("button", { name: "Schließen", exact: true })
    .click();
  await expect(alpha.locator(".feed-document")).toHaveCount(0);
  await expect(alpha.locator(".feed-excerpt")).toHaveText(
    "Aktualisierter Feed-Inhalt",
  );
  await expect(alpha.locator(".feed-properties")).toHaveCount(0);
  await expect(alpha.locator("time")).toHaveCount(0);
  await alpha
    .getByRole("button", { name: "Vollständigen Inhalt anzeigen", exact: true })
    .click();
  await expect(alpha.locator(".feed-document")).toHaveText(
    "Aktualisierter Feed-Inhalt",
  );
  await page.reload();
  await page.getByRole("button", { name: "Feed", exact: true }).click();
  await expect(alpha.locator(".feed-excerpt")).toHaveText(
    "Aktualisierter Feed-Inhalt",
  );
  await expect(alpha.locator("time")).toHaveCount(0);
  // The feed uses the same versioned row-order operation and keyboard control.
  const move = feed
    .getByRole("article", { name: "Feed Beta", exact: true })
    .getByRole("button", {
      name: "Eintrag verschieben: Feed Beta",
      exact: true,
    });
  await move.focus();
  await move.press("Alt+ArrowUp");
  await expect(feed.getByRole("article").first()).toHaveAttribute(
    "aria-label",
    "Feed Beta",
  );
  const alphaMove = alpha.getByRole("button", {
    name: "Eintrag verschieben: Feed Alpha",
    exact: true,
  });
  if (testInfo.project.name === "desktop") {
    await alphaMove.dragTo(
      feed.getByRole("article", { name: "Feed Beta", exact: true }),
      { targetPosition: { x: 90, y: 5 } },
    );
  } else {
    await alphaMove.tap();
    const position = page.getByRole("dialog", {
      name: "Eintrag verschieben",
      exact: true,
    });
    await position
      .getByRole("button", { name: "An den Anfang", exact: true })
      .tap();
    await expect(position).not.toBeVisible();
  }
  await expect(feed.getByRole("article").first()).toHaveAttribute(
    "aria-label",
    "Feed Alpha",
  );
  await page.getByRole("button", { name: "Tabelle", exact: true }).click();
  await expect(page.locator("tbody .title-cell").first()).toHaveText(
    "Feed Alpha",
  );
  await command({ action: "page.delete", pageId: p.id });
});

test("relative date filters persist zones and update across midnight without reloading", async ({
  page,
}, testInfo) => {
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
  const p = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Relative dates ${testInfo.project.name}`,
    kind: "database",
  });
  const read = async () =>
    (await page.request.get(`/api/pages/${p.id}`)).json();
  const initial = await read();
  await command({
    action: "database.update",
    pageId: p.id,
    version: initial.database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "date", name: "Termin", type: "date" },
    ],
    views: [
      { id: "table", type: "table", name: "Tabelle", filters: [], sorts: [] },
    ],
  });
  for (const cells of [
    { title: "Samstag", date: "2026-03-28" },
    { title: "Sonntag", date: "2026-03-29" },
    { title: "Montag", date: "2026-03-30" },
    { title: "Ohne Datum" },
  ])
    await command({ action: "row.create", pageId: p.id, cells });
  await page.goto(`/#page=${p.id}`);
  await expect(page.locator("tbody .title-cell")).toHaveCount(4);
  // Change only the hydrated browser's clock; server rendering uses the host clock.
  await page.clock.install({ time: new Date("2026-03-28T22:59:00Z") });
  await page.clock.pauseAt(new Date("2026-03-28T22:59:01Z"));
  await page.addStyleTag({
    content:
      "*, *::before, *::after { animation: none !important; transition: none !important; }",
  });
  await page.getByRole("button", { name: /^Filtern/ }).click();
  const dialog = page.getByRole("dialog", {
    name: "Filter bearbeiten",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "Bedingung hinzufügen", exact: true })
    .click();
  await dialog
    .getByLabel("Filter-Eigenschaft", { exact: true })
    .selectOption("date");
  await dialog
    .getByLabel("Filterbedingung", { exact: true })
    .selectOption("in_relative");
  await dialog
    .getByLabel("Filter-Zeitzone", { exact: true })
    .selectOption("Europe/Berlin");
  await expect(
    dialog.getByLabel("Relativer Zeitraum", { exact: true }),
  ).toHaveValue("today");
  await expect(dialog.getByRole("status")).toContainText("1 von 4 Einträgen");
  await expect(dialog.getByText(/28.03.2026 – 28.03.2026/)).toBeVisible();
  await page.screenshot({
    path: `test-results/${testInfo.project.name}-relative-filter.png`,
    fullPage: true,
    animations: "disabled",
  });
  expect(await dialog.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
    false,
  );
  await dialog.getByRole("button", { name: "Anwenden", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator("tbody .title-cell")).toHaveText(["Samstag"]);
  // The local clock crosses midnight in Berlin while data and filter settings stay unchanged.
  const stored = (await read()).database.views[0].filterGroup;
  await page.clock.runFor(60_000);
  await expect(page.locator("tbody .title-cell")).toHaveText(["Sonntag"]);
  expect((await read()).database.views[0].filterGroup).toEqual(stored);
  await page.getByRole("button", { name: /^Filtern/ }).click();
  await expect(dialog.getByText(/29.03.2026 – 29.03.2026/)).toBeVisible();
  await dialog
    .getByLabel("Filter-Zeitzone", { exact: true })
    .selectOption("UTC");
  await dialog.getByRole("button", { name: "Anwenden", exact: true }).click();
  await expect(page.locator("tbody .title-cell")).toHaveText(["Samstag"]);
  await page.getByRole("button", { name: /^Filtern/ }).click();
  await dialog
    .getByLabel("Filter-Zeitzone", { exact: true })
    .selectOption("Europe/Berlin");
  await dialog
    .getByLabel("Relativer Zeitraum", { exact: true })
    .selectOption("past_days");
  await dialog.getByLabel("Anzahl Tage", { exact: true }).fill("0");
  await expect(
    dialog.getByRole("button", { name: "Anwenden", exact: true }),
  ).toBeDisabled();
  await dialog.getByLabel("Anzahl Tage", { exact: true }).fill("2");
  await expect(dialog.getByRole("status")).toContainText("2 von 4 Einträgen");
  await dialog.getByRole("button", { name: "Anwenden", exact: true }).click();
  await expect(page.locator("tbody .title-cell")).toHaveText([
    "Samstag",
    "Sonntag",
  ]);
  await page.reload();
  await page.addStyleTag({
    content:
      "*, *::before, *::after { animation: none !important; transition: none !important; }",
  });
  await expect(page.locator("tbody .title-cell")).toHaveText([
    "Samstag",
    "Sonntag",
  ]);
  await page.getByRole("button", { name: /^Filtern/ }).click();
  await expect(
    dialog.getByLabel("Filter-Zeitzone", { exact: true }),
  ).toHaveValue("Europe/Berlin");
  await expect(dialog.getByLabel("Anzahl Tage", { exact: true })).toHaveValue(
    "2",
  );
  await dialog
    .getByLabel("Filterbedingung", { exact: true })
    .selectOption("not_in_relative");
  await dialog.getByRole("button", { name: "Anwenden", exact: true }).click();
  await expect(page.locator("tbody .title-cell")).toHaveText(["Montag"]);
  await command({ action: "page.delete", pageId: p.id });
});

test("grouped tables and lists collapse independently, select visible rows and move entries between groups", async ({
  page,
}, testInfo) => {
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
  const p = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Grouped views ${testInfo.project.name}`,
    kind: "database",
  });
  const read = async () =>
    (await page.request.get(`/api/pages/${p.id}`)).json();
  const initial = await read();
  await command({
    action: "database.update",
    pageId: p.id,
    version: initial.database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      {
        id: "status",
        name: "Status",
        type: "select",
        options: ["Open", "Done", "Empty"],
      },
      {
        id: "tags",
        name: "Tags",
        type: "multiselect",
        options: ["A", "B", "C"],
      },
      { id: "amount", name: "Aufwand", type: "number" },
    ],
    views: [
      { id: "table", name: "Tabelle", type: "table", filters: [], sorts: [] },
      {
        id: "list",
        name: "Liste",
        type: "list",
        filters: [],
        sorts: [],
        groupBy: "tags",
      },
    ],
  });
  const ids: string[] = [];
  for (const cells of [
    { title: "Alpha", status: "Open", tags: ["A", "B"], amount: 1 },
    { title: "Beta", status: "Open", tags: ["A"], amount: 2 },
    { title: "Gamma", status: "Done", tags: ["B"], amount: 4 },
    { title: "Delta", amount: 0 },
  ])
    ids.push((await command({ action: "row.create", pageId: p.id, cells })).id);
  await page.goto(`/#page=${p.id}`);
  await page.getByTitle("Ansicht und Eigenschaften", { exact: true }).click();
  const settings = page.getByRole("dialog", {
    name: "Ansicht konfigurieren",
    exact: true,
  });
  await settings
    .getByLabel("Gruppieren nach", { exact: true })
    .selectOption("status");
  await expect
    .poll(async () => (await read()).database.views[0].groupBy)
    .toBe("status");
  await settings
    .getByRole("button", { name: "Schließen", exact: true })
    .click();
  const open = page.getByRole("rowgroup", { name: "Gruppe Open", exact: true }),
    done = page.getByRole("rowgroup", { name: "Gruppe Done", exact: true });
  await expect(open.locator(".title-cell")).toHaveText(["Alpha", "Beta"]);
  await expect(open.locator(".group-summary")).toHaveText("Aufwand: Σ 3");
  await expect(
    page.getByRole("rowgroup", { name: "Gruppe Empty", exact: true }),
  ).toHaveCount(0);
  await open
    .getByRole("button", { name: "Gruppe Open einklappen", exact: true })
    .click();
  await expect(open.locator(".title-cell")).toHaveCount(0);
  await page
    .getByRole("checkbox", {
      name: "Alle sichtbaren Einträge auswählen",
      exact: true,
    })
    .check();
  await expect(
    page.getByRole("toolbar", { name: "Ausgewählte Einträge", exact: true }),
  ).toContainText("2 ausgewählt");
  await page
    .getByRole("button", { name: "Auswahl aufheben", exact: true })
    .click();
  await page.reload();
  await expect(
    open.getByRole("button", { name: "Gruppe Open ausklappen", exact: true }),
  ).toHaveAttribute("aria-expanded", "false");
  await page.getByTitle("Ansicht und Eigenschaften", { exact: true }).click();
  await settings
    .getByRole("checkbox", { name: "Leere Gruppen ausblenden", exact: true })
    .click();
  await expect
    .poll(async () => (await read()).database.views[0].groupSettings.hideEmpty)
    .toBe(false);
  await settings
    .getByLabel("Gruppen sortieren", { exact: true })
    .selectOption("asc");
  await expect
    .poll(async () => (await read()).database.views[0].groupSettings.sort)
    .toBe("asc");
  await settings
    .getByRole("button", { name: "Schließen", exact: true })
    .click();
  await expect(page.locator(".data-table tbody")).toHaveCount(4);
  await expect
    .poll(() =>
      page
        .locator(".data-table tbody")
        .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("aria-label"))),
    )
    .toEqual([
      "Gruppe Done",
      "Gruppe Empty",
      "Gruppe Ohne Gruppe",
      "Gruppe Open",
    ]);
  await page.getByTitle("Eintrag in Empty hinzufügen", { exact: true }).click();
  const entry = page.getByRole("dialog", { name: "Eintrag", exact: true });
  await expect(entry).toBeVisible();
  await entry.getByRole("button", { name: "Schließen", exact: true }).click();
  await expect(
    page
      .getByRole("rowgroup", { name: "Gruppe Empty", exact: true })
      .locator(".title-cell"),
  ).toHaveText("Neue Aufgabe");
  await open
    .getByRole("button", { name: "Gruppe Open ausklappen", exact: true })
    .click();
  await done
    .getByRole("button", { name: "Gruppe Done einklappen", exact: true })
    .click();
  await expect(done.locator(".title-cell")).toHaveCount(0);
  await expect(
    done.getByRole("button", { name: "Gruppe Done ausklappen", exact: true }),
  ).toBeEnabled();
  if (testInfo.project.name === "desktop") {
    await open
      .getByRole("button", { name: "Eintrag verschieben: Alpha", exact: true })
      .dragTo(done.locator(".database-group-header"));
  } else {
    await open.locator(".title-cell").filter({ hasText: "Alpha" }).tap();
    await entry
      .getByRole("combobox", { name: "Status", exact: true })
      .selectOption("Done");
    await expect
      .poll(
        async () =>
          (await read()).rows.find((r: { id: string }) => r.id === ids[0]).cells
            .status,
      )
      .toBe("Done");
    await entry.getByRole("button", { name: "Schließen", exact: true }).click();
  }
  await expect
    .poll(
      async () =>
        (await read()).rows.find((r: { id: string }) => r.id === ids[0]).cells
          .status,
    )
    .toBe("Done");
  await expect(open.locator(".title-cell")).toHaveText(["Beta"]);
  await done
    .getByRole("button", { name: "Gruppe Done ausklappen", exact: true })
    .click();
  await expect(done.locator(".title-cell")).toHaveCount(2);
  await page.screenshot({
    path: `test-results/${testInfo.project.name}-grouped-table.png`,
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Liste", exact: true }).click();
  const a = page.getByRole("region", { name: "Gruppe A", exact: true }),
    b = page.getByRole("region", { name: "Gruppe B", exact: true });
  await expect(a.locator(".record-list-item")).toHaveCount(2);
  await expect(b.locator(".record-list-item")).toHaveCount(2);
  await a
    .getByRole("button", { name: "Gruppe A einklappen", exact: true })
    .click();
  await expect(a.locator(".record-list-item")).toHaveCount(0);
  await page.getByLabel("Datenbank durchsuchen", { exact: true }).fill("Alpha");
  await expect(page.locator(".record-list-item")).toHaveCount(1);
  await expect(page.locator(".group-view-toolbar")).toContainText(
    "2 Gruppen · 1 Einträge",
  );
  await page.getByLabel("Datenbank durchsuchen", { exact: true }).fill("");
  await page
    .getByRole("button", { name: "Alle ausklappen", exact: true })
    .click();
  await expect(a.locator(".record-list-item")).toHaveCount(2);
  await page.screenshot({
    path: `test-results/${testInfo.project.name}-grouped-list.png`,
    fullPage: true,
    animations: "disabled",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  // Read-only UI may collapse locally without submitting a schema mutation.
  const persisted = (await read()).database.views[0].groupSettings;
  await page.route(`**/api/pages/${p.id}`, async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ response, json: { ...data, role: "viewer" } });
  });
  await page.reload();
  await expect(
    open.getByRole("button", { name: "Gruppe Open einklappen", exact: true }),
  ).toBeVisible();
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/command"))
      mutations.push(request.postData() || "");
  });
  await open
    .getByRole("button", { name: "Gruppe Open einklappen", exact: true })
    .click();
  await expect(open.locator(".title-cell")).toHaveCount(0);
  expect((await read()).database.views[0].groupSettings).toEqual(persisted);
  expect(mutations).toEqual([]);
  await page.unroute(`**/api/pages/${p.id}`);
  await command({ action: "page.delete", pageId: p.id });
});

test("inline math edits in sentences, validates, supports undo and renders on shared pages", async ({
  page,
  browser,
}, testInfo) => {
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
  const p = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Math editor ${testInfo.project.name}`,
  });
  const read = async () =>
    (await page.request.get(`/api/pages/${p.id}`)).json();
  await page.goto(`/#page=${p.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await editor.fill("Vor nach.");
  for (let n = 0; n < 5; n++) await editor.press("ArrowLeft");
  await page.getByTitle("Inline-Formel", { exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Inline-Formel",
    exact: true,
  });
  await dialog
    .getByLabel("LaTeX-Formel", { exact: true })
    .fill(String.raw`\frac{a}{b}`);
  await expect(
    dialog.getByLabel("Formelvorschau").locator(".katex"),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Einfügen", exact: true }).click();
  const formula = editor.locator(".math-inline");
  await expect(formula).toHaveAttribute("data-math", String.raw`\frac{a}{b}`);
  await expect(formula.locator(".katex-display")).toHaveCount(0);
  await expect
    .poll(async () => (await read()).html)
    .toMatch(
      /<p>Vor <span data-math="\\frac\{a\}\{b\}" class="math-inline">.*<\/span>nach\.<\/p>/,
    );
  await page.reload();
  await expect(formula).toHaveAttribute("data-math", String.raw`\frac{a}{b}`);
  await formula.focus();
  await formula.press("Enter");
  await dialog
    .getByLabel("LaTeX-Formel", { exact: true })
    .fill(String.raw`\frac{`);
  await expect(
    dialog.getByRole("button", { name: "Speichern", exact: true }),
  ).toBeDisabled();
  await expect(dialog.getByRole("status")).toBeVisible();
  await dialog.getByLabel("LaTeX-Formel", { exact: true }).fill("x^2 + y^2");
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(formula).toHaveAttribute("data-math", "x^2 + y^2");
  await page.getByTitle("Rückgängig", { exact: true }).click();
  await expect(formula).toHaveAttribute("data-math", String.raw`\frac{a}{b}`);
  await page.getByTitle("Wiederholen", { exact: true }).click();
  await expect(formula).toHaveAttribute("data-math", "x^2 + y^2");
  await formula.click();
  await dialog.getByLabel("LaTeX-Formel", { exact: true }).fill("discarded");
  await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await expect(formula).toHaveAttribute("data-math", "x^2 + y^2");
  // The dialog restores editor focus asynchronously; await that before moving the caret.
  await expect(dialog).toBeHidden();
  await expect(editor).toBeFocused();
  await editor.press("ControlOrMeta+Home");
  await expect
    .poll(() =>
      editor.evaluate((el) => {
        const instance = (el as HTMLElement & { editor: any }).editor;
        return (
          instance.state.selection.empty && instance.state.selection.from === 1
        );
      }),
    )
    .toBe(true);
  await editor.press("ControlOrMeta+End");
  await expect
    .poll(() =>
      editor.evaluate((el) => {
        const instance = (el as HTMLElement & { editor: any }).editor;
        return (
          instance.state.selection.empty &&
          instance.state.selection.from === instance.state.doc.content.size - 1
        );
      }),
    )
    .toBe(true);
  await page.getByTitle("Block hinzufügen", { exact: true }).click();
  await page
    .getByRole("dialog", { name: "Block hinzufügen", exact: true })
    .getByRole("button", {
      name: "Formel Mathematischer Ausdruck",
      exact: true,
    })
    .click();
  const blockDialog = page.getByRole("dialog", {
    name: "Mathematische Formel",
    exact: true,
  });
  await blockDialog
    .getByLabel("LaTeX-Formel", { exact: true })
    .fill(String.raw`\sum_{i=1}^{n} i`);
  await blockDialog
    .getByRole("button", { name: "Einfügen", exact: true })
    .click();
  await expect(editor.locator(".math-block .katex-display")).toBeVisible();
  await expect(formula).toHaveAttribute("data-math", "x^2 + y^2");
  await editor.locator(".math-block").click();
  await blockDialog
    .getByLabel("LaTeX-Formel", { exact: true })
    .fill("E = mc^2");
  await blockDialog
    .getByRole("button", { name: "Speichern", exact: true })
    .click();
  await expect
    .poll(async () => (await read()).html)
    .toContain('data-math="E = mc^2"');
  await page.screenshot({
    path: `test-results/${testInfo.project.name}-inline-math.png`,
    fullPage: true,
    animations: "disabled",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  const link = await command({
    action: "share.create",
    pageId: p.id,
    name: "Math editor",
    role: "editor",
  });
  await page.goto("/#home");
  const context = await browser.newContext({
    viewport: page.viewportSize()!,
    isMobile: testInfo.project.name === "mobile",
  });
  const guest = await context.newPage();
  try {
    await guest.goto(`${origin}/share/${link.token}`);
    await expect(guest.locator(".math-inline .katex")).toBeVisible();
    await expect(guest.locator(".math-block .katex-display")).toBeVisible();
    await guest
      .getByRole("button", { name: "Inhalt bearbeiten", exact: true })
      .click();
    const guestEditor = guest.getByLabel("Geteilten Inhalt bearbeiten", {
      exact: true,
    });
    await guestEditor.locator(".math-inline").click();
    const guestDialog = guest.getByRole("dialog", {
      name: "Inline-Formel",
      exact: true,
    });
    await guestDialog.getByLabel("LaTeX-Formel", { exact: true }).fill("z^3");
    await guestDialog
      .getByRole("button", { name: "Speichern", exact: true })
      .click();
    await guest
      .getByRole("button", { name: "Änderungen speichern", exact: true })
      .click();
    await expect(
      guest.getByText("Änderungen gespeichert", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(async () => (await read()).html)
      .toContain('data-math="z^3"');
    await expect(guest.locator(".math-inline")).toHaveAttribute(
      "data-math",
      "z^3",
    );
  } finally {
    await context.close();
  }
  await page.goto(`/#page=${p.id}`);
  await formula.click();
  await dialog
    .getByRole("button", { name: "Formel löschen", exact: true })
    .click();
  await expect(formula).toHaveCount(0);
  await expect(editor.locator(".math-block")).toHaveAttribute(
    "data-math",
    "E = mc^2",
  );
  await expect
    .poll(async () => (await read()).html)
    .not.toContain("math-inline");
  await page.goto("/#home");
  await command({ action: "page.delete", pageId: p.id });
});

test("math drafts follow moved nodes and reject concurrent expression changes without losing the draft", async ({
  page,
  browser,
}, testInfo) => {
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
  const p = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Math collaboration ${testInfo.project.name}`,
  });
  const read = async () =>
    (await page.request.get(`/api/pages/${p.id}`)).json();
  const { htmlState } = await import("../../lib/document-server");
  await command({
    action: "document.sync",
    pageId: p.id,
    generation: (await read()).generation,
    update: Buffer.from(
      htmlState(
        '<p>Start <span data-math="x^2" class="math-inline">x^2</span> Ende.</p>',
      ),
    ).toString("base64"),
  });
  await page.goto(`/#page=${p.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  const formula = editor.locator(".math-inline");
  await expect(formula).toHaveAttribute("data-math", "x^2");
  const context = await browser.newContext({
    viewport: page.viewportSize()!,
    isMobile: testInfo.project.name === "mobile",
  });
  const other = await context.newPage();
  try {
    await other.request.post(`${origin}/api/auth/demo`, {
      headers: { origin },
    });
    await other.goto(`${origin}/#page=${p.id}`);
    const otherEditor = other.getByLabel("Dokumentinhalt", { exact: true });
    const otherFormula = otherEditor.locator(".math-inline");
    await expect(otherFormula).toBeVisible();
    await formula.click();
    const dialog = page.getByRole("dialog", {
      name: "Inline-Formel",
      exact: true,
    });
    await dialog.getByLabel("LaTeX-Formel", { exact: true }).fill("local_1");
    await otherEditor.click();
    await otherEditor.press("ControlOrMeta+Home");
    await other.keyboard.insertText("Prefix ");
    await expect.poll(async () => (await read()).html).toContain("Prefix");
    await expect(editor).toContainText("Prefix");
    await dialog
      .getByRole("button", { name: "Speichern", exact: true })
      .click();
    await expect(formula).toHaveAttribute("data-math", "local_1");
    await expect(otherFormula).toHaveAttribute("data-math", "local_1", {
      timeout: 10000,
    });
    await formula.click();
    await dialog.getByLabel("LaTeX-Formel", { exact: true }).fill("local_2");
    await otherFormula.click();
    const otherDialog = other.getByRole("dialog", {
      name: "Inline-Formel",
      exact: true,
    });
    await otherDialog
      .getByLabel("LaTeX-Formel", { exact: true })
      .fill("remote_2");
    await otherDialog
      .getByRole("button", { name: "Speichern", exact: true })
      .click();
    await expect(formula).toHaveAttribute("data-math", "remote_2", {
      timeout: 10000,
    });
    await dialog
      .getByRole("button", { name: "Speichern", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toContainText(
      "inzwischen geändert oder gelöscht",
    );
    await expect(
      dialog.getByLabel("LaTeX-Formel", { exact: true }),
    ).toHaveValue("local_2");
    await dialog
      .getByRole("button", { name: "Abbrechen", exact: true })
      .click();
    await formula.click();
    await otherFormula.click();
    await otherDialog
      .getByRole("button", { name: "Formel löschen", exact: true })
      .click();
    await expect(formula).toHaveCount(0, { timeout: 10000 });
    await dialog
      .getByRole("button", { name: "Speichern", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toContainText(
      "inzwischen geändert oder gelöscht",
    );
    await dialog
      .getByRole("button", { name: "Abbrechen", exact: true })
      .click();
    await expect
      .poll(async () => (await read()).html)
      .not.toContain("math-inline");
  } finally {
    await context.close();
  }
  await page.goto("/#home");
  await command({ action: "page.delete", pageId: p.id });
});

async function coverTestImage(page: import("@playwright/test").Page) {
  const image = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 960;
    canvas.height = 640;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#b6cfdb";
    ctx.fillRect(0, 0, 960, 210);
    ctx.fillStyle = "#31576d";
    ctx.fillRect(0, 210, 960, 230);
    ctx.fillStyle = "#d7c8ac";
    ctx.fillRect(0, 440, 960, 200);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  return Buffer.from(image, "base64");
}

test("page covers upload, position, publish, reject stale drafts and revoke unused images", async ({
  page,
  browser,
}, testInfo) => {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", {
      headers: { origin },
      data,
    });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  const p = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Cover upload ${testInfo.project.name}`,
  });
  const read = async () =>
    (await page.request.get(`/api/pages/${p.id}`)).json();
  await page.goto(`/#page=${p.id}`);
  const png = await coverTestImage(page);
  await page
    .getByRole("button", { name: "Cover hinzufügen", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Cover auswählen",
    exact: true,
  });
  await dialog
    .getByLabel("Coverbild hochladen", { exact: true })
    .setInputFiles({
      name: "Landscape.png",
      mimeType: "image/png",
      buffer: png,
    });
  await expect(dialog.getByAltText("Cover-Vorschau")).toBeVisible();
  const image = await dialog.getByAltText("Cover-Vorschau").getAttribute("src");
  const position = dialog.getByRole("slider", {
    name: "Vertikale Coverposition",
    exact: true,
  });
  await position.press("Home");
  for (let n = 0; n < 25; n++) await position.press("ArrowRight");
  await expect(position).toHaveValue("25");
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page.getByAltText("Seiten-Cover")).toHaveCSS(
    "object-position",
    "50% 25%",
  );
  await expect.poll(async () => (await read()).page.cover).toBe(image);
  await page.reload();
  await expect(page.getByAltText("Seiten-Cover")).toHaveCSS(
    "object-position",
    "50% 25%",
  );
  const link = await command({
    action: "share.create",
    pageId: p.id,
    name: "Cover link",
    role: "viewer",
  });
  const context = await browser.newContext({
    viewport: page.viewportSize()!,
    isMobile: testInfo.project.name === "mobile",
  });
  const guest = await context.newPage();
  try {
    await guest.goto(`${origin}/share/${link.token}`);
    const publicUrl = `${origin}/api/share/${link.token}/files/${image!.split("/").at(-1)}`;
    await expect(guest.getByAltText("Seiten-Cover")).toHaveCSS(
      "object-position",
      "50% 25%",
    );
    await expect
      .poll(() =>
        guest
          .getByAltText("Seiten-Cover")
          .evaluate((img: HTMLImageElement) => img.naturalWidth),
      )
      .toBe(960);
    expect((await guest.request.get(publicUrl)).status()).toBe(200);
    await page.screenshot({
      path: `test-results/${testInfo.project.name}-page-cover.png`,
      fullPage: true,
      animations: "disabled",
    });
    await page
      .getByRole("button", { name: "Cover ändern", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Cover #dce7f5", exact: true })
      .click();
    await command({
      action: "page.update",
      pageId: p.id,
      patch: { cover: "#263b55" },
    });
    await dialog
      .getByRole("button", { name: "Speichern", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toContainText(
      "inzwischen geändert",
    );
    await expect(
      dialog.getByRole("button", { name: "Cover #dce7f5", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    expect((await guest.request.get(publicUrl)).status()).toBe(404);
    await dialog
      .getByRole("button", { name: "Abbrechen", exact: true })
      .click();
    await page.reload();
    await page
      .getByRole("button", { name: "Cover ändern", exact: true })
      .click();
    await dialog
      .getByLabel("Vorhandenes Bild", { exact: true })
      .selectOption(image!);
    await dialog
      .getByRole("button", { name: "Speichern", exact: true })
      .click();
    await expect(page.getByAltText("Seiten-Cover")).toBeVisible();
    expect((await guest.request.get(publicUrl)).status()).toBe(200);
    await page
      .getByRole("button", { name: "Cover ändern", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Cover entfernen", exact: true })
      .click();
    await expect(page.getByAltText("Seiten-Cover")).toHaveCount(0);
    expect((await guest.request.get(publicUrl)).status()).toBe(404);
    const bad = await page.request.post("/api/upload", {
      headers: { origin },
      multipart: {
        pageId: p.id,
        purpose: "cover",
        file: {
          name: "not-image.svg",
          mimeType: "image/svg+xml",
          buffer: Buffer.from("<svg/>"),
        },
      },
    });
    expect(bad.status()).toBe(400);
  } finally {
    await context.close();
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await command({ action: "page.delete", pageId: p.id });
});

test("gallery covers use document or file properties with independent size and fit settings", async ({
  page,
}, testInfo) => {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", {
      headers: { origin },
      data,
    });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  const p = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Gallery images ${testInfo.project.name}`,
    kind: "database",
  });
  await page.goto(`/#page=${p.id}`);
  const png = await coverTestImage(page),
    read = async () => (await page.request.get(`/api/pages/${p.id}`)).json();
  const upload = async (name: string) => {
    const r = await page.request.post("/api/upload", {
      headers: { origin },
      multipart: {
        pageId: p.id,
        file: { name, mimeType: "image/png", buffer: png },
      },
    });
    expect(r.ok()).toBe(true);
    return (await r.json()).url as string;
  };
  const a = await upload("Document.png"),
    b = await upload("Property.png"),
    initial = await read();
  await command({
    action: "database.update",
    pageId: p.id,
    version: initial.database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "photo", name: "Bild", type: "files" },
    ],
    views: [
      {
        id: "gallery",
        name: "Galerie",
        type: "gallery",
        filters: [],
        sorts: [],
      },
      {
        id: "second",
        name: "Ohne Bilder",
        type: "gallery",
        filters: [],
        sorts: [],
        gallery: { cover: "none", fit: "cover", size: "small" },
      },
    ],
  });
  const row = await command({
    action: "row.create",
    pageId: p.id,
    cells: { title: "Landscape", photo: b },
  });
  await command({
    action: "row.create",
    pageId: p.id,
    cells: { title: "Empty" },
  });
  const { htmlState } = await import("../../lib/document-server");
  const r = await (
    await page.request.get(`/api/pages/${p.id}/rows/${row.id}`)
  ).json();
  await command({
    action: "row.document.sync",
    pageId: p.id,
    rowId: row.id,
    generation: r.generation,
    update: Buffer.from(
      htmlState(`<p><img src="${a}" alt="Landscape"></p>`),
    ).toString("base64"),
  });
  await page.reload();
  const card = page
    .locator(".record-card-wrap")
    .filter({ has: page.getByText("Landscape", { exact: true }) });
  await expect(card.locator(".gallery-cover img")).toHaveAttribute("src", a);
  await expect(
    page.locator(".gallery-cover").filter({ hasText: "Kein Bild" }),
  ).toHaveCount(1);
  await page.getByTitle("Ansicht und Eigenschaften", { exact: true }).click();
  const settings = page.getByRole("dialog", {
    name: "Ansicht konfigurieren",
    exact: true,
  });
  await settings
    .getByLabel("Galerie-Bildquelle", { exact: true })
    .selectOption("field:photo");
  await expect
    .poll(async () => (await read()).database.views[0].gallery.fieldId)
    .toBe("photo");
  await settings
    .getByLabel("Galerie-Bilddarstellung", { exact: true })
    .selectOption("contain");
  await expect
    .poll(async () => (await read()).database.views[0].gallery.fit)
    .toBe("contain");
  await settings
    .getByLabel("Galerie-Kartengröße", { exact: true })
    .selectOption("large");
  await settings
    .getByRole("button", { name: "Schließen", exact: true })
    .click();
  await expect(card.locator(".gallery-cover img")).toHaveAttribute("src", b);
  await expect(card.locator(".gallery-cover img")).toHaveCSS(
    "object-fit",
    "contain",
  );
  await expect(page.locator(".gallery")).toHaveClass(/gallery-size-large/);
  await page.screenshot({
    path: `test-results/${testInfo.project.name}-gallery-covers.png`,
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Ohne Bilder", exact: true }).click();
  await expect(page.locator(".gallery-cover")).toHaveCount(0);
  await page.getByRole("button", { name: "Galerie", exact: true }).click();
  await page.reload();
  await expect(card.locator(".gallery-cover img")).toHaveAttribute("src", b);
  await card.getByRole("button").first().click();
  await expect(
    page.getByRole("dialog", { name: "Eintrag", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("dialog", { name: "Eintrag", exact: true })
    .getByRole("button", { name: "Schließen", exact: true })
    .click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await command({ action: "page.delete", pageId: p.id });
});
