// A template as it goes to the marketplace (docs: Marketplace,
// docs/specs/flashcards.md §8.4): what is about the people of this
// instance stays here – for every kind of template (#345; documents,
// notebooks and databases here, workflows and whiteboards in
// lib/marketplace-package.ts with the same cleaner). A saved template keeps
// what the page had – for templates within the workspace that is fine, a
// published package is public:
//
// - records: only id, values, document and position (not who made or
//   changed them, when, their number, access or the viewer's role);
// - values of person properties (person, created_by, updated_by) and the
//   timestamps of created_at/updated_at, in records and record templates;
// - mentions of people in documents (`<span data-mention>`, and the
//   `[@Anna]{data-mention=<id>}` of plain texts) become the plain text
//   "@Person" – a task assigned that way loses its assignee, its due date
//   stays; comment anchors (`data-comment-thread`) go, should any be there;
// - page properties of a person type in `meta`;
// - every other string that is exactly the id or the e-mail address of a
//   member of the workspace (filters of views, form settings …) is
//   removed; inside longer texts (a document, a note) both are cut out.
//
// Links to pages stay as they are (importing a template rewrites the ones
// to its own page). Learning states never were in a template (they belong
// to people, tables card_states/review_log); a deck's mapping
// (settings.study) stays. Comments are not part of a template either.
// Pure – the caller reads the members.
import { Parser } from "htmlparser2";

const PERSON_TYPES = new Set(["person", "created_by", "updated_by", "created_at", "updated_at"]);
const PERSON_PROPERTY_TYPES = new Set(["person", "created_by", "updated_by"]);
type Content = {
  html?: unknown;
  database?: { fields?: { id?: unknown; type?: unknown }[] };
  rows?: { id?: unknown; cells?: Record<string, unknown>; content?: unknown; position?: unknown }[];
  rowTemplates?: { cells?: Record<string, unknown>; html?: unknown }[];
  meta?: { properties?: { type?: unknown }[] };
  [key: string]: unknown;
};
export type People = { ids: Set<string>; emails: Set<string> };
export type Stripped = { content: Content; cleared: number };

// What a mention of a person becomes – content, the same in every language.
export const PERSON_PLACEHOLDER = "@Person";

// Mentions out of a document: the whole span (its text is the person's
// name) becomes the plain text "@Person"; comment anchors go.
export function withoutMentions(html: string): { html: string; count: number } {
  if (!html || (!html.includes("data-mention") && !html.includes("data-comment-thread"))) return { html: html || "", count: 0 };
  const cuts: { start: number; end: number }[] = [];
  const stack: (number | null)[] = [];
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (name !== "span") return;
        stack.push("data-mention" in attributes ? parser.startIndex : null);
      },
      onclosetag(name, implied) {
        if (name !== "span") return;
        const start = stack.pop();
        if (start === null || start === undefined) return;
        cuts.push({ start, end: implied ? parser.startIndex : parser.endIndex + 1 });
      },
    },
    { decodeEntities: true, recognizeSelfClosing: true },
  );
  parser.write(html);
  parser.end();
  let out = "",
    at = 0;
  for (const c of cuts.sort((a, b) => a.start - b.start)) {
    if (c.start < at) continue;
    out += html.slice(at, c.start) + PERSON_PLACEHOLDER;
    at = c.end;
  }
  out += html.slice(at);
  const anchors = out.match(/\sdata-comment-thread="[^"]*"/g)?.length ?? 0;
  return { html: out.replace(/\sdata-comment-thread="[^"]*"/g, ""), count: cuts.length + anchors };
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A mention in a plain text (notifications, workflow messages; lib/inline-markdown.ts).
const INLINE_MENTION = /\[@(?:\\.|[^\]\\\n])*\]\{\s*data-mention=[0-9a-fA-F-]{36}\s*\}/g;

// Strings without the people of `people`: "" for a string that is a
// member's id or address; in longer texts mentions become "@Person" and ids
// and addresses of members are cut out (with a "mailto:" before them).
// `walk` cleans every string of a JSON value – strings that become "" leave
// their list; `cleared` counts what was taken.
export function peopleCleaner(people: People) {
  const parts = [...people.ids, ...people.emails].filter((x) => x.length >= 3).sort((a, b) => b.length - a.length);
  const pattern = parts.length ? new RegExp(`(?:mailto:)?(?:${parts.map(escapeRegExp).join("|")})`, "gi") : null;
  let cleared = 0;
  const clean = (v: string): string => {
    if (people.ids.has(v) || people.emails.has(v.toLowerCase())) {
      cleared++;
      return "";
    }
    let out = v;
    if (out.includes("data-mention="))
      out = out.replace(INLINE_MENTION, () => {
        cleared++;
        return PERSON_PLACEHOLDER;
      });
    if (pattern)
      out = out.replace(pattern, () => {
        cleared++;
        return "";
      });
    return out;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return clean(v);
    if (Array.isArray(v)) {
      const out = v.map(walk);
      return out.filter((x, i) => !(x === "" && typeof v[i] === "string" && v[i] !== ""));
    }
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return { clean, walk, cleared: () => cleared };
}

// Any page template's content: a document or notebook ({html, meta, …}) or
// a database ({database, rows, rowTemplates, meta, …}).
export function publicTemplateContent(raw: Content, people: People): Stripped {
  let cleared = 0;
  const fields = Array.isArray(raw.database?.fields) ? raw.database!.fields! : [];
  const personal = new Set(fields.filter((f) => typeof f?.id === "string" && PERSON_TYPES.has(String(f.type))).map((f) => f.id as string));
  const cells = (values: Record<string, unknown> | undefined) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values && typeof values === "object" ? values : {})) {
      if (personal.has(key)) {
        if (value !== "" && value !== null && !(Array.isArray(value) && !value.length)) cleared++;
        continue;
      }
      out[key] = value;
    }
    return out;
  };
  const html = (value: unknown) => {
    const stripped = withoutMentions(typeof value === "string" ? value : "");
    cleared += stripped.count;
    return stripped.html;
  };
  const content: Content = { ...raw };
  // A document's (or notebook's) own text.
  if (typeof raw.html === "string") content.html = html(raw.html);
  if (Array.isArray(raw.rows))
    content.rows = raw.rows.map((r) => ({
      id: r.id,
      cells: cells(r.cells),
      content: html(r.content),
      position: typeof r.position === "number" ? r.position : 0,
    }));
  if (Array.isArray(raw.rowTemplates)) content.rowTemplates = raw.rowTemplates.map((t) => ({ ...t, cells: cells(t.cells), html: html(t.html) }));
  if (raw.meta && Array.isArray(raw.meta.properties)) {
    const kept = raw.meta.properties.filter((p) => !PERSON_PROPERTY_TYPES.has(String(p?.type)));
    cleared += raw.meta.properties.length - kept.length;
    content.meta = { ...raw.meta, properties: kept };
  }
  // Ids and addresses of members anywhere else.
  const cleaner = peopleCleaner(people);
  const out = cleaner.walk(content) as Content;
  return { content: out, cleared: cleared + cleaner.cleared() };
}

// The name it had when only databases were cleaned (#345).
export const publicDatabaseContent = publicTemplateContent;
