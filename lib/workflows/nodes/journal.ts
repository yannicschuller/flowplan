// "An Journaltag anhängen" (#250): Markdown with placeholders into the day
// of a journal – today, yesterday (in the workflow's time zone) or a date
// from a placeholder – at the end of the day or below one of its headings
// (lib/journal-place.ts, as carried tasks are placed, #247). A missing day
// is made as opening the journal would make it (lib/journal.ts
// ensureJournalDay: the template, carried tasks by the journal's setting).
// As the person the workflow runs as and with their rights: they must be
// able to edit the journal; journals behind a PIN, locked pages and
// encrypted spaces are refused, as for every page action.
//
// The Markdown is the author's: placeholders are taken out before it is
// parsed and their values put back as text nodes afterwards (page values as
// page links), so a value never becomes markup (docs/specs/workflows.md
// §7.4) – the same rule as "An Seite anhängen".
import { Node as PMNode } from "@tiptap/pm/model";
import { one } from "../../db";
import { pageRole } from "../../permissions";
import { htmlJson } from "../../document-server";
import { markdownToHtml } from "../../markdown-import";
import { isEncryptedPage } from "../../e2ee-server";
import { ensureJournalDay } from "../../journal";
import { placeBlocks } from "../../journal-place";
import type { Page } from "../../types";
import { evaluatePlaceholder, parseTemplate, valueText, type RenderScope } from "../placeholders";
import { behindJournalPin } from "../runner";
import { pageValue } from "./data";
import { changeDocument, dueDay, pageLinkOf } from "./pages";
import { dryRun, StepError, type NodeImpl, type NodeRun } from "./types";

type Json = { type: string; attrs?: Record<string, unknown>; content?: Json[]; text?: string; marks?: { type: string; attrs?: Record<string, unknown> }[] };
export type JournalAppendConfig = {
  journal: string;
  day?: "today" | "yesterday" | "date";
  date?: string;
  content: string;
  place?: "end" | "heading";
  heading?: string;
};

// Placeholders stand in the Markdown as these markers while it is parsed.
const OPEN = "",
  CLOSE = "";
