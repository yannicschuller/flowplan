// Placeholders in page templates (#653): "{{Kunde}}" in the title, the
// text or a text property of a saved document template becomes the new
// page's value of that property – once, when the page is created from the
// template. The same names, rules and formatting as record templates
// (lib/record-placeholders.ts): properties by name (a property named like a
// built-in wins), the built-ins {{Titel}}, {{Heute}}, {{Jetzt}},
// {{Ersteller}}, {{Ich}} and {{Bereich}}; values only ever as plain text,
// unknown placeholders stay as written, empty properties become empty.
import { withLookups } from "./resolve-ahead";
import { one, run, id } from "./db";
import { htmlState } from "./document-server";
import { isEncryptedPage } from "./e2ee-server";
import { contextProperties, pageMeta, setPageValue } from "./page-properties-server";
import { MAX_TEXT_VALUE, type PageInfo, type PagePropertyDef } from "./page-properties";
import { mapHtmlPlaceholders, mapPlaceholders, placeholderTarget, placeholderValue, type PlaceholderFormat } from "./record-placeholders";
import { builtinValue, formatFor, placeholderZone, spaceName, type BuiltinValues } from "./record-template-apply";
import { Temporal } from "./date-values";
import type { Field, Identity, Page } from "./types";

// The computed properties read from the page itself.
const INFO: Partial<Record<PagePropertyDef["type"], keyof PageInfo>> = {
  created_at: "createdAt",
  created_by: "createdBy",
  updated_at: "updatedAt",
  updated_by: "updatedBy",
};

// The page's properties as the fields placeholders name, with their
// values. Every definition of the page's context counts: one without a
// value on this page becomes empty text.
export function pagePlaceholderFields(defs: PagePropertyDef[], values: Record<string, unknown>, info: PageInfo) {
  const fields: Field[] = defs.map((def) => ({ id: def.id, name: def.name, type: def.type, options: def.options }));
  const cells: Record<string, unknown> = {};
  for (const def of defs) {
    const from = INFO[def.type];
    cells[def.id] = from ? info[from] : values[def.id];
  }
  return { fields, cells };
}

// The text each placeholder becomes on one page. `title` undefined keeps
// {{Titel}} as written (in the title itself).
export function pagePlaceholderResolver(
  fields: Field[],
  cells: Record<string, unknown>,
  builtins: BuiltinValues,
  fmt: PlaceholderFormat,
) {
  return (key: string): string | undefined => {
    const target = placeholderTarget(key, fields);
    if (!target) return undefined;
    if ("gone" in target) return "";
    if ("field" in target) return placeholderValue(target.field, cells[target.field.id], fmt);
    // Only records have a database.
    return builtinValue(target.builtin, { ...builtins, database: undefined }, fmt);
  };
}

// A document page just created from a saved template: its title, text and
// text properties with the placeholders filled. Encrypted pages are left
// alone (the server never reads them).
export async function fillPagePlaceholders(actor: Identity, pageId: string, zone?: string) {
  const page = await one<Page>("SELECT * FROM pages WHERE id=?", pageId);
  if (!page || page.kind !== "document" || (await isEncryptedPage(page))) return;
  const doc = await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId);
  const meta = await pageMeta(pageId);
  const defs = await contextProperties(page.workspace_id, page.space_id);
  const texts = defs.filter((d) => d.type === "text" && typeof meta.values[d.id] === "string" && (meta.values[d.id] as string).includes("{{"));
  if (!page.title.includes("{{") && !doc?.html.includes("{{") && !texts.length) return;
  const { fields, cells } = pagePlaceholderFields(defs, meta.values, meta.info);
  const tz = placeholderZone(zone);
  const builtins: BuiltinValues = {
    title: () => undefined,
    creator: page.created_by,
    actor,
    space: await spaceName(page.space_id),
    now: Temporal.Now.plainDateTimeISO(tz),
  };
  const filled = await withLookups<PlaceholderFormat, { title: string; html: string | undefined; texts: [string, string][] }>(
    formatFor(actor, tz),
    (fmt) => {
      const title = mapPlaceholders(page.title, pagePlaceholderResolver(fields, cells, builtins, fmt)).trim() || page.title;
      const resolve = pagePlaceholderResolver(fields, cells, { ...builtins, title: () => title }, fmt);
      return {
        title,
        html: doc && mapHtmlPlaceholders(doc.html, resolve),
        texts: texts.map((d) => [d.id, mapPlaceholders(meta.values[d.id] as string, resolve).slice(0, MAX_TEXT_VALUE)]),
      };
    },
  );
  if (filled.title !== page.title) await run("UPDATE pages SET title=? WHERE id=?", filled.title.slice(0, 500), pageId);
  if (doc && filled.html !== undefined && filled.html !== doc.html)
    await run("UPDATE documents SET html=?,state=?,generation=? WHERE page_id=?", filled.html, htmlState(filled.html), id(), pageId);
  for (const [propertyId, value] of filled.texts)
    if (value !== meta.values[propertyId]) await setPageValue(pageId, propertyId, value.trim() ? value : null);
}
