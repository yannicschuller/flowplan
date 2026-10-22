import { test, expect, type Page, type Browser } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// End-to-end encrypted spaces (docs/e2ee-design.md): two people, keys set up
// in the browser, an encrypted space, live editing – and the server's
// database never holds the text.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const MARKER = `E2EE-Marker-${randomBytes(6).toString("hex")}`;

function dataDir() {
  const dir = process.env.FLOWPLAN_DATA_DIR || "";
  if (!/^\/tmp\/flowplan-e2ee-e2e\.[A-Za-z0-9]+$/.test(dir)) throw new Error("The E2EE test requires its isolated data directory.");
  return dir;
}
async function person(browser: Browser, db: DatabaseSync, name: string, workspace: string, role: string) {
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, uid, name, `${uid}@test.invalid`, Date.now());
  db.prepare("INSERT INTO members VALUES(?,?,?)").run(workspace, uid, role);
  db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(
    createHash("sha256").update(token).digest("hex"),
    uid,
    "[]",
    Date.now() + 3600000,
  );
  const context = await browser.newContext({ locale: "de-DE", viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: "flowplan_session", value: token, url: origin }]);
  return { id: uid, page: await context.newPage(), context };
}
async function setUpKeys(page: Page, passphrase: string) {
  const dialog = page.getByRole("dialog", { name: "Verschlüsselung einrichten" });
  await dialog.getByLabel("Passphrase", { exact: true }).fill(passphrase);
  await dialog.getByLabel("Passphrase wiederholen").fill(passphrase);
  await dialog.getByRole("button", { name: "Weiter" }).click();
  await expect(dialog.getByTestId("recovery-key")).toHaveText(/^([A-Z2-7]{4}-){12}[A-Z2-7]{4}$/, { timeout: 20000 });
  await dialog.getByRole("checkbox", { name: /sicher aufbewahrt/ }).check();
  await dialog.getByRole("button", { name: "Einrichtung abschließen" }).click();
  await expect(dialog).toBeHidden();
}

