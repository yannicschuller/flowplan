// Formatted messages of notifications (#330): the optional message of a
// workflow's "Notify a person" step and of a database rule's notification.
// Inline Markdown in the dialect of form descriptions (lib/form-text.ts,
// #306) – bold, italic, underline, strike, code, links (http, https,
// mailto), line breaks – plus mentions of members ([@Anna]{data-mention=
// <id>}) and inline formulas ($x^2$), see lib/inline-markdown.ts. Text
// colours are not part of it.
//
// A workflow's message is a template (lib/workflows/placeholders.ts) whose
// text is this Markdown: placeholders are atoms while it is parsed (slots),
// and their values are put in as text afterwards – a value is never read as
// Markdown, so a record title with "**", "$", "[x](…)" or "@" stays literal,
// and neither trigger data nor an AI answer can add a link or a mention.
// A link whose address holds a placeholder keeps it only behind an address
// the author wrote (https://host/… or mailto:), with the value encoded.
//
// A mention shows a person; it notifies nobody (the recipients are the
// step's "To"). When a notification is made, mentions of people who are no
// longer members become plain text, the others take the current name.
//
// Channels: the inbox renders the Markdown (components/notification-
// text.tsx, never as HTML); e-mails get escaped HTML (notifyHtml); push,
// chat apps, widgets and the API read the plain text (notifyPlain), stored
// as the notification's body as before.
import { escapeInline, isAtom, mergeRuns, parseInline, safeHref, serializeInline, slotMarker, type InlineOptions, type InlineRun } from "./inline-markdown";

export const NOTIFY_TEXT: InlineOptions = { spans: true, mentions: true, math: true };
const WITH_SLOTS: InlineOptions = { ...NOTIFY_TEXT, slots: true };
// The stored message as the editor and the API write it.
export const MAX_NOTIFY_MARKUP = 4000;

type Clean = { links?: boolean; mentions?: boolean };

// The marks a notification knows: no colours; links and mentions only
// where allowed (an AI-written workflow gets neither).
function tidy(runs: InlineRun[], options: Clean = {}): InlineRun[] {
  return runs.map((run) => {
    const out: InlineRun = { ...run };
    delete out.color;
    if (options.links === false) delete out.href;
    if (out.mention && options.mentions === false) delete out.mention;
    if (out.math) {
      delete out.code;
      delete out.href;
    }
    if (out.mention) delete out.code;
    return out;
  });
}

const plainRun = (run: InlineRun) => !run.bold && !run.italic && !run.strike && !run.code && !run.href && !run.underline && !run.mention && !run.math;
export const hasNotifyMarkup = (runs: InlineRun[]) => runs.some((r) => !plainRun(r));

/* ---------- Templates: placeholders as slots ---------- */

