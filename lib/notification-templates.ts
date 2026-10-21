// Chat notifications for outgoing webhooks (lib/webhooks.ts): one event
// model ("notice") rendered per platform – Slack (Block Kit), Matrix (HTML
// subset plus plain body), Microsoft Teams (Adaptive Card) and Discord
// (embeds). The message text comes from a template the workspace owner can
// change per event, with placeholders such as {title} or {url} and a small
// Markdown subset (**bold**, _italic_, `code`, [text](url), "- " lists and
// "> " quotes) that is converted to each platform's own markup.
// Client-safe: the settings show a live preview with the same renderers.
import { z } from "zod";
import { LOCALES, localeTag, translate, type Locale } from "./i18n";

export const chatFormats = ["json", "slack", "matrix", "teams", "discord"] as const;
export type ChatFormat = (typeof chatFormats)[number];

export const noticeEvents = [
  "row.created",
  "row.updated",
  "row.done",
  "form.submitted",
  "page.created",
  "comment.created",
  "mention",
  "digest.due",
] as const;
export type NoticeEvent = (typeof noticeEvents)[number];

export const placeholders = ["title", "actor", "page", "changes", "url", "text", "date", "count"] as const;

export type NoticeItem = { title: string; page: string; due: string; url: string; overdue: boolean };
// What happened, independent of the platform.
export type Notice = {
  event: NoticeEvent | "test";
  title: string;
  page: string;
  url: string;
  actor: string;
  at: string;
  changes: { name: string; value: string }[];
  text?: string;
  items?: NoticeItem[];
  // The day of a digest (YYYY-MM-DD).
  date?: string;
};

