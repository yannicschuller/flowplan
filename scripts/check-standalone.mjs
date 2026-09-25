// Runs the production standalone build like the container does and checks
// health, security defaults, persistence across restarts and a restore from a
// file-level backup. Usage: npm run build && npm run check:standalone
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { samplePdf } from "../tests/helpers/pdf.ts";

const root = process.cwd();
if (!existsSync(join(root, ".next/standalone/server.js"))) {
  console.error(
    "Kein Standalone-Build gefunden. Zuerst `npm run build` ausführen.",
  );
  process.exit(1);
}
const work = mkdtempSync(join(tmpdir(), "flowplan-standalone-"));
const app = join(work, "app");
// Same layout as the runtime stage of the Dockerfile.
cpSync(join(root, ".next/standalone"), app, { recursive: true });
cpSync(join(root, ".next/static"), join(app, ".next/static"), {
  recursive: true,
});
cpSync(join(root, "public"), join(app, "public"), { recursive: true });
const metricsToken = randomBytes(24).toString("hex");
const port = 3200 + Math.floor(Math.random() * 500);
const origin = `http://127.0.0.1:${port}`;
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✔" : "✖"} ${name}${detail ? ` – ${detail}` : ""}`);
  if (!ok) failures++;
};

async function start(dataDir) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: app,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      FLOWPLAN_DATA_DIR: dataDir,
      APP_URL: origin,
      NEXT_TELEMETRY_DISABLED: "1",
      FLOWPLAN_METRICS_TOKEN: metricsToken,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d, (child.log = log)));
  child.stderr.on("data", (d) => (log += d, (child.log = log)));
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${origin}/api/health`);
      if (r.ok) return child;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill();
  throw new Error(`Server startete nicht:\n${log}`);
}
const stop = (child) =>
  new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGTERM");
  });

// A session is inserted directly, as OIDC is not configured for this check.
function session(dataDir, groups = []) {
  const db = new DatabaseSync(join(dataDir, "flowplan.sqlite"));
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)").run(
    uid,
    `standalone-check:${uid}`,
    "Standalone Check",
    `${uid}@example.test`,
  );
  db.prepare(
    "INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)",
  ).run(
    createHash("sha256").update(token).digest("hex"),
    uid,
    JSON.stringify(groups),
    Date.now() + 600000,
  );
  db.close();
  return { cookie: `flowplan_session=${token}` };
}

const data = join(work, "data");
try {
  let server = await start(data);
  const health = await (await fetch(`${origin}/api/health`)).json();
  check(
    "Health-Endpunkt",
    health.status === "ok",
    JSON.stringify(health.checks),
  );
  const home = await fetch(`${origin}/`);
  const homeHtml = await home.text();
  check("Startseite ausgeliefert", home.ok && homeHtml.includes("<html"));
  const script = /\/_next\/static\/[^"']+\.js/.exec(homeHtml)?.[0];
  check(
    "Statische Assets ausgeliefert",
    !!script && (await fetch(`${origin}${script}`)).ok,
    script,
  );
  const manifest = await fetch(`${origin}/manifest.webmanifest`);
  check("Öffentliche Dateien", manifest.ok);
  const demo = await fetch(`${origin}/api/auth/demo`, {
    method: "POST",
    headers: { origin },
  });
  check("Kein Demo-Login in Produktion", demo.status === 403);
  const anonymous = await fetch(`${origin}/api/bootstrap`);
  check("API verlangt Anmeldung", anonymous.status === 401);
  const unscraped = await fetch(`${origin}/api/metrics`);
  check("Metriken verlangen Token", unscraped.status === 401);
  const metrics = await fetch(`${origin}/api/metrics`, {
    headers: { authorization: `Bearer ${metricsToken}` },
  });
  check(
    "Prometheus-Metriken",
    metrics.ok && /^flowplan_database_bytes \d+$/m.test(await metrics.text()),
  );

  const { cookie } = session(data);
  const headers = { origin, cookie, "content-type": "application/json" };
  // Normally the OIDC callback creates the first workspace.
  const workspace = await (
    await fetch(`${origin}/api/command`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "workspace.create", name: "Standalone" }),
    })
  ).json();
  const boot = await (
    await fetch(`${origin}/api/bootstrap?workspace=${workspace.id}`, {
      headers,
    })
  ).json();
  check("Arbeitsbereich angelegt", boot.workspace?.id === workspace.id);
  const created = await (
    await fetch(`${origin}/api/command`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "page.create",
        workspaceId: boot.workspace.id,
        spaceId: boot.spaces[0].id,
        title: "Standalone-Persistenz",
      }),
    })
  ).json();
  const form = new FormData();
  form.set("pageId", created.id);
  form.set("file", new Blob(["Inhalt"], { type: "text/plain" }), "notiz.txt");
  const upload = await fetch(`${origin}/api/upload`, {
    method: "POST",
    headers: { origin, cookie },
    body: form,
  });
  const file = await upload.json();
  check("Upload gespeichert", upload.ok && !!file.url);

  // PDF text is extracted in the background and becomes searchable.
  const pdfForm = new FormData();
  pdfForm.set("pageId", created.id);
  pdfForm.set(
    "file",
    new Blob([samplePdf(["Kaeltemittelpruefung Standalone"])], {
      type: "application/pdf",
    }),
    "pruefung.pdf",
  );
  const pdfUpload = await fetch(`${origin}/api/upload`, {
    method: "POST",
    headers: { origin, cookie },
    body: pdfForm,
  });
  let pdfFound = false;
  for (let i = 0; pdfUpload.ok && i < 40 && !pdfFound; i++) {
    const hits = await (
      await fetch(
        `${origin}/api/search?workspace=${boot.workspace.id}&q=Kaeltemittelpruefung&kind=file`,
        { headers },
      )
    ).json();
    pdfFound =
      Array.isArray(hits) && hits.some((h) => h.title === "pruefung.pdf");
    if (!pdfFound) await new Promise((r) => setTimeout(r, 500));
  }
  check("PDF-Volltext durchsuchbar", pdfFound);
  // Scanned PDFs are recognised by OCR in the background.
  const scanForm = new FormData();
  scanForm.set("pageId", created.id);
  scanForm.set(
    "file",
    new Blob([readFileSync(join(root, "tests/fixtures/scan.pdf"))], {
      type: "application/pdf",
    }),
    "scan.pdf",
  );
  const scanUpload = await fetch(`${origin}/api/upload`, {
    method: "POST",
    headers: { origin, cookie },
    body: scanForm,
  });
  let scanFound = false;
  for (let i = 0; scanUpload.ok && i < 90 && !scanFound; i++) {
    const hits = await (
      await fetch(
        `${origin}/api/search?workspace=${boot.workspace.id}&q=Wartungsvertrag&kind=file`,
        { headers },
      )
    ).json();
    scanFound = Array.isArray(hits) && hits.some((h) => h.title === "scan.pdf");
    if (!scanFound) await new Promise((r) => setTimeout(r, 1000));
  }
  check("Texterkennung gescannter PDFs", scanFound);
  if (!scanFound) {
    const probe = new DatabaseSync(join(data, "flowplan.sqlite"));
    console.log(
      probe
        .prepare(
          "SELECT f.name,t.status,length(t.text) chars FROM files f LEFT JOIN file_texts t ON t.file_id=f.id",
        )
        .all(),
    );
    probe.close();
    console.log(server.log?.slice(-3000));
  }

  await stop(server);
  server = await start(data);
  const again = await fetch(`${origin}/api/pages/${created.id}`, { headers });
  check("Daten bleiben nach Neustart erhalten", again.ok);
  const stored = await fetch(`${origin}${file.url}`, { headers });
  check(
    "Upload nach Neustart lesbar",
    stored.ok && (await stored.text()) === "Inhalt",
  );

  // Whole-instance backup: download, change, restore, restart.
  const admin = session(data, ["flowplan-admins"]);
  const adminHeaders = { origin, cookie: admin.cookie };
  const download = await fetch(`${origin}/api/admin/instance-backup`, {
    headers: adminHeaders,
  });
  const instanceBackup = Buffer.from(await download.arrayBuffer());
  check(
    "Instanzsicherung heruntergeladen",
    download.ok && instanceBackup.length > 1000,
    `${Math.round(instanceBackup.length / 1024)} KB`,
  );
  const later = await (
    await fetch(`${origin}/api/command`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "page.create",
        workspaceId: boot.workspace.id,
        spaceId: boot.spaces[0].id,
        title: "Nach der Instanzsicherung",
      }),
    })
  ).json();
  const staged = await fetch(`${origin}/api/admin/instance-backup`, {
    method: "POST",
    headers: { ...adminHeaders, "content-type": "application/zip" },
    body: instanceBackup,
  });
  const summary = await staged.json();
  check(
    "Instanzsicherung geprüft und vorgemerkt",
    staged.ok && summary.pages >= 1 && summary.files >= 1,
    JSON.stringify(summary),
  );
  await stop(server);
  server = await start(data);
  const afterRestore = await fetch(`${origin}/api/pages/${created.id}`, {
    headers,
  });
  const removed = await fetch(`${origin}/api/pages/${later.id}`, { headers });
  check(
    "Instanz beim Neustart wiederhergestellt",
    afterRestore.ok &&
      removed.status === 404 &&
      readdirSync(data).some((name) => name.startsWith("pre-restore-")),
  );
  await stop(server);

  // Backup: consistent SQLite copy plus uploads, restored into a new directory.
  const backup = join(work, "backup");
  mkdirSync(backup);
  const db = new DatabaseSync(join(data, "flowplan.sqlite"));
  db.exec(
    `VACUUM INTO '${join(backup, "flowplan.sqlite").replaceAll("'", "''")}'`,
  );
  db.close();
  cpSync(join(data, "uploads"), join(backup, "uploads"), { recursive: true });
  server = await start(backup);
  const restored = await fetch(`${origin}/api/pages/${created.id}`, {
    headers,
  });
  const page = restored.ok ? await restored.json() : null;
  check(
    "Wiederherstellung aus Backup",
    page?.page?.title === "Standalone-Persistenz",
  );
  const restoredFile = await fetch(`${origin}${file.url}`, { headers });
  check("Upload im Backup vorhanden", restoredFile.ok);
  await stop(server);
} catch (error) {
  console.error(error);
  failures++;
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(
  failures
    ? `${failures} Prüfung(en) fehlgeschlagen.`
    : "Alle Prüfungen erfolgreich.",
);
process.exit(failures ? 1 : 0);
