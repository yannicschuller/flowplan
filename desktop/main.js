// Flowplan for macOS and Windows: a window around a Flowplan instance.
// Everything runs on the server; the app remembers the address, the window
// and offers native menus, links in the browser and an offline page.
const {
  app,
  BrowserWindow,
  Menu,
  shell,
  ipcMain,
  session,
  dialog,
  nativeTheme,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const isMac = process.platform === "darwin";
const configFile = () => path.join(app.getPath("userData"), "config.json");
function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configFile(), "utf8"));
  } catch {
    return {};
  }
}
function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(next, null, 2));
  return next;
}
// Addresses are https (or http only for local development).
function normalizeServer(input) {
  let value = String(input || "").trim();
  if (!value) throw new Error("Bitte die Adresse deiner Flowplan-Instanz eingeben.");
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !local)
    throw new Error("Nur HTTPS-Adressen sind erlaubt (HTTP nur für localhost).");
  return url.origin;
}
async function checkServer(origin) {
  const response = await fetch(`${origin}/api/health`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Der Server antwortet mit ${response.status}.`);
  return true;
}

let win = null;
// Managed installations can preset the instance: --server=<url> or the
// environment variable FLOWPLAN_SERVER. A choice in the app wins later.
function presetServer() {
  const arg = process.argv.find((a) => a.startsWith("--server="));
  const value = arg ? arg.slice("--server=".length) : process.env.FLOWPLAN_SERVER;
  if (!value) return undefined;
  try {
    return normalizeServer(value);
  } catch {
    return undefined;
  }
}
const server = () => readConfig().server || presetServer();
const page = (name) => path.join(__dirname, "pages", name);
function sameOrigin(url) {
  try {
    return new URL(url).origin === server();
  } catch {
    return false;
  }
}
function openServer() {
  const origin = server();
  if (!win) return;
  if (!origin) return win.loadFile(page("setup.html"));
  win.loadURL(origin).catch(() => {});
}
function createWindow() {
  const state = readConfig().window || {};
  win = new BrowserWindow({
    width: state.width || 1320,
    height: state.height || 860,
    x: state.x,
    y: state.y,
    minWidth: 380,
    minHeight: 500,
    title: "Flowplan",
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1f2329" : "#ffffff",
    autoHideMenuBar: !isMac,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  if (state.maximized) win.maximize();
  win.once("ready-to-show", () => win.show());
  const saveState = () => {
    if (!win || win.isDestroyed()) return;
    const maximized = win.isMaximized();
    writeConfig({
      window: maximized
        ? { ...(readConfig().window || {}), maximized }
        : { ...win.getBounds(), maximized },
    });
  };
  win.on("close", saveState);
  // Links to other sites open in the default browser; sign-in pages of the
  // identity provider stay in the window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!sameOrigin(url) && /^(https?:|mailto:)/i.test(url))
      void shell.openExternal(url);
    else if (sameOrigin(url)) win.loadURL(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith("file:") || sameOrigin(url)) return;
    // The sign-in flow leaves the instance and comes back to /api/auth.
    const current = win.webContents.getURL();
    const signingIn = /\/api\/auth\//.test(current) || /\/api\/auth\//.test(url);
    if (signingIn || isIdentityProvider(url)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });
  win.webContents.on("did-fail-load", (_e, code, description, url, isMain) => {
    if (!isMain || code === -3) return; // -3: navigation replaced
    win.loadFile(page("offline.html"), {
      query: { server: server() || "", error: description || String(code) },
    });
  });
  openServer();
}
// Hosts seen during sign-in are allowed in the window afterwards.
const identityHosts = new Set();
function isIdentityProvider(url) {
  try {
    return identityHosts.has(new URL(url).host);
  } catch {
    return false;
  }
}
function trackSignIn() {
  session.defaultSession.webRequest.onBeforeRedirect((details) => {
    if (sameOrigin(details.url) && /\/api\/auth\//.test(details.url))
      try {
        const next = new URL(details.redirectURL);
        if (next.origin !== server()) identityHosts.add(next.host);
      } catch {}
  });
}
async function chooseServer() {
  if (!win) return;
  win.loadFile(page("setup.html"), { query: { server: server() || "" } });
}
function buildMenu() {
  const nav = (fn) => () => win && fn(win.webContents);
  const template = [
    ...(isMac
      ? [
          {
            label: "Flowplan",
            submenu: [
              { role: "about", label: "Über Flowplan" },
              { type: "separator" },
              { label: "Server wechseln …", click: chooseServer },
              { type: "separator" },
              { role: "hide", label: "Flowplan ausblenden" },
              { role: "hideOthers", label: "Andere ausblenden" },
              { role: "unhide", label: "Alle einblenden" },
              { type: "separator" },
              { role: "quit", label: "Flowplan beenden" },
            ],
          },
        ]
      : [
          {
            label: "Datei",
            submenu: [
              { label: "Server wechseln …", click: chooseServer },
              { type: "separator" },
              { role: "quit", label: "Beenden" },
            ],
          },
        ]),
    {
      label: "Bearbeiten",
      submenu: [
        { role: "undo", label: "Widerrufen" },
        { role: "redo", label: "Wiederholen" },
        { type: "separator" },
        { role: "cut", label: "Ausschneiden" },
        { role: "copy", label: "Kopieren" },
        { role: "paste", label: "Einsetzen" },
        { role: "pasteAndMatchStyle", label: "Ohne Formatierung einsetzen" },
        { role: "selectAll", label: "Alles auswählen" },
      ],
    },
    {
      label: "Ansicht",
      submenu: [
        { role: "reload", label: "Neu laden" },
        { role: "forceReload", label: "Neu laden ohne Cache" },
        { type: "separator" },
        { role: "resetZoom", label: "Originalgröße" },
        { role: "zoomIn", label: "Vergrößern" },
        { role: "zoomOut", label: "Verkleinern" },
        { type: "separator" },
        { role: "togglefullscreen", label: "Vollbild" },
        { role: "toggleDevTools", label: "Entwicklerwerkzeuge" },
      ],
    },
    {
      label: "Navigation",
      submenu: [
        {
          label: "Zurück",
          accelerator: isMac ? "Cmd+[" : "Alt+Left",
          click: nav((w) => w.navigationHistory.canGoBack() && w.navigationHistory.goBack()),
        },
        {
          label: "Vorwärts",
          accelerator: isMac ? "Cmd+]" : "Alt+Right",
          click: nav((w) => w.navigationHistory.canGoForward() && w.navigationHistory.goForward()),
        },
        {
          label: "Startseite",
          accelerator: "CmdOrCtrl+Shift+H",
          click: () => openServer(),
        },
        {
          label: "Im Browser öffnen",
          click: nav((w) => {
            const url = w.getURL();
            if (/^https?:/.test(url)) void shell.openExternal(url);
          }),
        },
      ],
    },
    {
      label: "Fenster",
      submenu: [
        { role: "minimize", label: "Minimieren" },
        { role: "zoom", label: "Zoomen" },
        ...(isMac ? [{ type: "separator" }, { role: "front", label: "Alle nach vorne" }] : [{ role: "close", label: "Schließen" }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle("flowplan:get-server", () => server() || "");
ipcMain.handle("flowplan:set-server", async (_event, input) => {
  const origin = normalizeServer(input);
  try {
    await checkServer(origin);
  } catch (e) {
    throw new Error(
      `Unter ${origin} wurde keine Flowplan-Instanz gefunden (${e.message}).`,
    );
  }
  writeConfig({ server: origin });
  openServer();
  return origin;
});
ipcMain.handle("flowplan:retry", () => openServer());
ipcMain.handle("flowplan:change-server", () => chooseServer());

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(() => {
    session.defaultSession.setSpellCheckerLanguages?.(["de-DE", "en-US"]);
    // Only notifications and clipboard are granted to the instance.
    session.defaultSession.setPermissionRequestHandler((wc, permission, done) => {
      done(
        sameOrigin(wc.getURL()) &&
          ["notifications", "clipboard-read", "clipboard-sanitized-write", "fullscreen"].includes(permission),
      );
    });
    trackSignIn();
    buildMenu();
    createWindow();
    app.on("activate", () => {
      if (!BrowserWindow.getAllWindows().length) createWindow();
    });
  });
  app.on("window-all-closed", () => {
    if (!isMac) app.quit();
  });
}
process.on("unhandledRejection", (error) => {
  if (app.isReady())
    dialog.showErrorBox("Flowplan", String(error?.message || error));
});