const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const validZone = (zone: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};
export const hookConfigSchema = z.object({
  language: z.enum(LOCALES as [Locale, ...Locale[]]).default("de"),
  // The daily digest of due records: local time and time zone.
  digestTime: z.string().regex(timePattern).default("08:00"),
  timeZone: z.string().max(100).refine(validZone).default("Europe/Berlin"),
  // Matrix client API: the room (!id:server or #alias:server).
  matrixRoom: z.string().trim().max(255).regex(/^[!#][^:\s]+:\S+$/).optional(),
  // Slack with a bot token: the channel ID (thread replies come back).
  slackChannel: z.string().trim().max(100).regex(/^[A-Z0-9]+$/).optional(),
});
export type HookConfig = z.infer<typeof hookConfigSchema>;
export const TEMPLATE_MAX = 2000;
export const templatesSchema = z.partialRecord(z.enum(noticeEvents), z.string().max(TEMPLATE_MAX));
export type Templates = z.infer<typeof templatesSchema>;

// Caps of single values, so every message stays within the platforms' limits.
const CAP = { title: 200, page: 200, actor: 100, text: 1000, value: 200, name: 100, changes: 10, items: 25 };
export function cap(text: string, max: number) {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, Math.max(0, max - 1)).join("").trimEnd() + "…";
}

export function eventLabel(event: NoticeEvent | "test", lang: Locale) {
  const say = translate(lang);
  switch (event) {
    case "row.created":
      return say("Neuer Eintrag", "New record");
    case "row.updated":
      return say("Eintrag geändert", "Record changed");
    case "row.done":
      return say("Eintrag erledigt", "Record done");
    case "form.submitted":
      return say("Neue Formularantwort", "New form response");
    case "page.created":
      return say("Neue Seite", "New page");
    case "comment.created":
      return say("Neuer Kommentar", "New comment");
    case "mention":
      return say("Erwähnung", "Mention");
    case "digest.due":
      return say("Heute fällig", "Due today");
    default:
      return say("Testnachricht", "Test message");
  }
}

export function defaultTemplate(event: NoticeEvent | "test", lang: Locale) {
  const say = translate(lang);
  switch (event) {
    case "row.created":
      return say("{actor} hat [{title}]({url}) in **{page}** angelegt.", "{actor} created [{title}]({url}) in **{page}**.");
    case "row.updated":
      return say("{actor} hat [{title}]({url}) in **{page}** geändert.", "{actor} changed [{title}]({url}) in **{page}**.");
    case "row.done":
      return say("[{title}]({url}) in **{page}** ist erledigt – von {actor}.", "[{title}]({url}) in **{page}** is done – by {actor}.");
    case "form.submitted":
      return say("Neue Formularantwort in **{page}**: [{title}]({url})", "New form response in **{page}**: [{title}]({url})");
    case "page.created":
      return say("{actor} hat die Seite [{title}]({url}) angelegt.", "{actor} created the page [{title}]({url}).");
    case "comment.created":
      return say("{actor} kommentiert [{title}]({url}):\n> {text}", "{actor} commented on [{title}]({url}):\n> {text}");
    case "mention":
      return say("{actor} hat {text} in [{title}]({url}) erwähnt.", "{actor} mentioned {text} in [{title}]({url}).");
    case "digest.due":
      return say("**{count} fällige oder überfällige Einträge** am {date}:\n{changes}", "**{count} due or overdue records** on {date}:\n{changes}");
    default:
      return say("Flowplan ist verbunden: [{title}]({url})", "Flowplan is connected: [{title}]({url})");
  }
}

// A sample event per type for the preview and the test message.
export function sampleNotice(event: NoticeEvent | "test", lang: Locale, base = "https://flowplan.example.org"): Notice {
  const say = translate(lang);
  const url = `${base}/#page=00000000-0000-4000-8000-000000000000&row=00000000-0000-4000-8000-000000000001`;
  const at = new Date().toISOString();
  const day = at.slice(0, 10);
  const changes = [
    { name: say("Status", "Status"), value: say("In Arbeit", "In progress") },
    { name: say("Fällig", "Due"), value: day },
  ];
  return {
    event,
    title: event === "page.created" ? say("Projektplan Q3", "Project plan Q3") : say("Website-Relaunch", "Website relaunch"),
    page: say("Projekte", "Projects"),
    url,
    actor: "Ana Example",
    at,
    changes: event === "row.updated" || event === "form.submitted" || event === "row.created" ? changes : [],
    text:
      event === "comment.created"
        ? say("Sieht gut aus – können wir **Freitag** live gehen?", "Looks good – can we go live on **Friday**?")
        : event === "mention"
          ? "Ben Example"
          : undefined,
    items:
      event === "digest.due"
        ? [
            { title: say("Angebot schicken", "Send the offer"), page: say("Vertrieb", "Sales"), due: day, url, overdue: false },
            { title: say("Rechnung prüfen", "Check the invoice"), page: say("Buchhaltung", "Accounting"), due: "2026-01-02", url, overdue: true },
          ]
        : undefined,
    date: event === "digest.due" ? day : undefined,
  };
}

/* ---------- Markdown subset ---------- */

type Inline =
  | { t: "text"; v: string }
  | { t: "b" | "i"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "link"; href: string; c: Inline[] };
type Block = { t: "line" | "quote" | "item"; c: Inline[] };

// Escapes a value so the Markdown parser takes it literally.
export function escapeMarkdown(value: string) {
  return value.replace(/[\\*_`[\]()>#~|-]/g, (c) => "\\" + c);
}
const safeHref = (href: string) => (/^(https?:\/\/|mailto:)/i.test(href) ? href : "");

function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ t: "text", v: text });
    text = "";
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\" && i + 1 < src.length) {
      text += src[++i];
      continue;
    }
    if (c === "*" && src[i + 1] === "*") {
      const end = findClose(src, "**", i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: "b", c: parseInline(src.slice(i + 2, end)) });
        i = end + 1;
        continue;
      }
    }
    if ((c === "_" || c === "*") && src[i + 1] && src[i + 1] !== " ") {
      const end = findClose(src, c, i + 1);
      if (end > i + 1 && src[end - 1] !== " ") {
        flush();
        out.push({ t: "i", c: parseInline(src.slice(i + 1, end)) });
        i = end;
        continue;
      }
    }
    if (c === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push({ t: "code", v: unescape(src.slice(i + 1, end)) });
        i = end;
        continue;
      }
    }
    if (c === "[") {
      const close = findClose(src, "]", i + 1);
      if (close > i && src[close + 1] === "(") {
        const end = closingParen(src, close + 2);
        if (end > close) {
          const href = safeHref(unescape(src.slice(close + 2, end)).trim());
          flush();
          const label = parseInline(src.slice(i + 1, close));
          // Other schemes (javascript: …) lose their link.
          if (href) out.push({ t: "link", href, c: label });
          else out.push(...label);
          i = end;
          continue;
        }
      }
    }
    text += c;
  }
  flush();
  return out;
}
// The next unescaped occurrence of `token` from `from`.
function findClose(src: string, token: string, from: number) {
  for (let i = from; i < src.length; i++) {
    if (src[i] === "\\") {
      i++;
      continue;
    }
    if (src.startsWith(token, i)) return i;
  }
  return -1;
}
// The ")" that closes a link address, allowing balanced parentheses inside.
function closingParen(src: string, from: number) {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    if (src[i] === "\\") i++;
    else if (src[i] === "(") depth++;
    else if (src[i] === ")" && depth-- === 0) return i;
  }
  return -1;
}
const unescape = (s: string) => s.replace(/\\(.)/g, "$1");

export function parseMarkdown(src: string): Block[] {
  return src
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      const quote = /^>\s?(.*)$/.exec(line);
      if (quote) return { t: "quote" as const, c: parseInline(quote[1]) };
      const item = /^[-•*]\s+(.*)$/.exec(line);
      if (item) return { t: "item" as const, c: parseInline(item[1]) };
      return { t: "line" as const, c: parseInline(line) };
    });
}

const plainInline = (nodes: Inline[]): string =>
  nodes.map((n) => (n.t === "text" || n.t === "code" ? n.v : plainInline(n.c))).join("");

type Dialect = {
  text: (s: string) => string;
  b: (s: string) => string;
  i: (s: string) => string;
  code: (s: string) => string;
  link: (href: string, label: Inline[]) => string;
};
const inlineWith = (d: Dialect) => {
  const render = (nodes: Inline[]): string =>
    nodes
      .map((n) =>
        n.t === "text" ? d.text(n.v) : n.t === "code" ? d.code(n.v) : n.t === "link" ? d.link(n.href, n.c) : n.t === "b" ? d.b(render(n.c)) : d.i(render(n.c)),
      )
      .join("");
  return render;
};

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const slackEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const discordEscape = (s: string) => s.replace(/[\\*_`~|[\]()]/g, (c) => "\\" + c);
const teamsEscape = (s: string) => s.replace(/[\\*_[\]]/g, (c) => "\\" + c);

// Slack mrkdwn: *bold*, _italic_, <url|text>.
export function toSlack(md: string) {
  const inline = inlineWith({
    text: slackEscape,
    b: (s) => `*${s}*`,
    i: (s) => `_${s}_`,
    code: (s) => "`" + slackEscape(s).replace(/`/g, "'") + "`",
    link: (href, label) => `<${slackEscape(href).replace(/\|/g, "%7C")}|${slackEscape(plainInline(label)).replace(/\|/g, "¦")}>`,
  });
  return parseMarkdown(md)
    .map((b) => (b.t === "quote" ? "> " : b.t === "item" ? "• " : "") + inline(b.c))
    .join("\n");
}

// Matrix: the HTML subset of org.matrix.custom.html.
export function toMatrixHtml(md: string) {
  const inline = inlineWith({
    text: escapeHtml,
    b: (s) => `<strong>${s}</strong>`,
    i: (s) => `<em>${s}</em>`,
    code: (s) => `<code>${escapeHtml(s)}</code>`,
    link: (href, label) => `<a href="${escapeHtml(href)}">${inline(label)}</a>`,
  });
  const out: string[] = [];
  const blocks = parseMarkdown(md);
  for (let i = 0; i < blocks.length; i++) {
    const kind = blocks[i].t;
    if (kind === "line") {
      out.push(inline(blocks[i].c) + (i < blocks.length - 1 && blocks[i + 1].t === "line" ? "<br>" : ""));
      continue;
    }
    const group: string[] = [];
    while (i < blocks.length && blocks[i].t === kind) group.push(inline(blocks[i++].c));
    i--;
    out.push(kind === "item" ? `<ul>${group.map((g) => `<li>${g}</li>`).join("")}</ul>` : `<blockquote>${group.join("<br>")}</blockquote>`);
  }
  return out.join("");
}

// Plain text (Matrix body, fallbacks): links as "text (url)".
export function toPlain(md: string) {
  const inline = inlineWith({
    text: (s) => s,
    b: (s) => s,
    i: (s) => s,
    code: (s) => s,
    link: (href, label) => {
      const text = plainInline(label);
      return text && text !== href ? `${text} (${href})` : href;
    },
  });
  return parseMarkdown(md)
    .map((b) => (b.t === "quote" ? "> " : b.t === "item" ? "- " : "") + inline(b.c))
    .join("\n");
}

// Adaptive Card TextBlock: **bold**, _italic_, [text](url) and "- " lists;
// no code or quotes (shown as plain text).
export function toTeams(md: string) {
  const inline = inlineWith({
    text: teamsEscape,
    b: (s) => `**${s}**`,
    i: (s) => `_${s}_`,
    code: teamsEscape,
    link: (href, label) => `[${teamsEscape(plainInline(label))}](${href.replace(/\)/g, "%29")})`,
  });
  // A TextBlock needs a blank line for a line break.
  return parseMarkdown(md)
    .map((b) => (b.t === "item" ? "- " : "") + inline(b.c))
    .join("\n\n");
}

// Discord: Markdown with its own escaping.
export function toDiscord(md: string) {
  const inline = inlineWith({
    text: discordEscape,
    b: (s) => `**${s}**`,
    i: (s) => `*${s}*`,
    code: (s) => "`" + s.replace(/`/g, "'") + "`",
    link: (href, label) => `[${discordEscape(plainInline(label))}](${href.replace(/\)/g, "%29")})`,
  });
  return parseMarkdown(md)
    // A line of text must not start a quote by accident.
    .map((b) => (b.t === "quote" ? "> " : b.t === "item" ? "- " : "") + inline(b.c).replace(/^>/, "\\>"))
    .join("\n");
}

/* ---------- Templates ---------- */

function formatDate(iso: string, lang: Locale, timeZone?: string) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(iso + "T12:00:00Z") : new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  try {
    return date.toLocaleString(localeTag(lang), dateOnly ? { dateStyle: "medium", timeZone: "UTC" } : { dateStyle: "medium", timeStyle: "short", timeZone });
  } catch {
    return iso;
  }
}

// The changes (or, in a digest, the due records) as a Markdown list.
function listMarkdown(notice: Notice, lang: Locale) {
  const say = translate(lang);
  if (notice.items) {
    const shown = notice.items.slice(0, CAP.items).map((item) => {
      const title = escapeMarkdown(cap(item.title || say("Ohne Titel", "Untitled"), CAP.title));
      const due = formatDate(item.due, lang);
      return `- [${title}](${item.url}) · ${escapeMarkdown(cap(item.page, CAP.page))} · ${item.overdue ? `**${say("überfällig seit", "overdue since")} ${due}**` : due}`;
    });
    const more = notice.items.length - shown.length;
    if (more > 0) shown.push(`- ${say(`… und ${more} weitere`, `… and ${more} more`)}`);
    return shown.join("\n");
  }
  const shown = notice.changes.slice(0, CAP.changes).map((c) => `- **${escapeMarkdown(cap(c.name, CAP.name))}:** ${escapeMarkdown(cap(c.value || "–", CAP.value))}`);
  const more = notice.changes.length - shown.length;
  if (more > 0) shown.push(`- ${say(`… und ${more} weitere`, `… and ${more} more`)}`);
  return shown.join("\n");
}

// Fills the placeholders: values are escaped (they never become markup),
// {changes} is a Markdown list. Unknown placeholders stay as they are.
export function fillTemplate(template: string, notice: Notice, lang: Locale) {
  const say = translate(lang);
  const values: Record<string, string> = {
    title: escapeMarkdown(cap(notice.title || say("Ohne Titel", "Untitled"), CAP.title)),
    actor: escapeMarkdown(cap(notice.actor || "Flowplan", CAP.actor)),
    page: escapeMarkdown(cap(notice.page, CAP.page)),
    url: notice.url,
    text: escapeMarkdown(cap(notice.text || "", CAP.text)).replace(/\n/g, " "),
    date: notice.date ? formatDate(notice.date, lang) : formatDate(notice.at, lang),
    count: String(notice.items?.length ?? notice.changes.length),
    changes: listMarkdown(notice, lang),
  };
  return cap(template, TEMPLATE_MAX).replace(/\{(\w+)\}/g, (all, key: string) => (Object.hasOwn(values, key) ? values[key] : all));
}

export type RenderOptions = { templates?: Templates; config?: Partial<HookConfig> };

// The message in Markdown, plus whether the changes still need a place of
// their own (the template does not use {changes}).
export function messageMarkdown(notice: Notice, options: RenderOptions = {}) {
  const lang = options.config?.language || "de";
  const template = (notice.event !== "test" && options.templates?.[notice.event]?.trim()) || defaultTemplate(notice.event, lang);
  return {
    markdown: fillTemplate(template, notice, lang),
    structured: !template.includes("{changes}") && !notice.items && notice.changes.length > 0,
  };
}

const unix = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
const contextLine = (notice: Notice, lang: Locale, timeZone?: string) =>
  `${cap(notice.actor || "Flowplan", CAP.actor)} · ${formatDate(notice.at, lang, timeZone)}`;
const header = (notice: Notice, lang: Locale) =>
  notice.page && notice.event !== "digest.due" && notice.event !== "test" ? `${eventLabel(notice.event, lang)} · ${notice.page}` : eventLabel(notice.event, lang);

export function renderSlack(notice: Notice, options: RenderOptions = {}) {
  const lang = options.config?.language || "de";
  const { markdown, structured } = messageMarkdown(notice, options);
  const mrkdwn = cap(toSlack(markdown), 3000);
  const blocks: Record<string, unknown>[] = [
    { type: "header", text: { type: "plain_text", text: cap(header(notice, lang), 150), emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: mrkdwn } },
  ];
  if (structured)
    blocks.push({
      type: "section",
      fields: notice.changes.slice(0, CAP.changes).map((c) => ({
        type: "mrkdwn",
        text: cap(`*${slackEscape(cap(c.name, CAP.name))}*\n${slackEscape(cap(c.value || "–", CAP.value))}`, 2000),
      })),
    });
  const when = formatDate(notice.at, lang, options.config?.timeZone);
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `${slackEscape(cap(notice.actor || "Flowplan", CAP.actor))} · <!date^${unix(notice.at)}^{date_short_pretty} {time}|${slackEscape(when)}>`,
      },
    ],
  });
  return { text: cap(toPlain(markdown), 3000), blocks, unfurl_links: false };
}

