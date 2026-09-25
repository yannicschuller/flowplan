// Checks offline use against the production standalone build in Chromium:
// opt in, go offline, reload and open a document and a database from the
// device copies, then remove them. Usage: npm run build && npm run check:offline
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";

const root = process.cwd();
if (!existsSync(join(root, ".next/standalone/server.js"))) {
  console.error(
    "Kein Standalone-Build gefunden. Zuerst `npm run build` ausführen.",
  );
  process.exit(1);
}
const work = mkdtempSync(join(tmpdir(), "flowplan-offline-"));
const app = join(work, "app"),
  data = join(work, "data");
cpSync(join(root, ".next/standalone"), app, { recursive: true });
cpSync(join(root, ".next/static"), join(app, ".next/static"), {
  recursive: true,
});
cpSync(join(root, "public"), join(app, "public"), { recursive: true });
const port = 3700 + Math.floor(Math.random() * 200);
const origin = `http://127.0.0.1:${port}`;
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✔" : "✖"} ${name}${detail ? ` – ${detail}` : ""}`);
  if (!ok) failures++;
};
const server = spawn(process.execPath, ["server.js"], {
  cwd: app,
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    FLOWPLAN_DATA_DIR: data,
    APP_URL: origin,
    NEXT_TELEMETRY_DISABLED: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));
let browser;
try {
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try {
      up = (await fetch(`${origin}/api/health`)).ok;
    } catch {}
    if (!up) await new Promise((r) => setTimeout(r, 200));
  }
  if (!up) throw new Error(`Server startete nicht:\n${log}`);
  // Session inserted directly, as OIDC is not configured for this check.
  const db = new DatabaseSync(join(data, "flowplan.sqlite"));
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)").run(
    uid,
    `offline-check:${uid}`,
    "Offline Check",
    `${uid}@example.test`,
  );
  db.prepare(
    "INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)",
  ).run(
    createHash("sha256").update(token).digest("hex"),
    uid,
    "[]",
    Date.now() + 600000,
  );
  db.close();
  const headers = {
    origin,
    cookie: `flowplan_session=${token}`,
    "content-type": "application/json",
  };
  const post = async (body) =>
    (
      await fetch(`${origin}/api/command`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      })
    ).json();
  const workspace = await post({ action: "workspace.create", name: "Offline" });
  const boot = await (
    await fetch(`${origin}/api/bootstrap?workspace=${workspace.id}`, {
      headers,
    })
  ).json();
  const doc = await post({
    action: "page.create",
    workspaceId: workspace.id,
    spaceId: boot.spaces[0].id,
    title: "Reiseplan",
  });
  const html = "<p>Zug um 8 Uhr ab Hauptbahnhof</p>";
  const syncDb = new DatabaseSync(join(data, "flowplan.sqlite"));
  syncDb
    .prepare("UPDATE documents SET html=?,state=NULL WHERE page_id=?")
    .run(html, doc.id);
  syncDb.close();
  const table = await post({
    action: "page.create",
    workspaceId: workspace.id,
    spaceId: boot.spaces[0].id,
    title: "Packliste",
    kind: "database",
  });
  await post({
    action: "row.create",
    pageId: table.id,
    cells: { title: "Reisepass" },
  });

  browser = await chromium.launch();
  const context = await browser.newContext();
  await context.addCookies([
    { name: "flowplan_session", value: token, url: origin, httpOnly: true },
  ]);
  const page = await context.newPage();
  await page.goto(`${origin}/?w=${workspace.id}#settings`);
  await page.getByRole("button", { name: "Daten", exact: true }).click();
  await page
    .getByRole("button", { name: "Auf diesem Gerät offline verfügbar machen" })
    .click();
  await page.getByText(/offline verfügbar\./).waitFor({ timeout: 30000 });
  check("Offline-Nutzung aktiviert", true);
  let visit = 0;
  const open = (id) => page.goto(`${origin}/?v=${++visit}#page=${id}`);
  // One more online round so the worker stores every script it serves.
  await open(doc.id);
  await page.getByText("Zug um 8 Uhr").first().waitFor();
  await open(table.id);
  await page.getByText("Reisepass").first().waitFor();

  await context.setOffline(true);
  await open(doc.id);
  const banner = await page
    .locator(".offline-banner")
    .waitFor({ timeout: 15000 })
    .then(
      () => true,
      () => false,
    );
  check("Offline-Hinweis sichtbar", banner);
  const docOk = await page
    .getByText("Zug um 8 Uhr")
    .first()
    .waitFor({ timeout: 15000 })
    .then(
      () => true,
      () => false,
    );
  check("Dokument offline lesbar", docOk);
  await open(table.id);
  const rowOk = await page
    .locator(".data-table")
    .getByText("Reisepass")
    .waitFor({ timeout: 15000 })
    .then(
      () => true,
      () => false,
    );
  check("Datenbank offline lesbar", rowOk);
  await context.setOffline(false);

  await page.goto(`${origin}/?v=${++visit}#settings`);
  await page.getByRole("button", { name: "Daten", exact: true }).click();
  await page.getByRole("button", { name: "Offline-Kopien entfernen" }).click();
  await page
    .getByText("Offline-Kopien auf diesem Gerät wurden entfernt.")
    .waitFor();
  const keys = await page.evaluate(() => caches.keys());
  check(
    "Offline-Kopien entfernt",
    !keys.includes("flowplan-data-v1"),
    keys.join(", "),
  );
  await context.setOffline(true);
  // Without opt-in the worker passes requests through, so loading fails.
  const gone = await open(doc.id)
    .then(() =>
      page
        .getByText("Zug um 8 Uhr")
        .first()
        .waitFor({ timeout: 4000 })
        .then(
          () => false,
          () => true,
        ),
    )
    .catch(() => true);
  check("Ohne Opt-in keine Offline-Daten", gone);
} catch (error) {
  console.error(error);
  failures++;
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  rmSync(work, { recursive: true, force: true });
}
console.log(
  failures
    ? `${failures} Prüfung(en) fehlgeschlagen.`
    : "Alle Prüfungen erfolgreich.",
);
process.exit(failures ? 1 : 0);
