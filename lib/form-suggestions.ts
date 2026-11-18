// Earlier answers suggested while typing a form's text question (#374).
// Privacy first: only forms for signed-in members that record who answered
// offer them, only for questions where the form's author switched them on,
// and only from records the person answering may read – with the normal
// database role, record rules (private records, grants) and property rules.
// "own" limits them to records the person created. Only the asked
// property's values leave the server, nothing else of the records.
import { all, one } from "./db";
import { HttpError } from "./auth";
import { allow } from "./action-limits";
import { journalLocked } from "./journal-extras";
import { visibleRows } from "./row-access";
import { cellText } from "./cell-text";
import { isFormattedText, toPlain } from "./inline-markdown";
import { getForm } from "./forms";
import { formSuggestionsAllowed, suggestionScope } from "./form-settings";
import type { Field, Identity, Page } from "./types";

export const SUGGESTION_MIN_CHARS = 2;
export const SUGGESTION_LIMIT = 8;
// Longer values are not suggested; the query is cut to this length too.
export const SUGGESTION_MAX_LENGTH = 200;
// The most recent records looked at.
const SCAN_ROWS = 5000;
// Requests per person and minute (typing sends one after a short pause).
export const SUGGESTION_REQUESTS_PER_MINUTE = 60;

const fold = (text: string) => text.trim().replace(/\s+/g, " ").toLocaleLowerCase();

// Distinct values matching the query: those starting with it first, then
// those containing it; each group by frequency, then by recency. `values`
// are ordered newest first.
export function rankSuggestions(values: string[], query: string, limit = SUGGESTION_LIMIT) {
  const q = fold(query.slice(0, SUGGESTION_MAX_LENGTH));
  if (q.length < SUGGESTION_MIN_CHARS) return [];
  const seen = new Map<string, { text: string; count: number; newest: number; prefix: boolean }>();
  values.forEach((raw, index) => {
    const text = raw.trim().replace(/\s+/g, " ");
    if (!text || text.length > SUGGESTION_MAX_LENGTH) return;
    const key = fold(text);
    // What was typed already is no suggestion.
    if (key === q || !key.includes(q)) return;
    const entry = seen.get(key);
    if (entry) entry.count++;
    // The newest spelling is the one shown.
    else seen.set(key, { text, count: 1, newest: index, prefix: key.startsWith(q) });
  });
  return [...seen.values()]
    .sort((a, b) => Number(b.prefix) - Number(a.prefix) || b.count - a.count || a.newest - b.newest)
    .slice(0, limit)
    .map((e) => e.text);
}

export async function formSuggestions(token: string, user: Identity | null, fieldId: string, query: string) {
  if (!user) throw new HttpError(401, "Vorschläge gibt es nur für angemeldete Mitglieder.");
  if (!allow(`form-suggest:${user.id}`, SUGGESTION_REQUESTS_PER_MINUTE, 60_000))
    throw new HttpError(429, "Zu viele Anfragen. Bitte kurz warten.");
  // Throws for unknown forms, people who are not members, …
  const form = await getForm(token, user);
  if (!formSuggestionsAllowed(form))
    throw new HttpError(403, "Frühere Antworten werden nur in Formularen für angemeldete Mitglieder vorgeschlagen.");
  if (form.config.survey?.enabled) throw new HttpError(404, "Keine Vorschläge für diese Frage.");
  // Only a question this form asks, a one-line text with suggestions on.
  const field = form.fields.find((f) => f.id === fieldId);
  const scope = field && suggestionScope(field, form.config);
  if (!field || !scope) throw new HttpError(404, "Keine Vorschläge für diese Frage.");
  if (fold(query).length < SUGGESTION_MIN_CHARS) return [];
  const page = await one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", form.page_id);
  if (!page || await journalLocked(user, page)) return [];
  const rows = await all<{ id: string; cells: string; access: string; created_by: string | null }>(
    `SELECT id,cells,access,created_by FROM rows WHERE page_id=?${scope === "own" ? " AND created_by=?" : ""} ORDER BY created_at DESC,position DESC LIMIT ${SCAN_ROWS}`,
    ...(scope === "own" ? [page.id, user.id] : [page.id]),
  );
  // Records the person may not see drop out, hidden properties lose their
  // cells (the asked property has no read rule, but the schema may change).
  const readable = await visibleRows(user, page, rows);
  const fields: Field[] = JSON.parse((await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", page.id))?.fields || "[]");
  const stored = fields.find((f) => f.id === field.id);
  if (!stored || stored.type !== "text") return [];
  const formatted = isFormattedText(stored, fields);
  const values = readable.flatMap((r) => {
    const value = (JSON.parse(r.cells) as Record<string, unknown>)[field.id];
    if (value === undefined || value === null || value === "") return [];
    const text = formatted ? toPlain(value) : cellText(value);
    return text.includes("\n") ? [] : [text];
  });
  return rankSuggestions(values, query);
}
