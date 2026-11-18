import { createHash, randomBytes } from "node:crypto";
import sanitize from "sanitize-html";
import { all, one, run } from "./db";
import { staging } from "./staging";

// Print views for iPhone and iPad apps on the home screen, which cannot print
// themselves: the browser sends the finished view (page copy, styles, images
// as data), and it is shown once more in Safari under a secret address – Safari
// there has no session. Kept for 15 minutes, one per person.
//
// Shared by every instance (cluster mode: the Safari request may reach
// another instance than the one that stored the view): a row in
// print_snapshots by the SHA-256 of the token (the token itself is never
// stored), the person, the size and the expiry. A view carries its pictures
// as data and may be up to 40 MB: up to INLINE_BYTES it sits in the row,
// larger ones in the staging area (lib/staging.ts, area "print": the data
// folder of a single container, the bucket – sealed – in cluster mode), so
// the database does not carry tens of megabytes per print.
export const PRINT_SNAPSHOT_MAX_BYTES = 40 * 1024 * 1024;
export const PRINT_SNAPSHOT_INLINE_BYTES = 512 * 1024;
const TTL_MS = 15 * 60 * 1000;
const parts = () => staging("print");
const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

// Expired views go (rows and staged copies): when a view is stored, and in
// the leader's sweep (lib/admin-ops.ts). A staged copy whose row is gone
// (an instance stopped between the two writes) goes once it is older than
// the view could live.
export async function sweepPrintSnapshots(now = Date.now(), options: { orphans?: boolean } = {}) {
  const expired = await all<{ token_hash: string; html: string | null }>("SELECT token_hash,html FROM print_snapshots WHERE expires_at<=?", now);
  for (const row of expired) {
    await run("DELETE FROM print_snapshots WHERE token_hash=?", row.token_hash);
    if (row.html === null) await parts().removeObject(row.token_hash);
  }
  if (!options.orphans) return;
  for (const object of await parts().list("")) {
    if (now - object.at < 2 * TTL_MS) continue;
    if (!(await one("SELECT 1 AS ok FROM print_snapshots WHERE token_hash=?", object.name))) await parts().removeObject(object.name);
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

export async function storePrintSnapshot(userId: string, author: string, html: string, now = Date.now()) {
  const marker = randomBytes(12).toString("hex");
  html = withBar(cleanPrintView(html, marker), marker, author);
  await sweepPrintSnapshots(now);
  // One view per person at a time: a new one replaces the previous one.
  for (const old of await all<{ token_hash: string; html: string | null }>("SELECT token_hash,html FROM print_snapshots WHERE user_id=?", userId)) {
    await run("DELETE FROM print_snapshots WHERE token_hash=?", old.token_hash);
    if (old.html === null) await parts().removeObject(old.token_hash);
  }
  const token = randomBytes(24).toString("base64url");
  const hash = hashOf(token);
  const bytes = Buffer.byteLength(html);
  const inline = bytes <= PRINT_SNAPSHOT_INLINE_BYTES;
  // The copy first, then the row: a row always finds its copy.
  if (!inline) await parts().put(hash, Buffer.from(html, "utf8"));
  await run(
    "INSERT INTO print_snapshots(token_hash,user_id,html,bytes,created_at,expires_at) VALUES(?,?,?,?,?,?)",
    hash,
    userId,
    inline ? html : null,
    bytes,
    now,
    now + TTL_MS,
  );
  return token;
}

export async function printSnapshot(token: string, now = Date.now()): Promise<string | null> {
  if (!/^[\w-]{16,64}$/.test(token)) return null;
  const hash = hashOf(token);
  const row = await one<{ html: string | null; expires_at: number }>("SELECT html,expires_at FROM print_snapshots WHERE token_hash=?", hash);
  if (!row || Number(row.expires_at) <= now) return null;
  if (row.html !== null) return row.html;
  return (await parts().get(hash))?.toString("utf8") ?? null;
}
