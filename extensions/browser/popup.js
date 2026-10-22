// Flowplan web clipper – the popup: connecting (instance address and API
// token; access to that one origin is requested only then), the target
// picker (remembered), tags and the three ways to save.
/* global FlowplanApi */
const { ext, msg, connection, normalizeInstance, request, collect, save } = FlowplanApi;
const $ = (id) => document.getElementById(id);
const status = (text, link) => {
  const el = $("status");
  el.textContent = text || "";
  if (link) {
    const a = document.createElement("a");
    a.href = link;
    a.textContent = msg("openSaved");
    a.addEventListener("click", (e) => {
      e.preventDefault();
      void ext.tabs.create({ url: link });
    });
    el.append(" ", a);
  }
};

for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = msg(el.dataset.i18n);
document.documentElement.lang = ext.i18n.getUILanguage();

let targets = new Map();

async function activeTab() {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function showSetup(instance) {
  $("setup").hidden = false;
  $("clip").hidden = true;
  $("disconnect").hidden = true;
  if (instance) $("instance").value = instance;
}

async function showClip() {
  $("setup").hidden = true;
  $("clip").hidden = false;
  $("disconnect").hidden = false;
  const tab = await activeTab();
  $("title").value = (tab && tab.title) || "";
  status("");
  const data = await request("/api/clipper/targets");
  $("who").textContent = msg("connectedAs", [data.user.name]);
  const select = $("target");
  select.textContent = "";
  targets = new Map();
  for (const workspace of data.workspaces) {
    const spaces = document.createElement("optgroup");
    spaces.label = msg("spacesGroup", [workspace.name]);
    for (const space of workspace.spaces) {
      const key = `space:${space.id}`;
      targets.set(key, { workspaceId: workspace.id, spaceId: space.id });
      spaces.append(new Option(msg("newPageIn", [space.name]), key));
    }
    if (workspace.spaces.length) select.append(spaces);
    if (!workspace.pages.length) continue;
    const pages = document.createElement("optgroup");
    pages.label = msg("pagesGroup", [workspace.name]);
    for (const page of workspace.pages) {
      const key = `page:${page.id}`;
      targets.set(key, { workspaceId: workspace.id, pageId: page.id, kind: page.kind });
      pages.append(new Option(`${page.kind === "database" ? "▦" : "▤"} ${page.title || "–"}`, key));
    }
    select.append(pages);
  }
  if (!targets.size) throw new Error(msg("errorNoTargets"));
  const { target } = await ext.storage.local.get("target");
  const remembered = target && [...targets].find(([, t]) => (target.pageId ? t.pageId === target.pageId : t.spaceId === target.spaceId));
  if (remembered) select.value = remembered[0];
  await ext.storage.local.set({ target: targets.get(select.value) });
}

$("target").addEventListener("change", () => void ext.storage.local.set({ target: targets.get($("target").value) }));

$("setup").addEventListener("submit", async (e) => {
  e.preventDefault();
  status("");
  try {
    const instance = normalizeInstance($("instance").value);
    const token = $("token").value.trim();
    // Host access only for this instance, asked for now (user gesture).
    const granted = await ext.permissions.request({ origins: [`${instance}/*`] });
    if (!granted) throw new Error(msg("errorPermission"));
    await request("/api/clipper/targets", {}, { instance, token });
    await ext.storage.local.set({ instance, token });
    $("token").value = "";
    await showClip();
  } catch (error) {
    status(error.message);
  }
});

$("open-instance").addEventListener("click", () => {
  try {
    void ext.tabs.create({ url: `${normalizeInstance($("instance").value)}/` });
  } catch (error) {
    status(error.message);
  }
});

$("disconnect").addEventListener("click", async () => {
  const conn = await connection();
  await ext.storage.local.remove(["token", "target", "highlightPages"]);
  if (conn) await ext.permissions.remove({ origins: [`${conn.instance}/*`] }).catch(() => {});
  showSetup(conn && conn.instance);
});

for (const button of document.querySelectorAll("[data-mode]"))
  button.addEventListener("click", async () => {
    const mode = button.dataset.mode;
    const buttons = document.querySelectorAll("[data-mode]");
    buttons.forEach((b) => (b.disabled = true));
    status(msg("saving"));
    try {
      const tab = await activeTab();
      const data = await collect(tab, mode);
      if (mode === "selection" && !data.html && !data.text) throw new Error(msg("errorNoSelection"));
      const tags = $("tags")
        .value.split(",")
        .map((t) => t.trim().replace(/^#/, ""))
        .filter(Boolean)
        .slice(0, 20);
      const result = await save(mode, data, targets.get($("target").value), { title: $("title").value.trim(), tags });
      status(msg("saved"), result.url);
    } catch (error) {
      status(error.message);
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  });

(async () => {
  const conn = await connection();
  if (!conn) return showSetup();
  try {
    await showClip();
  } catch (error) {
    status(error.message);
    if (/401|token/i.test(error.message)) showSetup(conn.instance);
  }
})();