// A template in pieces – text (its escapes resolved) and placeholders as
// written – without checking the placeholders (the editor shows what is
// typed; lib/workflows/placeholders.ts checks).
export type Piece = { text: string } | { raw: string };
export function templatePieces(template: string): Piece[] {
  const out: Piece[] = [];
  let buf = "";
  let i = 0;
  const flush = () => {
    if (buf) out.push({ text: buf });
    buf = "";
  };
  while (i < template.length) {
    const ch = template[i];
    if (ch === "\\" && template[i + 1] === "\\") {
      buf += "\\";
      i += 2;
    } else if (ch === "\\" && template[i + 1] === "{" && template[i + 2] === "{") {
      buf += "{{";
      i += 3;
    } else if (ch === "{" && template[i + 1] === "{") {
      // Up to "}}", quoted filter arguments skipped.
      let j = i + 2,
        quoted = false;
      for (; j < template.length; j++) {
        const c = template[j];
        if (quoted) {
          if (c === "\\") j++;
          else if (c === '"') quoted = false;
        } else if (c === '"') quoted = true;
        else if (c === "}" && template[j + 1] === "}") break;
      }
      if (j >= template.length) {
        buf += template.slice(i);
        break;
      }
      flush();
      out.push({ raw: template.slice(i, j + 2) });
      i = j + 2;
    } else {
      buf += ch;
      i++;
    }
  }
  flush();
  return out;
}
const escapeTemplateText = (s: string) => s.replace(/\\/g, "\\\\").replace(/\{\{/g, "\\{{");
const stripMarkers = (s: string) => s.replace(/[]/g, "");

// A template → runs; placeholders are slots (`raws[slot]` is the
// placeholder as written).
export function templateRuns(template: string): { runs: InlineRun[]; raws: string[] } {
  const raws: string[] = [];
  let source = "";
  for (const piece of templatePieces(template || "")) {
    if ("raw" in piece) {
      source += slotMarker(raws.length);
      raws.push(piece.raw);
    } else source += stripMarkers(piece.text);
  }
  return { runs: tidy(parseInline(source, WITH_SLOTS)), raws };
}

// Runs (slots for placeholders) → a template.
export function runsTemplate(runs: InlineRun[], raws: string[]): string {
  const markdown = serializeInline(tidy(runs), NOTIFY_TEXT);
  return markdown
    .split(/(\d+)/)
    .map((part) => {
      const slot = /^(\d+)$/.exec(part);
      return slot ? raws[Number(slot[1])] || "" : escapeTemplateText(part);
    })
    .join("");
}

// The stored form of a message (saving a workflow, a rule, the API):
// formatting as the editor writes it, unsafe links reduced to their label,
// colours dropped; with `{ links: false, mentions: false }` (a workflow the
// AI wrote) without links and mentions. A message without any formatting
// stays exactly as written. `template: false`: a database rule's message,
// which has no placeholders.
export function cleanNotifyMessage(value: string, options: Clean & { template?: boolean } = {}): string {
  if (typeof value !== "string" || !value) return "";
  if (options.template === false) {
    const runs = tidy(parseInline(value, NOTIFY_TEXT), options);
    if (!hasNotifyMarkup(runs) && runs.map((r) => r.text).join("") === value.replace(/\r\n?/g, "\n")) return value;
    return serializeInline(runs, NOTIFY_TEXT);
  }
  const { runs, raws } = templateRuns(value);
  const cleaned = tidy(runs, options);
  const pieces = templatePieces(value);
  const plainText = pieces.map((p) => ("raw" in p ? "" : p.text)).join("");
  // Plain: the text reads back as itself (no Markdown in it).
  if (!hasNotifyMarkup(cleaned) && cleaned.map((r) => (r.slot !== undefined ? "" : r.text)).join("") === plainText.replace(/\r\n?/g, "\n")) return value;
  return runsTemplate(cleaned, raws);
}

/* ---------- Rendering a message ---------- */

// Where a placeholder may stand in a link's address: behind an address the
// author wrote (scheme and host, or mailto:).
const FIXED_ADDRESS = /^(?:https?:\/\/[^/?#]+[/?#]|mailto:)/i;

// A message with its placeholders' values (`value(raw)` renders one
// placeholder as text) → runs. Values become text with the marks around
// them, never Markdown; `members` (id → current name) decides which
// mentions stay.
export function renderNotifyRuns(message: string, options: { template: boolean; value?: (raw: string) => string; members: Map<string, string> }): InlineRun[] {
  let runs: InlineRun[];
  let values: string[] = [];
  if (options.template) {
    const parsed = templateRuns(message);
    runs = parsed.runs;
    values = parsed.raws.map((raw) => (options.value ? options.value(raw) : ""));
  } else runs = tidy(parseInline(message || "", NOTIFY_TEXT));
  const fill = (s: string, encode: (v: string) => string = (v) => v) => s.replace(/(\d+)/g, (_, n: string) => encode(values[Number(n)] ?? ""));
  const hasSlot = (s: string | undefined) => !!s && /\d+/.test(s);
  const out: InlineRun[] = [];
  for (const run of runs) {
    const next: InlineRun = { ...run };
    if (hasSlot(next.href)) {
      const href = next.href!;
      const first = href.indexOf("");
      next.href = FIXED_ADDRESS.test(href.slice(0, first)) ? safeHref(fill(href, encodeURIComponent)) : undefined;
      if (!next.href) delete next.href;
    }
    if (next.slot !== undefined) {
      next.text = values[next.slot] ?? "";
      delete next.slot;
    } else if (next.math && hasSlot(next.text)) {
      // A formula with a value in it: shown as its source text.
      next.text = `$${fill(next.text)}$`;
      delete next.math;
    } else if (next.mention && hasSlot(next.text)) {
      next.text = fill(next.text);
      delete next.mention;
    } else next.text = fill(next.text);
    if (next.mention) {
      const name = options.members.get(next.mention);
      if (name) next.text = `@${name}`;
      else delete next.mention;
    }
    if (next.text) out.push(next);
  }
  return mergeRuns(out);
}

/* ---------- Channels ---------- */

// The Markdown of runs (the notification's `markup`).
export const notifyMarkup = (runs: InlineRun[]) => serializeInline(runs, NOTIFY_TEXT);
// Plain text in the Markdown of a notification (a title, a record's name).
export const notifyEscape = (text: string) => escapeInline(text, NOTIFY_TEXT);
export const parseNotify = (markup: unknown) => tidy(parseInline(markup, NOTIFY_TEXT));

// The plain text (push, chat apps, widgets, the API): a formula as its
// LaTeX, a mention as "@Name", a link as "label (address)" unless the
// label is the address.
export function notifyPlain(input: string | InlineRun[]): string {
  const runs = typeof input === "string" ? parseNotify(input) : input;
  let out = "";
  for (let i = 0; i < runs.length; ) {
    const href = runs[i].href;
    let j = i;
    let label = "";
    while (j < runs.length && runs[j].href === href && (href || j === i)) label += runs[j++].text;
    if (!href) {
      out += label;
      i = j;
      continue;
    }
    const bare = href.replace(/^mailto:/i, "").replace(/^https?:\/\//i, "").replace(/\/$/, "");
    const shown = label.trim().replace(/^https?:\/\//i, "").replace(/\/$/, "");
    out += shown === bare || label.trim() === href ? label : `${label} (${href.replace(/^mailto:/i, "")})`;
    i = j;
  }
  return out;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Escaped HTML for e-mails: marks as tags, links with their address, a
// mention as plain "@Name", a formula as its LaTeX in code style. Styles
// are inline (mail clients; `linkStyle` from lib/mail.ts), never from
// the text.
export function notifyHtml(markup: string, linkStyle = ""): string {
  const runs = parseNotify(markup);
  let out = "";
  for (let i = 0; i < runs.length; ) {
    const href = runs[i].href;
    let j = i;
    let inner = "";
    while (j < runs.length && runs[j].href === href && (href || j === i)) {
      const run = runs[j++];
      let html = esc(run.text).replace(/\n/g, "<br>");
      if (run.math) html = `<code style="font-family:Menlo,Consolas,monospace;font-size:90%;background:#f1f1f4;border-radius:4px;padding:0 3px">$${html}$</code>`;
      else if (run.code) html = `<code style="font-family:Menlo,Consolas,monospace;font-size:90%;background:#f1f1f4;border-radius:4px;padding:0 3px">${html}</code>`;
      if (run.strike) html = `<s>${html}</s>`;
      if (run.underline) html = `<u>${html}</u>`;
      if (run.italic) html = `<em>${html}</em>`;
      if (run.bold) html = `<strong>${html}</strong>`;
      inner += html;
    }
    out += href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer"${linkStyle ? ` style="${esc(linkStyle)}"` : ""}>${inner}</a>` : inner;
    i = j;
  }
  return out;
}

export { isAtom };

// The messages of a workflow's "Notify a person" steps, cleaned for
// storing (activating, a draft from the API, the AI's workflows).
export function cleanNotifyGraph<G extends { nodes: { type: string; config: Record<string, unknown> }[] }>(graph: G, options: Clean = {}): G {
  return {
    ...graph,
    nodes: graph.nodes.map((n) =>
      n.type === "notify.person" && typeof n.config?.message === "string"
        ? { ...n, config: { ...n.config, message: cleanNotifyMessage(n.config.message, { ...options, template: n.config.kind !== "automation" }) } }
        : n,
    ),
  };
}
