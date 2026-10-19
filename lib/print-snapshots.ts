import { randomBytes } from "node:crypto";
import sanitize from "sanitize-html";

// Print views for iPhone and iPad apps on the home screen, which cannot print
// themselves: the browser sends the finished view (page copy, styles, images
// as data), and it is shown once more in Safari under a secret address – Safari
// there has no session. Kept in memory for a short time only.
export const PRINT_SNAPSHOT_MAX_BYTES = 40 * 1024 * 1024;
const TTL_MS = 15 * 60 * 1000;
const TOTAL_BYTES = 200 * 1024 * 1024;
const snapshots = new Map<string, { html: string; userId: string; expires: number; bytes: number }>();

function prune(now = Date.now()) {
  let total = 0;
  for (const [token, s] of snapshots) if (s.expires <= now) snapshots.delete(token);
  // Oldest first out when they take too much memory together.
  for (const [token, s] of [...snapshots].reverse()) {
    total += s.bytes;
    if (total > TOTAL_BYTES) snapshots.delete(token);
  }
}

// The view comes from the browser, so it is cleaned like any foreign HTML:
// layout, styles and pictures stay; scripts, frames, forms and their fields,
// buttons, <base> and <meta http-equiv> (redirects) and event handlers go. A
// print view has nothing to fill in; its bar with the print button is added
// when it is shown (app/api/print/[token]), naming who made it.
const BLOCKED = new Set([
  "script", "iframe", "frame", "frameset", "object", "embed", "applet", "base", "form", "noscript", "template", "portal",
  "input", "textarea", "select", "option", "optgroup", "datalist", "button", "dialog", "output", "keygen",
]);
export function cleanPrintView(html: string, marker = "") {
  const clean = sanitize(html, {
    allowedTags: false,
    allowedAttributes: false,
    allowVulnerableTags: true,
    allowedSchemes: ["http", "https", "data", "blob", "mailto", "tel"],
    parser: { lowerCaseAttributeNames: false },
    exclusiveFilter: (frame) =>
      BLOCKED.has(frame.tag.toLowerCase()) ||
      (frame.tag.toLowerCase() === "meta" && Object.keys(frame.attribs).some((name) => name.toLowerCase() === "http-equiv")),
    transformTags: {
      "*": (tagName, attribs) => {
        const kept = Object.fromEntries(
          Object.entries(attribs).filter(
            ([name, value]) =>
              !/^(on|srcdoc$|formaction$|data-print-bar$)/i.test(name) && !/^\s*(javascript|vbscript):/i.test(value),
          ),
        );
        // The real <body> gets a secret mark where the bar goes (see withBar):
        // text that merely looks like a body tag, e.g. in a style, has none.
        if (marker && tagName.toLowerCase() === "body") kept["data-print-bar"] = marker;
        return { tagName, attribs: kept };
      },
    },
  });
  return `<!doctype html>${clean}`;
}

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// The bar on top with the print button comes from here, not from the view
// sent: it says whose copy this is, so the address does not pass for a page
// of Flowplan itself.
function withBar(html: string, marker: string, author: string) {
  const en = /^<!doctype html><html[^>]*\slang="en/i.test(html);
  const t = (de: string, english: string) => (en ? english : de);
  const bar =
    `<div class="print-view-bar" style="position:relative!important;z-index:2147483647!important;visibility:visible!important;opacity:1!important">` +
    `<button type="button" class="print-view-print">${t("Drucken / PDF", "Print / PDF")}</button>` +
    `<span>${escape(t(`Druckansicht von ${author}. Oder Teilen → Drucken. Der Link gilt 15 Minuten.`, `Print view by ${author}. Or Share → Print. The link works for 15 minutes.`))}</span></div>`;
  const mark = ` data-print-bar="${marker}">`;
  const at = html.indexOf(mark);
  return at >= 0 ? `${html.slice(0, at)}>${bar}${html.slice(at + mark.length)}` : html.replace(/^<!doctype html>/, `$&${bar}`);
}

export function storePrintSnapshot(userId: string, author: string, html: string) {
  const marker = randomBytes(12).toString("hex");
  html = withBar(cleanPrintView(html, marker), marker, author);
  prune();
  // One view per person at a time: a new one replaces the previous one.
  for (const [token, s] of snapshots) if (s.userId === userId) snapshots.delete(token);
  const token = randomBytes(24).toString("base64url");
  snapshots.set(token, { html, userId, expires: Date.now() + TTL_MS, bytes: Buffer.byteLength(html) });
  prune();
  return token;
}

export function printSnapshot(token: string) {
  prune();
  return snapshots.get(token)?.html ?? null;
}
