// Starts the production build (the standalone server, laid out like the
// Docker image) with an empty data directory, and creates an account with
// example content through the API. Used by the quality budgets
// (scripts/quality-check.mjs) and the visual regression tests
// (tests/visual). Needs `npm run build` first.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();

export const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

export function hasBuild() {
  return existsSync(join(root, ".next/standalone/server.js"));
}

// The server with its own temporary data directory; stop() ends it and
// removes both the copy of the server and the data.
export async function startProductionServer({ env = {} } = {}) {
  if (!hasBuild()) throw new Error("No standalone build – run `npm run build` first.");
  const work = mkdtempSync(join(tmpdir(), "flowplan-prod-"));
  const app = join(work, "app");
  const data = join(work, "data");
  mkdirSync(data);
  // server.js serves .next/static and public next to itself (the Docker
  // image copies them there); links are enough here.
  // The traced node_modules (most of the 300 MB) are only read: linked.
  const standalone = join(root, ".next/standalone");
  mkdirSync(app);
  for (const entry of readdirSync(standalone))
    if (entry === "node_modules") symlinkSync(join(standalone, entry), join(app, entry), "dir");
    else cpSync(join(standalone, entry), join(app, entry), { recursive: true });
  for (const dir of [".next/static", "public"]) {
    rmSync(join(app, dir), { recursive: true, force: true });
    symlinkSync(join(root, dir), join(app, dir), "dir");
  }
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: app,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      FLOWPLAN_DATA_DIR: data,
      APP_URL: origin,
      NEXT_TELEMETRY_DISABLED: "1",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const stop = async () => {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    rmSync(work, { recursive: true, force: true });
  };
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      if ((await fetch(`${origin}/api/health`)).ok) return { origin, data, stop, log: () => log };
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  await stop();
  throw new Error(`The server did not start:\n${log}`);
}

// A fixed account and example content, so screens look the same on every
// run: a document, a project database (table and board) with fixed dates.
export const ACCOUNT = { name: "Mara Lindqvist", email: "mara@example.test", password: "ein-langes-passwort" };

const DOCUMENT = `## Ziele für das Quartal

Wir bringen die neue Version im Herbst heraus und halten die Ladezeit unter einer Sekunde.

- Onboarding in drei Schritten
- Offline-Modus für Tabellen
- Neue Vorlagen für Teams

> Entscheidungen halten wir schriftlich fest – kurz, mit Datum und Begründung.

### Nächste Schritte

1. Entwürfe bis Freitag abstimmen
2. Testplan schreiben
3. Release vorbereiten
`;

const ROWS = [
  ["Onboarding vereinfachen", "In Arbeit", "Hoch", "2026-10-12", ["Design"]],
  ["Designsystem dokumentieren", "Offen", "Mittel", "2026-10-14", ["Design"]],
  ["Mobile Navigation", "In Arbeit", "Mittel", "2026-10-16", ["Produkt"]],
  ["Feedback aus Nutzertests", "Erledigt", "Niedrig", "2026-10-09", ["Produkt"]],
  ["Release vorbereiten", "Offen", "Hoch", "2026-10-20", ["Produkt", "Design"]],
];

// A Yjs update that replaces the content of a document by the given HTML,
// base64 (lib/document-server.ts). It builds on the stored state and removes
// what is there first – merged next to it, the new content would land before
// or after the empty first paragraph by chance (Yjs orders concurrent
// inserts by random client ids). The module is TypeScript, so it runs in a
// child process under tsx.
function documentUpdate(html, state) {
  const code = `import * as Y from "yjs";
import { htmlState } from ${JSON.stringify(join(root, "lib/document-server.ts"))};
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", () => {
  const { html, state } = JSON.parse(input);
  const doc = new Y.Doc();
  if (state) Y.applyUpdate(doc, Buffer.from(state, "base64"));
  const before = Y.encodeStateVector(doc);
  const fragment = doc.getXmlFragment("default");
  if (fragment.length) fragment.delete(0, fragment.length);
  Y.applyUpdate(doc, htmlState(html));
  process.stdout.write(Buffer.from(Y.encodeStateAsUpdate(doc, before)).toString("base64"));
});`;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    cwd: root,
    input: JSON.stringify({ html, state }),
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`Document update: ${result.stderr}`);
  return result.stdout;
}

// Signs up the first account of the instance (it becomes the admin) through
// a Playwright APIRequestContext, which keeps the session cookie, and seeds
// the content. Returns the ids of the pages.
export async function seedAccount(request, origin) {
  const post = async (path, data) => {
    const response = await request.post(path, { headers: { origin }, data });
    if (!response.ok()) throw new Error(`${path} ${data?.action ?? ""}: ${response.status()} ${await response.text()}`);
    return response.json();
  };
  await post("/api/auth/register", ACCOUNT);
  const boot = await (await request.get("/api/bootstrap")).json();
  const command = (data) => post("/api/command", data);
  await command({ action: "profile.onboarded" }).catch(() => {});
  // The example pages carry dates relative to today; they go.
  for (const page of boot.pages ?? [])
    if (page.kind === "database" || page.parent_id) await command({ action: "page.delete", pageId: page.id }).catch(() => {});
  const workspaceId = boot.workspace.id;
  const spaceId = boot.spaces[0].id;
  const doc = await command({ action: "page.create", workspaceId, spaceId, title: "Projektbriefing", kind: "document" });
  // The server turns the Markdown into HTML (as "Edit as Markdown" does);
  // the document's collaborative state is built from it like the editor's.
  const { html } = await command({ action: "document.markdown.apply", pageId: doc.id, markdown: DOCUMENT, check: true });
  const { generation, state } = await (await request.get(`/api/pages/${doc.id}`)).json();
  await command({ action: "document.sync", pageId: doc.id, generation, update: documentUpdate(html, state) });
  const db = await command({ action: "page.create", workspaceId, spaceId, title: "Projekte", kind: "database" });
  const read = async () => (await request.get(`/api/pages/${db.id}`)).json();
  await command({
    action: "database.update",
    pageId: db.id,
    version: (await read()).database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "status", name: "Status", type: "select", options: ["Offen", "In Arbeit", "Erledigt"] },
      { id: "priority", name: "Priorität", type: "select", options: ["Hoch", "Mittel", "Niedrig"] },
      { id: "date", name: "Fällig", type: "date" },
      { id: "tags", name: "Tags", type: "multiselect", options: ["Design", "Produkt"] },
    ],
    views: [
      { id: "table", name: "Tabelle", type: "table", filters: [], sorts: [] },
      { id: "board", name: "Board", type: "board", filters: [], sorts: [], groupBy: "status" },
    ],
  });
  for (const [title, status, priority, date, tags] of ROWS)
    await command({ action: "row.create", pageId: db.id, cells: { title, status, priority, date, tags } });
  return { workspaceId, documentId: doc.id, databaseId: db.id };
}
