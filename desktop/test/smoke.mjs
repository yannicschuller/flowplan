// Starts the desktop app against a running Flowplan instance and checks
// setup, loading and the offline page. Usage: node test/smoke.mjs <url>
import { _electron as electron } from "../../node_modules/playwright/index.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
// FLOWPLAN_APP: path of a packaged app executable instead of the dev build.
const packaged = process.env.FLOWPLAN_APP;
const executablePath = packaged || createRequire(import.meta.url)("electron");

const server = process.argv[2] || "http://127.0.0.1:3100";
async function launch(config, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "flowplan-desktop-"));
  if (config) writeFileSync(join(dir, "config.json"), JSON.stringify(config));
  const app = await electron.launch({
    executablePath,
    args: [...(packaged ? [] : ["."]), `--user-data-dir=${dir}`],
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, ...env },
  });
  return { app, window: await app.firstWindow() };
}
// First start: the setup page, a wrong address is refused, the right one loads.
{
  const { app, window } = await launch();
  await window.waitForSelector("text=Willkommen bei Flowplan");
  await window.fill("#server", "http://127.0.0.1:1");
  await window.click("#submit");
  await window.waitForSelector("#error:not(:empty)");
  assert.match(await window.textContent("#error"), /keine Flowplan-Instanz/);
  await window.fill("#server", server);
  await window.click("#submit");
  await window.waitForURL((url) => url.href.startsWith(server), { timeout: 30000 });
  await window.waitForLoadState("domcontentloaded");
  assert.equal(await window.title().then((t) => /Flowplan/i.test(t)), true);
  await window.screenshot({ path: "test/app.png" });
  await app.close();
  console.log("✔ Einrichtung und Laden");
}
// An unreachable instance shows the offline page.
{
  const { app, window } = await launch({ server: "http://127.0.0.1:1" });
  await window.waitForSelector("text=Keine Verbindung zu Flowplan", { timeout: 30000 });
  await window.screenshot({ path: "test/offline.png" });
  await app.close();
  console.log("✔ Offline-Seite");
}
// A preset address (managed installation) skips the setup page.
{
  const { app, window } = await launch(undefined, { FLOWPLAN_SERVER: server });
  await window.waitForURL((url) => url.href.startsWith(server), { timeout: 30000 });
  await app.close();
  console.log("✔ Vorgegebene Adresse");
}