test("two people edit an encrypted page live; the server stores ciphertext only", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "One run covers it.");
  test.setTimeout(120000);
  const dir = dataDir();
  // The server creates its tables on the first request.
  await (await browser.newContext()).request.get(`${origin}/api/bootstrap`);
  const db = new DatabaseSync(join(dir, "flowplan.sqlite"));
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  const workspace = randomUUID();
  db.prepare("INSERT INTO workspaces(id,name) VALUES(?,?)").run(workspace, "Verschlüsselt");
  const alice = await person(browser, db, "Alice Tresor", workspace, "owner");
  const bob = await person(browser, db, "Bob Tresor", workspace, "editor");
  db.prepare("UPDATE workspaces SET created_by=? WHERE id=?").run(alice.id, workspace);
  db.prepare("INSERT INTO spaces(id,workspace_id,name,visibility,owner_id) VALUES(?,?,?,?,?)").run(randomUUID(), workspace, "Allgemein", "team", alice.id);
  const errors: string[] = [];
  for (const p of [alice.page, bob.page]) p.on("pageerror", (e) => errors.push(e.message));

  // Bob sets up his keys in the settings.
  await bob.page.goto(`${origin}/#settings/account`);
  await bob.page.getByRole("button", { name: "Verschlüsselung einrichten" }).click();
  await setUpKeys(bob.page, "bob sein langer satz");

  // Alice creates an encrypted space; the key setup comes first.
  await alice.page.goto(`${origin}/`);
  await alice.page.locator(".add-space").click();
  const create = alice.page.getByRole("dialog", { name: "Bereich hinzufügen" });
  await create.getByLabel("Name").fill("Tresor");
  await create.getByRole("checkbox", { name: "Verschlüsselter Bereich" }).check();
  await expect(create.getByText(/Wer Passphrase und Wiederherstellungsschlüssel verliert/)).toBeVisible();
  await create.getByRole("button", { name: "Bereich erstellen" }).click();
  await setUpKeys(alice.page, "alice ihr langer satz");
  await create.getByRole("button", { name: "Bereich erstellen" }).click();
  await expect(create).toBeHidden();
  const space = db.prepare("SELECT id,encrypted,visibility FROM spaces WHERE workspace_id=? AND name='Tresor'").get(workspace) as { id: string; encrypted: number; visibility: string };
  expect(space.encrypted).toBe(1);
  expect(space.visibility).toBe("private");
  const created = await alice.page.request.post(`${origin}/api/command`, {
    headers: { origin },
    data: { action: "page.create", workspaceId: workspace, spaceId: space.id, title: "Tagebuch" },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const pageId = (await created.json()).id as string;
  // Databases are not offered in encrypted spaces.
  const database = await alice.page.request.post(`${origin}/api/command`, {
    headers: { origin },
    data: { action: "page.create", workspaceId: workspace, spaceId: space.id, title: "Tabelle", kind: "database" },
  });
  expect(database.status()).toBe(409);

  // Alice gives Bob the key (still unlocked in this tab).
  await alice.page.getByRole("button", { name: "Mitglieder und Schlüssel von Tresor" }).click();
  const members = alice.page.getByRole("dialog", { name: "Mitglieder und Schlüssel" });
  await members.locator("li").filter({ hasText: "Bob Tresor" }).getByRole("button", { name: "Schlüssel geben" }).click();
  await expect(members.locator("ul.e2ee-members").first().locator("li").filter({ hasText: "Bob Tresor" })).toBeVisible();
  await members.getByRole("button", { name: "Schließen" }).click().catch(() => alice.page.keyboard.press("Escape"));

  // Alice writes.
  await alice.page.goto(`${origin}/#page=${pageId}`);
  const editorA = alice.page.locator(".e2ee-editor");
  await expect(editorA).toBeVisible({ timeout: 20000 });
  await expect(alice.page.locator(".e2ee-badge")).toBeVisible();
  // No share button, no comments: encrypted pages only list members.
  await expect(alice.page.locator(".share-button")).toHaveText(/Mitglieder/);
  await editorA.click();
  await alice.page.keyboard.type(`Liebes Tagebuch ${MARKER}`);
  await expect(alice.page.locator(".save-status")).toHaveText(/Gespeichert/, { timeout: 15000 });

  // Bob unlocks and reads it, decrypted in his browser.
  // A reload forgets the keys of the tab (they were unlocked at setup).
  await bob.page.goto(`${origin}/#page=${pageId}`);
  await bob.page.reload();
  await bob.page.getByRole("button", { name: "Entsperren" }).click();
  const unlock = bob.page.getByRole("dialog", { name: "Verschlüsselte Bereiche entsperren" });
  await unlock.getByLabel("Passphrase").fill("falsch falsch falsch");
  await unlock.getByRole("button", { name: "Entsperren" }).click();
  await expect(unlock.getByRole("alert")).toHaveText(/Passphrase stimmt nicht/, { timeout: 20000 });
  await unlock.getByLabel("Passphrase").fill("bob sein langer satz");
  await unlock.getByRole("button", { name: "Entsperren" }).click();
  const editorB = bob.page.locator(".e2ee-editor");
  await expect(editorB).toContainText(`Liebes Tagebuch ${MARKER}`, { timeout: 20000 });

  // Live: Bob types, Alice sees it without reloading – and the other way.
  await editorB.click();
  await bob.page.keyboard.press("End");
  await bob.page.keyboard.type(" und Bob");
  await expect(editorA).toContainText("und Bob", { timeout: 15000 });
  await alice.page.keyboard.press("End");
  await alice.page.keyboard.type(" – Antwort");
  await expect(editorB).toContainText("– Antwort", { timeout: 15000 });
  await expect(bob.page.locator(".save-status")).toHaveText(/Gespeichert/, { timeout: 15000 });
  await expect(alice.page.locator(".save-status")).toHaveText(/Gespeichert/, { timeout: 15000 });

  // An image, encrypted in Alice's browser, shows decrypted for Bob.
  await alice.page.locator(".e2ee-toolbar input[type=file]").setInputFiles(join(process.cwd(), "tests/fixtures/scan.png"));
  await expect(alice.page.locator(".e2ee-file img")).toHaveAttribute("src", /^blob:/, { timeout: 15000 });
  await expect(bob.page.locator(".e2ee-file img")).toHaveAttribute("src", /^blob:/, { timeout: 15000 });
  const stored = db.prepare("SELECT name,mime FROM files WHERE page_id=?").get(pageId) as { name: string; mime: string };
  expect(stored).toEqual({ name: "encrypted.bin", mime: "application/octet-stream" });

  // The server hands out no plaintext: page data is empty, exports refuse.
  const data = await (await alice.page.request.get(`${origin}/api/pages/${pageId}`)).json();
  expect(data.html).toBe("");
  expect(data.generation).toBe("e2ee");
  const exported = await alice.page.request.post(`${origin}/api/markdown-export`, { headers: { origin }, data: { pageId, format: "markdown" } });
  expect(exported.status()).toBe(409);
  const sync = await alice.page.request.post(`${origin}/api/command`, {
    headers: { origin },
    data: { action: "document.sync", pageId, generation: "1", update: "" },
  });
  expect(sync.status()).toBe(409);
  // Uploads: only files the browser encrypted.
  const plainUpload = await alice.page.request.post(`${origin}/api/upload`, {
    headers: { origin },
    multipart: { pageId, file: { name: "klartext.txt", mimeType: "text/plain", buffer: Buffer.from(MARKER) } },
  });
  expect(plainUpload.status()).toBe(409);
  const fakeUpload = await alice.page.request.post(`${origin}/api/upload`, {
    headers: { origin },
    multipart: { pageId, purpose: "e2ee", file: { name: "klartext.txt", mimeType: "text/plain", buffer: Buffer.from(MARKER) } },
  });
  expect(fakeUpload.status()).toBe(400);

  // Nothing readable in the database files.
  const updates = db.prepare("SELECT count(*) n FROM e2ee_updates WHERE page_id=?").get(pageId) as { n: number };
  expect(updates.n).toBeGreaterThan(0);
  db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  for (const name of readdirSync(dir).filter((n) => n.startsWith("flowplan.sqlite")))
    expect(readFileSync(join(dir, name)).includes(MARKER), `${name} contains plaintext`).toBe(false);
  for (const name of ["alice ihr langer satz", "bob sein langer satz"])
    for (const file of readdirSync(dir).filter((n) => n.startsWith("flowplan.sqlite"))) expect(readFileSync(join(dir, file)).includes(name)).toBe(false);

  // A space with encrypted titles: the sidebar shows the title, the server
  // stores the placeholder and ciphertext.
  await alice.page.locator(".add-space").click();
  await create.getByLabel("Name").fill("Notizen");
  await create.getByRole("checkbox", { name: "Verschlüsselter Bereich" }).check();
  await create.getByRole("checkbox", { name: "Titel verschlüsseln" }).check();
  await create.getByRole("button", { name: "Bereich erstellen" }).click();
  await expect(create).toBeHidden();
  await alice.page.getByTitle("Seite in Notizen hinzufügen").click();
  const newPage = alice.page.getByRole("dialog", { name: "Neue Seite" });
  const secretTitle = `Passwörter ${MARKER}`;
  await newPage.getByLabel("Name").fill(secretTitle);
  await newPage.getByRole("button", { name: "Seite erstellen" }).click();
  await expect(alice.page.locator(".page-title")).toHaveValue(secretTitle, { timeout: 15000 });
  await expect(alice.page.locator(".sidebar").getByText(secretTitle)).toBeVisible();
  const titled = db.prepare("SELECT p.title,p.title_cipher FROM pages p JOIN spaces s ON s.id=p.space_id WHERE s.name='Notizen'").get() as { title: string; title_cipher: string };
  expect(titled.title).toBe("Verschlüsselte Seite");
  expect(titled.title_cipher).toMatch(/^\{"v":1,"d":"/);
  expect(titled.title_cipher.includes(MARKER)).toBe(false);

  // Locking forgets the keys in this tab.
  await bob.page.goto(`${origin}/#settings/account`);
  await bob.page.getByRole("button", { name: "Jetzt sperren" }).click();
  await bob.page.goto(`${origin}/#page=${pageId}`);
  await expect(bob.page.getByRole("button", { name: "Entsperren" })).toBeVisible();
  await bob.page.screenshot({ path: "test-results/e2ee-locked.png" });
  await alice.page.screenshot({ path: "test-results/e2ee-editor.png" });
  db.close();
  await alice.context.close();
  await bob.context.close();
  expect(errors).toEqual([]);
});
