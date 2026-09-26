import { test, expect, type Page } from "@playwright/test";
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
  const read = async () =>
    (await page.request.get(`/api/pages/${host.id}`)).json();
  const seed = async (html: string) => {
    const { htmlState } = await import("../../lib/document-server");
    await command({
      action: "document.sync",
      pageId: host.id,
      generation: (await read()).generation,
      update: Buffer.from(htmlState(html)).toString("base64"),
    });
  };
  return { host, origin, command, read, seed };
}
async function clearSelection(dialog: import("@playwright/test").Locator) {
  for (const checkbox of await dialog
    .getByRole("checkbox", { checked: true })
    .all())
    await checkbox.uncheck();
}
async function dragBlock(
  page: Page,
  from: import("@playwright/test").Locator,
  to: import("@playwright/test").Locator,
  mobile: boolean,
) {
  const start = (await from.boundingBox())!,
    end = (await to.boundingBox())!;
  const a = {
      x: start.x + start.width / 2,
      y: start.y + Math.min(start.height / 2, 12),
    },
    b = { x: end.x + Math.min(end.width / 2, 80), y: end.y + end.height - 2 };
  if (mobile) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ ...a, id: 1 }],
    });
    for (let i = 1; i <= 6; i++)
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          {
            x: a.x + ((b.x - a.x) * i) / 6,
            y: a.y + ((b.y - a.y) * i) / 6,
            id: 1,
          },
        ],
      });
    await expect(page.locator(".document-block-drop")).toBeVisible();
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await cdp.detach();
  } else {
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 8 });
    await expect(page.locator(".document-block-drop")).toBeVisible();
    await page.mouse.up();
  }
  // The moved block's handle must not stay highlighted after the drop.
  await expect(page.locator(".document-block-handle.selected")).toHaveCount(0);
}
test("block handles drag with mouse or touch, bulk actions preserve content and mobile placement enters containers", async ({
  page,
}, info) => {
  const f = await fixture(
    page,
    `Blocks editor ${info.project.name} ${Date.now()}`,
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await f.seed(
    '<p>Alpha</p><p>Bravo</p><p>Charlie</p><aside data-callout="true"><p>Inside one</p><p>Inside two</p></aside><pre data-code-wrap="true"><code class="language-javascript">const value = 42;</code></pre>',
  );
  await page.goto(`/#page=${f.host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(
    editor.locator(":scope > p").filter({ hasText: /\S/ }),
  ).toHaveText(["Alpha", "Bravo", "Charlie"]);
  await dragBlock(
    page,
    page.getByRole("button", {
      name: "Blockaktionen: Absatz · Alpha",
      exact: true,
    }),
    editor.locator(":scope > p").filter({ hasText: /\S/ }).nth(2),
    info.project.name === "mobile",
  );
  await expect(
    editor.locator(":scope > p").filter({ hasText: /\S/ }),
  ).toHaveText(["Bravo", "Charlie", "Alpha"]);
  await page
    .getByRole("button", { name: "Blöcke verwalten", exact: false })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Blöcke verwalten",
    exact: true,
  });
  await clearSelection(dialog);
  await dialog
    .getByRole("checkbox", { name: "Absatz · Bravo", exact: true })
    .check();
  await dialog
    .getByRole("checkbox", { name: "Absatz · Charlie", exact: true })
    .check();
  await dialog
    .getByRole("button", { name: "Duplizieren", exact: true })
    .click();
  await expect(
    editor.locator(":scope > p").filter({ hasText: /\S/ }),
  ).toHaveText(["Bravo", "Charlie", "Bravo", "Charlie", "Alpha"]);
  await dialog.getByRole("button", { name: "Löschen", exact: true }).click();
  await expect(
    editor.locator(":scope > p").filter({ hasText: /\S/ }),
  ).toHaveText(["Bravo", "Charlie", "Alpha"]);
  await dialog.getByRole("button", { name: "Fertig", exact: true }).click();
  await page.getByTitle("Rückgängig", { exact: true }).click();
  await expect(
    editor.locator(":scope > p").filter({ hasText: /\S/ }),
  ).toHaveText(["Bravo", "Charlie", "Bravo", "Charlie", "Alpha"]);
  await page.getByTitle("Wiederholen", { exact: true }).click();
  await expect(
    editor.locator(":scope > p").filter({ hasText: /\S/ }),
  ).toHaveText(["Bravo", "Charlie", "Alpha"]);
  await page
    .getByRole("button", { name: "Blockaktionen: Absatz · Alpha", exact: true })
    .click();
  await dialog
    .getByLabel("Block-Zielposition")
    .selectOption({ label: "Vor: Absatz · Inside two" });
  await dialog
    .getByRole("button", { name: "Verschieben", exact: true })
    .click();
  await expect(editor.locator("aside > p")).toHaveText([
    "Inside one",
    "Alpha",
    "Inside two",
  ]);
  await dialog.getByRole("button", { name: "Fertig", exact: true }).click();
  const alpha = editor.locator("aside > p").nth(1);
  await alpha.click();
  await page.keyboard.press("ControlOrMeta+Shift+ArrowUp");
  await expect(editor.locator("aside > p")).toHaveText([
    "Alpha",
    "Inside one",
    "Inside two",
  ]);
  await expect
    .poll(async () => (await f.read()).html)
    .toContain("<p>Alpha</p><p>Inside one</p>");
  expect((await f.read()).html).not.toMatch(
    /document-block-handle|Blockaktionen/,
  );
  await page.reload();
  await expect(editor.locator("aside > p")).toHaveText([
    "Alpha",
    "Inside one",
    "Inside two",
  ]);
  await expect(editor.locator("pre code")).toHaveText("const value = 42;");
  await expect(editor.locator("pre")).toHaveAttribute("data-code-wrap", "true");
  await page.screenshot({
    path: `test-results/${info.project.name}-blocks.png`,
    fullPage: true,
    animations: "disabled",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await f.command({
    action: "page.update",
    pageId: f.host.id,
    patch: { locked: true },
  });
  await page.reload();
  await expect(
    page.getByRole("button", { name: /^Blockaktionen:/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Blöcke verwalten", exact: false }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
  await page.goto("/#home");
  await f.command({ action: "page.delete", pageId: f.host.id });
});
test("record and guest editors reorder blocks while guest duplication preserves private embed boundaries", async ({
  page,
  browser,
}, info) => {
  const f = await fixture(
    page,
    `Blocks records ${info.project.name} ${Date.now()}`,
    "database",
  );
  const row = await f.command({
    action: "row.create",
    pageId: f.host.id,
    cells: { title: "Block example" },
  });
  const readRow = async () =>
    (await page.request.get(`/api/pages/${f.host.id}/rows/${row.id}`)).json();
  const { htmlState } = await import("../../lib/document-server");
  const blockId = crypto.randomUUID();
  await f.command({
    action: "row.document.sync",
    pageId: f.host.id,
    rowId: row.id,
    generation: (await readRow()).generation,
    update: Buffer.from(
      htmlState(
        `<p>First</p><p>Second</p><div data-linked-database="${blockId}" data-linked-source="${f.host.id}" data-linked-views="[]" data-linked-version="1">Linked</div>`,
      ),
    ).toString("base64"),
  });
  await page.goto(`/#page=${f.host.id}`);
  await page.getByText("Block example", { exact: true }).dblclick();
  const entry = page.getByRole("dialog", { name: "Eintrag", exact: true });
  await entry
    .getByRole("button", { name: "Blockaktionen: Absatz · First", exact: true })
    .click();
  const manage = page.getByRole("dialog", {
    name: "Blöcke verwalten",
    exact: true,
  });
  await manage.getByRole("button", { name: "Nach unten", exact: true }).click();
  await manage.getByRole("button", { name: "Fertig", exact: true }).click();
  await entry.getByRole("button", { name: "Schließen", exact: true }).click();
  await expect
    .poll(async () => (await readRow()).html)
    .toContain("<p>Second</p><p>First</p>");
  const link = await f.command({
    action: "share.create",
    pageId: f.host.id,
    role: "editor",
    name: "Guest blocks",
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
    await expect(
      guest.getByRole("button", { name: /^Blockaktionen:/ }),
    ).toHaveCount(0);
    await guest
      .getByRole("button", { name: "Inhalt bearbeiten", exact: true })
      .click();
    await guest
      .getByRole("button", {
        name: "Blockaktionen: Absatz · First",
        exact: true,
      })
      .click();
    const menu = guest.getByRole("dialog", {
      name: "Blöcke verwalten",
      exact: true,
    });
    await menu.getByRole("button", { name: "Nach oben", exact: true }).click();
    await menu
      .getByRole("button", { name: "Duplizieren", exact: true })
      .click();
    await clearSelection(menu);
    await menu
      .getByRole("checkbox", { name: "Verknüpfte Datenbank", exact: true })
      .check();
    await expect(
      menu.getByRole("button", { name: "Duplizieren", exact: true }),
    ).toBeDisabled();
    await menu.getByRole("button", { name: "Nach oben", exact: true }).click();
    await menu.getByRole("button", { name: "Fertig", exact: true }).click();
    await guest
      .getByRole("button", { name: "Änderungen speichern", exact: true })
      .click();
    await expect(
      guest.getByText("Änderungen gespeichert", { exact: true }),
    ).toBeVisible();
    expect((await readRow()).html).toContain("<p>First</p><p>First</p>");
    expect((await readRow()).html).toContain(
      `data-linked-source="${f.host.id}"`,
    );
    expect(
      ((await readRow()).html.match(/data-linked-database=/g) || []).length,
    ).toBe(1);
  } finally {
    await visitor.close();
  }
  await page.goto("/#home");
  await f.command({ action: "page.delete", pageId: f.host.id });
});

test("block selections track remote edits and a remote transaction cancels an active drag safely", async ({
  page,
}, info) => {
  const f = await fixture(
    page,
    `Blocks collaboration ${info.project.name} ${Date.now()}`,
  );
  await f.seed("<p>Alpha</p><p>Bravo</p><p>Charlie</p>");
  await page.goto(`/#page=${f.host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  const remoteEdit = async (text: string, prefix: string | null) => {
    const Y = await import("yjs"),
      data = await f.read(),
      doc = new Y.Doc();
    Y.applyUpdate(doc, Buffer.from(data.state, "base64"));
    const paragraph = doc
      .getXmlFragment("default")
      .toArray()
      .find(
        (node) =>
          node instanceof Y.XmlElement &&
          node.nodeName === "paragraph" &&
          node.toString().includes(text),
      ) as import("yjs").XmlElement;
    expect(paragraph).toBeTruthy();
    const content = paragraph.toArray()[0] as import("yjs").XmlText;
    if (prefix === null) {
      const root = doc.getXmlFragment("default");
      root.delete(root.toArray().indexOf(paragraph), 1);
    } else content.insert(0, prefix);
    await f.command({
      action: "document.sync",
      pageId: f.host.id,
      generation: data.generation,
      update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64"),
    });
    doc.destroy();
  };
  await page
    .getByRole("button", { name: "Blockaktionen: Absatz · Bravo", exact: true })
    .click();
  const menu = page.getByRole("dialog", {
    name: "Blöcke verwalten",
    exact: true,
  });
  await remoteEdit("Alpha", "Remote ");
  await expect(editor).toContainText("Remote Alpha", { timeout: 10000 });
  await expect(
    menu.getByRole("checkbox", { name: "Absatz · Bravo", exact: true }),
  ).toBeChecked();
  await remoteEdit("Bravo", "Updated ");
  await expect(
    menu.getByRole("checkbox", { name: "Absatz · Updated Bravo", exact: true }),
  ).toBeChecked({ timeout: 10000 });
  await menu.getByRole("button", { name: "Duplizieren", exact: true }).click();
  await expect(
    editor.locator(":scope > p").filter({ hasText: /\S/ }),
  ).toHaveText(["Remote Alpha", "Updated Bravo", "Updated Bravo", "Charlie"]);
  await menu.getByRole("button", { name: "Fertig", exact: true }).click();
  await expect
    .poll(
      async () => ((await f.read()).html.match(/Updated Bravo/g) || []).length,
    )
    .toBe(2);
  const handle = page.getByRole("button", {
    name: "Blockaktionen: Absatz · Remote Alpha",
    exact: true,
  });
  const a = (await handle.boundingBox())!,
    b = (await editor
      .locator(":scope > p")
      .filter({ hasText: "Charlie" })
      .boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + 10);
  await page.mouse.down();
  await page.mouse.move(b.x + 70, b.y + b.height - 2, { steps: 8 });
  await expect(page.locator(".document-block-drop")).toBeVisible();
  await remoteEdit("Alpha", "Concurrent ");
  await expect(
    page.getByRole("status").filter({ hasText: "Das Dokument wurde geändert" }),
  ).toBeVisible({ timeout: 10000 });
  await page.mouse.up();
  await expect(page.locator(".document-block-drop")).toHaveCount(0);
  await expect(
    editor.locator(":scope > p").filter({ hasText: /\S/ }),
  ).toHaveText([
    "Concurrent Remote Alpha",
    "Updated Bravo",
    "Updated Bravo",
    "Charlie",
  ]);
  await page
    .getByRole("button", {
      name: "Blockaktionen: Absatz · Updated Bravo",
      exact: true,
    })
    .first()
    .click();
  await remoteEdit("Updated Bravo", null);
  await expect(menu.getByRole("checkbox", { checked: true })).toHaveCount(0, {
    timeout: 10000,
  });
  await expect(
    menu.getByRole("button", { name: "Löschen", exact: true }),
  ).toBeDisabled();
  await expect(
    editor.locator(":scope > p").filter({ hasText: /Updated Bravo/ }),
  ).toHaveCount(1);
  await menu.getByRole("button", { name: "Fertig", exact: true }).click();
  await page.goto("/#home");
  await f.command({ action: "page.delete", pageId: f.host.id });
});
