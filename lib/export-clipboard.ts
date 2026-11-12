// Exports to the clipboard instead of a file (#220): the text formats of the
// export dialog (Markdown, Jira, Confluence, HTML, database JSON). Browser
// code without React, so tests can run it with a stand-in clipboard.
import { tr } from "./locale-tag";

export type ClipboardText = { text: string; html?: string };

// Puts an export on the clipboard. Called right in the click: the clipboard
// is asked at once with the text still on its way (a ClipboardItem with
// promises), since Safari and the WebKit of the iPhone app allow it only
// during the person's own action. Where that is not available, the text is
// written once it is there. `html`: the content also goes as text/html, so
// rich-text editors and mail paste it formatted.
export async function copyExport(content: Promise<ClipboardText>, html = false) {
  const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  // The export's own error is reported below, not as unhandled.
  content.catch(() => {});
  if (!clipboard) {
    await content;
    throw new Error(tr("Die Zwischenablage ist hier nicht verfügbar.", "The clipboard is not available here."));
  }
  if (typeof ClipboardItem !== "undefined" && typeof clipboard.write === "function") {
    try {
      const parts: Record<string, Promise<Blob>> = {
        "text/plain": content.then((c) => new Blob([c.text], { type: "text/plain" })),
      };
      if (html) parts["text/html"] = content.then((c) => new Blob([c.html ?? c.text], { type: "text/html" }));
      await clipboard.write([new ClipboardItem(parts)]);
      return;
    } catch {
      // The export's own failure wins over the clipboard's.
      await content;
    }
  }
  const { text } = await content;
  try {
    await clipboard.writeText(text);
  } catch {
    throw new Error(tr("Kopieren in die Zwischenablage nicht möglich. Bitte als Datei exportieren.", "Could not copy to the clipboard. Please export as a file."));
  }
}

// Addresses of this instance in HTML ("/api/files/…", "/#page=…") as full
// addresses: pasted elsewhere they still lead back to Flowplan.
export function absoluteLinks(html: string, origin: string) {
  return html.replace(/(\s(?:src|href)=")(\/(?!\/)[^"]*)"/g, (_, attr: string, path: string) => `${attr}${origin}${path}"`);
}

// The last choice of file or clipboard, per device.
export type ExportDestination = "file" | "clipboard";
export const DESTINATION_KEY = "flowplan:export-destination";
export function storedDestination(): ExportDestination {
  try {
    return localStorage.getItem(DESTINATION_KEY) === "clipboard" ? "clipboard" : "file";
  } catch {
    return "file";
  }
}
export function storeDestination(value: ExportDestination) {
  try {
    localStorage.setItem(DESTINATION_KEY, value);
  } catch {}
}
