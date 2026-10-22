// Flowplan web clipper – background: the context menu "In Flowplan
// markieren" and the keyboard shortcut for highlights. Selected text goes to
// the target chosen last in the popup, as a quote with a link to the page.
// Chromium runs this as a service worker (api.js via importScripts), Firefox
// as an event page (api.js listed before it in the manifest).
if (typeof importScripts === "function" && typeof FlowplanApi === "undefined") importScripts("api.js");
/* global FlowplanApi */
const { ext, msg, collect, save } = FlowplanApi;

ext.runtime.onInstalled.addListener(() => {
  ext.contextMenus.create({ id: "flowplan-highlight", title: msg("menuHighlight"), contexts: ["selection"] });
});

async function badge(text, color) {
  try {
    await ext.action.setBadgeBackgroundColor({ color });
    await ext.action.setBadgeText({ text });
    setTimeout(() => void ext.action.setBadgeText({ text: "" }), 3000);
  } catch {}
}

async function highlight(tab, fallbackText) {
  try {
    const { target } = await ext.storage.local.get("target");
    let data;
    try {
      data = await collect(tab, "highlight");
    } catch {
      data = { url: tab.url, title: tab.title, html: "", text: fallbackText || "" };
    }
    if (!data.html && !data.text && fallbackText) data.text = fallbackText;
    if (!data.html && !data.text) throw new Error(msg("errorNoSelection"));
    await save("highlight", data, target);
    await badge("✓", "#2f855a");
  } catch (error) {
    console.warn("Flowplan:", error && error.message);
    await badge("!", "#c53030");
  }
}

ext.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "flowplan-highlight" && tab) void highlight(tab, info.selectionText);
});

ext.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "highlight-selection") return;
  const active = tab || (await ext.tabs.query({ active: true, currentWindow: true }))[0];
  if (active) void highlight(active);
});
