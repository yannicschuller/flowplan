// Flowplan web clipper – shared by the popup and the background script:
// the stored connection (instance address and API token), requests to the
// two clipper endpoints and reading the active tab.
(function (root) {
  "use strict";
  const ext = root.browser || root.chrome;
  const msg = (key, substitutions) => (ext.i18n && ext.i18n.getMessage(key, substitutions)) || key;

  async function connection() {
    const stored = await ext.storage.local.get(["instance", "token"]);
    return stored.instance && stored.token ? { instance: stored.instance, token: stored.token } : null;
  }

  // https only, except for an instance on this computer.
  function normalizeInstance(input) {
    let value = String(input || "").trim();
    if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
    const url = new URL(value);
    if (url.protocol !== "https:" && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname)) throw new Error(msg("errorHttps"));
    return url.origin;
  }

  async function request(path, options = {}, override) {
    const conn = override || (await connection());
    if (!conn) throw new Error(msg("errorNotConnected"));
    let response;
    try {
      response = await fetch(conn.instance + path, {
        method: options.body ? "POST" : "GET",
        headers: { Authorization: `Bearer ${conn.token}`, ...(options.body ? { "Content-Type": "application/json" } : {}) },
        body: options.body ? JSON.stringify(options.body) : undefined,
        // The token is the only credential; cookies of the instance stay out.
        credentials: "omit",
        cache: "no-store",
      });
    } catch {
      throw new Error(msg("errorNetwork"));
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  // Reads the tab with extract.js (injected only now, thanks to activeTab).
  async function collect(tab, mode) {
    try {
      await ext.scripting.executeScript({ target: { tabId: tab.id }, files: ["extract.js"] });
      const [result] = await ext.scripting.executeScript({
        target: { tabId: tab.id },
        func: (m) => globalThis.FlowplanExtract.collect(m),
        args: [mode],
      });
      if (result && result.result) return result.result;
    } catch {
      // Browser pages and the web store cannot be read.
    }
    if (mode === "bookmark") return { url: tab.url || "", title: tab.title || "", description: "", favicon: /^https:/.test(tab.favIconUrl || "") ? tab.favIconUrl : "" };
    throw new Error(msg("errorUnreadable"));
  }

  // Highlights from a page saved into a space go to one page per source.
  async function highlightPage(url) {
    const { highlightPages = {} } = await ext.storage.local.get("highlightPages");
    return highlightPages[url] || null;
  }
  async function rememberHighlightPage(url, pageId) {
    const { highlightPages = {} } = await ext.storage.local.get("highlightPages");
    highlightPages[url] = pageId;
    const keys = Object.keys(highlightPages);
    for (const key of keys.slice(0, Math.max(0, keys.length - 200))) delete highlightPages[key];
    await ext.storage.local.set({ highlightPages });
  }

  // Saves a clip to the remembered target.
  async function save(mode, data, target, extra = {}) {
    if (!target) throw new Error(msg("errorNoTarget"));
    let chosen = { workspaceId: target.workspaceId, ...(target.pageId ? { pageId: target.pageId } : { spaceId: target.spaceId }) };
    if (mode === "highlight" && !target.pageId) {
      const page = await highlightPage(data.url);
      if (page) chosen = { workspaceId: target.workspaceId, pageId: page };
    }
    const body = {
      mode,
      target: chosen,
      url: data.url,
      title: extra.title || data.title || "",
      description: data.description || "",
      favicon: data.favicon || "",
      html: data.html || "",
      text: data.text || "",
      tags: extra.tags || [],
    };
    let result;
    try {
      result = await request("/api/clipper/save", { body });
    } catch (error) {
      // The page for this source's highlights may be gone: start a new one.
      if (mode !== "highlight" || chosen.spaceId || target.pageId) throw error;
      body.target = { workspaceId: target.workspaceId, spaceId: target.spaceId };
      result = await request("/api/clipper/save", { body });
    }
    if (mode === "highlight" && !target.pageId) await rememberHighlightPage(data.url, result.pageId);
    return result;
  }

  root.FlowplanApi = { ext, msg, connection, normalizeInstance, request, collect, save };
})(globalThis);