export function renderMatrix(notice: Notice, options: RenderOptions = {}) {
  const lang = options.config?.language || "de";
  const { markdown, structured } = messageMarkdown(notice, options);
  const changes = structured ? "\n" + listMarkdown({ ...notice, items: undefined }, lang) : "";
  const full = `**${escapeMarkdown(header(notice, lang))}**\n${markdown}${changes}`;
  const context = contextLine(notice, lang, options.config?.timeZone);
  const body = cap(`${toPlain(full)}\n${context}`, 8000);
  const html = `${toMatrixHtml(full)}<br><sub>${escapeHtml(context)}</sub>`;
  return { msgtype: "m.notice", body, format: "org.matrix.custom.html", formatted_body: html };
}

export function renderTeams(notice: Notice, options: RenderOptions = {}) {
  const lang = options.config?.language || "de";
  const say = translate(lang);
  const { markdown, structured } = messageMarkdown(notice, options);
  const body: Record<string, unknown>[] = [
    { type: "TextBlock", text: cap(teamsEscape(header(notice, lang)), 400), weight: "Bolder", size: "Medium", wrap: true },
    { type: "TextBlock", text: cap(toTeams(markdown), 4000), wrap: true },
  ];
  if (structured)
    body.push({
      type: "FactSet",
      facts: notice.changes.slice(0, CAP.changes).map((c) => ({ title: cap(c.name, CAP.name), value: cap(c.value || "–", CAP.value) })),
    });
  body.push({ type: "TextBlock", text: teamsEscape(contextLine(notice, lang, options.config?.timeZone)), isSubtle: true, size: "Small", spacing: "Small", wrap: true });
  const card = {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.4",
    body,
    ...(notice.url ? { actions: [{ type: "Action.OpenUrl", title: say("In Flowplan öffnen", "Open in Flowplan"), url: notice.url }] } : {}),
  };
  return { type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", contentUrl: null, content: card }] };
}

export function renderDiscord(notice: Notice, options: RenderOptions = {}) {
  const lang = options.config?.language || "de";
  const { markdown, structured } = messageMarkdown(notice, options);
  // Discord allows 6000 characters per message across all embed texts.
  const embed: Record<string, unknown> = {
    title: cap(header(notice, lang), 256),
    description: cap(toDiscord(markdown), 2500),
    color: 0x4f6bed,
    footer: { text: cap(notice.actor || "Flowplan", CAP.actor) },
    timestamp: new Date(notice.at).toISOString(),
  };
  if (notice.url) embed.url = notice.url;
  if (structured)
    embed.fields = notice.changes.slice(0, CAP.changes).map((c) => ({ name: cap(c.name, CAP.name), value: cap(c.value || "–", CAP.value), inline: true }));
  return { username: "Flowplan", embeds: [embed], allowed_mentions: { parse: [] } };
}

// The body a webhook of the given format receives. JSON webhooks get the
// event envelope unchanged (lib/webhooks.ts builds it).
export function renderPayload(format: Exclude<ChatFormat, "json">, notice: Notice, options: RenderOptions = {}): Record<string, unknown> {
  switch (format) {
    case "slack":
      return renderSlack(notice, options);
    case "matrix":
      return renderMatrix(notice, options);
    case "teams":
      return renderTeams(notice, options);
    case "discord":
      return renderDiscord(notice, options);
  }
}

// Matrix client API: the address of one message (txn makes retries idempotent).
export function matrixSendUrl(homeserver: string, room: string, txn: string) {
  return `${homeserver.replace(/\/+$/, "")}/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/${encodeURIComponent(txn)}`;
}
// A room webhook (e.g. hookshot) reads `text`/`html`; the event fields are
// sent along for bridges that pass them on unchanged.
export function matrixWebhookBody(content: ReturnType<typeof renderMatrix>) {
  return { text: content.body, html: content.formatted_body, ...content };
}
export const SLACK_POST_MESSAGE = "https://slack.com/api/chat.postMessage";