const MARKER = new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g");
const SAFE_HREF = /^(?:https?:|mailto:|\/|#)/i;

// The Markdown as document blocks, with the placeholders' values as text.
export function markdownBlocks(markdown: string, scope: RenderScope): Json[] {
  const values: unknown[] = [];
  let source = "";
  for (const s of parseTemplate(markdown)) {
    if (typeof s === "string") source += s.replace(/[]/g, "");
    else {
      values.push(evaluatePlaceholder(s, scope));
      source += `${OPEN}${values.length - 1}${CLOSE}`;
    }
  }
  const doc = htmlJson(markdownToHtml(source)) as Json;
  const text = (i: number) => valueText(values[i], scope.locale, scope.timeZone).replace(/[\u0000-\u0008\u000b-\u001f]/g, "");
  // Attributes (a link's address, an image's source …): the value as text,
  // URL-encoded in addresses; an address that does not start with a fixed
  // scheme loses its link.
  const attrs = (a: Record<string, unknown> | undefined, url: boolean) =>
    a &&
    Object.fromEntries(
      Object.entries(a).map(([k, v]) => [k, typeof v === "string" ? v.replace(MARKER, (_, i) => (url ? encodeURIComponent(text(Number(i))) : text(Number(i)))) : v]),
    );
  const marks = (list: Json["marks"]) =>
    list
      ?.map((m) => (m.type === "link" ? { ...m, attrs: attrs(m.attrs, true) } : m))
      .filter((m) => m.type !== "link" || SAFE_HREF.test(String(m.attrs?.href || "")));
  const walk = (node: Json, code: boolean): Json[] => {
    if (node.type === "text") {
      const own = marks(node.marks);
      const out: Json[] = [];
      const push = (t: string, extra?: Json["marks"]) => {
        if (!t) return;
        const m = [...(own || []), ...(extra || [])];
        // Line breaks of a value: real line breaks, except in code.
        const lines = code ? [t] : t.split("\n");
        lines.forEach((line, i) => {
          if (i) out.push({ type: "hardBreak" });
          if (line) out.push({ type: "text", text: line, ...(m.length ? { marks: m } : {}) });
        });
      };
      let last = 0;
      const raw = node.text || "";
      for (const match of raw.matchAll(MARKER)) {
        push(raw.slice(last, match.index));
        const value = values[Number(match[1])];
        const link = pageLinkOf(value);
        if (link && !own?.some((m) => m.type === "link")) push(link.title || link.id, [{ type: "link", attrs: { href: `/#page=${link.id}` } }]);
        else push(text(Number(match[1])));
        last = match.index! + match[0].length;
      }
      push(raw.slice(last));
      return out;
    }
    const content = node.content?.flatMap((child) => walk(child, code || node.type === "codeBlock"));
    return [{ ...node, ...(node.attrs ? { attrs: attrs(node.attrs, ["image", "media", "linkCard"].includes(node.type)) } : {}), ...(content ? { content } : {}) }];
  };
  const blocks = (doc.content || []).flatMap((n) => walk(n, false));
  // Nothing but empty lines (no content, or only empty values): nothing.
  return blocks.every((b) => b.type === "paragraph" && !b.content?.length) ? [] : blocks;
}

const zonedDay = (timeZone: string) => {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
};
// The date of the day: today or yesterday in the workflow's time zone (as
// $today), or a date (a placeholder on one, a moment's day in that zone).
function targetDate(ctx: NodeRun, c: JournalAppendConfig) {
  const today = typeof ctx.scope.values.$today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(ctx.scope.values.$today) ? ctx.scope.values.$today : zonedDay(ctx.scope.timeZone || "UTC");
  const day = c.day || "today";
  if (day === "today") return { date: today, today };
  if (day === "yesterday") {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return { date: d.toISOString().slice(0, 10), today };
  }
  const date = dueDay(ctx, c.date || "");
  if (!date) throw new StepError("Kein Datum für den Journaltag.", "validation");
  return { date, today };
}

export const journalAppend: NodeImpl = async (ctx) => {
  const c = ctx.config as JournalAppendConfig;
  if (!ctx.runner) throw new StepError("Keine ausführende Person.", "permission");
  const runner = ctx.runner;
  const journal = c.journal ? await one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", String(c.journal)) : undefined;
  if (!journal || journal.kind !== "journal" || journal.workspace_id !== ctx.run.workspaceId) throw new StepError("Das Journal gibt es nicht (mehr).", "validation");
  const role = await pageRole(runner, journal);
  if (!role) throw new StepError("Das Journal gibt es nicht (mehr).", "validation");
  if (role !== "editor" && role !== "owner") throw new StepError(`${runner.name || runner.email} darf das Journal „${journal.title || "Ohne Titel"}“ nicht bearbeiten.`, "permission");
  if (await behindJournalPin(journal)) throw new StepError("Dieses Journal ist mit einer PIN gesperrt – Workflows schreiben nicht hinein.", "permission");
  if (journal.locked) throw new StepError("Diese Seite ist gesperrt.", "validation");
  if (await isEncryptedPage(journal)) throw new StepError("Das Journal liegt in einem verschlüsselten Bereich, dort kann der Server nichts schreiben.", "validation");
  const { date, today } = targetDate(ctx, c);
  if (date > today) throw new StepError("In einen künftigen Tag lässt sich noch nichts schreiben – der Tag entsteht erst, wenn er beginnt.", "validation");
  const blocks = markdownBlocks(c.content || "", ctx.scope);
  if (!blocks.length) throw new StepError("Es gibt nichts anzuhängen.", "validation");
  const place = c.place === "heading" ? { at: "heading" as const, heading: c.heading || "" } : { at: "end" as const };
  const existing = await one<{ id: string }>("SELECT id FROM pages WHERE parent_id=? AND journal_date=? AND deleted_at IS NULL", journal.id, date);
  if (dryRun(ctx))
    return {
      port: "out",
      output: { wouldAppend: { journal: journal.id, date, newDay: !existing, blocks: blocks.length, place: place.at, heading: place.heading ?? "" }, day: existing ? await pageValue(existing.id) : null, date, journal: await pageValue(journal.id, { text: false }) },
    };
  let dayId: string;
  let created = false;
  try {
    ({ dayId, created } = await ensureJournalDay(runner, journal, date, today));
  } catch (e) {
    throw new StepError((e as Error).message, "validation");
  }
  const day = (await one<Page>("SELECT * FROM pages WHERE id=?", dayId))!;
  if (day.locked) throw new StepError("Diese Seite ist gesperrt.", "validation");
  await changeDocument(ctx, day, (doc, schema) => {
    const added = blocks.map((b) => PMNode.fromJSON(schema, b));
    const children: PMNode[] = [];
    doc.content.forEach((n) => children.push(n));
    // An empty day (one empty line): the blocks take its place.
    const empty = children.length === 1 && children[0].type.name === "paragraph" && !children[0].content.size;
    return doc.type.create(doc.attrs, placeBlocks(empty ? [] : children, added, place, "end"));
  });
  return { port: "out", output: { day: await pageValue(dayId), date, journal: await pageValue(journal.id, { text: false }), created } };
};
