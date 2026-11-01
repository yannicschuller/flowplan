// Tags and custom properties of pages (issue #70), the part shared by the
// server and the browser: the types, the colours, what a value of each type
// looks like, and the search tokens `#tag` and `name:value`.
//
// Tags and property definitions belong to the workspace (tables page_tags
// and page_property_defs); pages carry tags (page_tag_links) and values
// (page_property_values). lib/page-properties-server.ts has the storage and
// the commands. Pages of end-to-end encrypted spaces have neither: the
// server would read them.

export const PAGE_TAG_COLORS = ["gray", "blue", "green", "red", "yellow", "orange", "purple", "pink", "teal"] as const;
export type PageTagColor = (typeof PAGE_TAG_COLORS)[number];

// Types reuse the database property types (lib/types.ts FieldType) and their
// editors (components/cell-input.tsx). The last four are read from the page.
export const PAGE_PROPERTY_TYPES = [
  "text",
  "number",
  "date",
  "select",
  "multiselect",
  "checkbox",
  "person",
  "url",
  "email",
  "phone",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
] as const;
export type PagePropertyType = (typeof PAGE_PROPERTY_TYPES)[number];
export const COMPUTED_PAGE_PROPERTIES: readonly PagePropertyType[] = ["created_at", "updated_at", "created_by", "updated_by"];
export const isComputedProperty = (type: string) => (COMPUTED_PAGE_PROPERTIES as readonly string[]).includes(type);

export const MAX_TAG_NAME = 60,
  MAX_PROPERTY_NAME = 80,
  MAX_TAGS_PER_PAGE = 50,
  MAX_TAGS = 1000,
  MAX_PROPERTIES = 100,
  MAX_OPTIONS = 100,
  MAX_OPTION_LENGTH = 100,
  MAX_TEXT_VALUE = 2000;

export type PageTag = { id: string; name: string; color: PageTagColor; position: number };
export type PagePropertyDef = { id: string; name: string; type: PagePropertyType; options: string[]; position: number };
// Who made the page and who changed it last (the read-only types).
export type PageInfo = { createdAt: string | null; createdBy: string | null; updatedAt: string | null; updatedBy: string | null };
// What a page carries (in pageData as `properties`).
export type PageMeta = { tags: string[]; values: Record<string, unknown>; info: PageInfo };
// Definitions and the tags of the pages one sees (in the bootstrap).
export type WorkspaceTaxonomy = {
  tags: PageTag[];
  properties: PagePropertyDef[];
  // Page → its tag ids, for the visible pages.
  links: Record<string, string[]>;
  // May rename, recolour, merge and delete tags and edit definitions.
  manage: boolean;
  // May create new tags while tagging a page.
  createTags: boolean;
};

// Tags and properties by name, as templates, copies between workspaces,
// archives and imports carry them (the ids differ between workspaces).
export type PortableMeta = {
  tags?: { name: string; color?: string }[];
  properties?: { name: string; type: PagePropertyType; options?: string[]; value: unknown }[];
};

// Names are compared without case and surrounding space.
export const foldName = (name: string) => name.replace(/\s+/g, " ").trim().toLocaleLowerCase();
export const cleanName = (name: string, max: number) => name.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
// "#Projekt" and "Projekt" name the same tag.
export const cleanTagName = (name: string) => cleanName(name.replace(/^#+/, ""), MAX_TAG_NAME);

// A colour another tool named (AFFiNE "var(--affine-tag-red)", "#e5484d"
// or "red") as the nearest of ours; unknown ones become gray.
export function tagColorFrom(raw: unknown): PageTagColor {
  if (typeof raw !== "string") return "gray";
  const text = raw.toLowerCase();
  for (const color of PAGE_TAG_COLORS) if (text.includes(color)) return color;
  if (text.includes("violet") || text.includes("magenta")) return "purple";
  if (text.includes("cyan") || text.includes("turquoise")) return "teal";
  if (text.includes("rose")) return "pink";
  if (text.includes("grey")) return "gray";
  const hex = /#([0-9a-f]{6}|[0-9a-f]{3})\b/.exec(text)?.[1];
  if (!hex) return "gray";
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  if (max - min < 0.12) return "gray";
  let hue = 0;
  if (max === r) hue = ((g - b) / (max - min)) % 6;
  else if (max === g) hue = (b - r) / (max - min) + 2;
  else hue = (r - g) / (max - min) + 4;
  hue = (hue * 60 + 360) % 360;
  if (hue < 15 || hue >= 345) return "red";
  if (hue < 40) return "orange";
  if (hue < 70) return "yellow";
  if (hue < 160) return "green";
  if (hue < 200) return "teal";
  if (hue < 250) return "blue";
  if (hue < 290) return "purple";
  return "pink";
}

// The text of a value for search, frontmatter and lists; people by name.
export function propertyText(def: Pick<PagePropertyDef, "type">, value: unknown, people?: (id: string) => string | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  if (def.type === "checkbox") return value ? "true" : "false";
  if (Array.isArray(value)) return value.map((v) => propertyText({ type: "text" }, v)).filter(Boolean).join(", ");
  if ((def.type === "person" || def.type === "created_by" || def.type === "updated_by") && people) return people(String(value)) ?? "";
  return String(value);
}
export const isEmptyValue = (value: unknown) =>
  value === null || value === undefined || value === "" || value === false || (Array.isArray(value) && !value.length);

// ---- Search tokens ----
//
// `#tag` and `#"tag with spaces"` keep pages with that tag, `-#tag` leaves
// them out. `name:value` (or `"long name":"some value"`) compares a
// property: text contains, select and multi-select equal an option, numbers
// and dates also with >, <, >=, <= and a..b, checkboxes with yes/no, people
// by name or "me". `name:*` means set, `name:-` empty. Tokens that name no
// tag or property stay search words.

export type TagFilter = { tagId: string; exclude: boolean };
export type PropertyFilter = { propertyId: string; op: "has" | "empty" | "eq" | "contains" | "gt" | "lt" | "gte" | "lte" | "between"; value: string; to?: string };
export type ParsedQuery = { text: string; tags: TagFilter[]; properties: PropertyFilter[]; tokens: string[] };

const TOKEN = /(^|\s)(-?)#(?:"([^"]{1,200})"|([^\s"#][^\s#]*))|(^|\s)(?:"([^"]{1,200})"|([\p{L}\p{N}_][\p{L}\p{N}_.-]*)):(?:"([^"]*)"|(\S*))/gu;

export function parseSearchTokens(
  query: string,
  taxonomy: { tags: Pick<PageTag, "id" | "name">[]; properties: Pick<PagePropertyDef, "id" | "name" | "type">[] },
): ParsedQuery {
  const tags: TagFilter[] = [],
    properties: PropertyFilter[] = [],
    tokens: string[] = [];
  const tagByName = new Map(taxonomy.tags.map((t) => [foldName(t.name), t.id]));
  const propByName = new Map(taxonomy.properties.map((p) => [foldName(p.name), p]));
  const text = query.replace(TOKEN, (match, lead1: string | undefined, minus, quotedTag, plainTag, lead2: string | undefined, quotedName, plainName, quotedValue, plainValue) => {
    if (quotedTag !== undefined || plainTag !== undefined) {
      // A trailing comma or full stop belongs to the sentence, not the tag.
      const name = quotedTag ?? String(plainTag).replace(/[.,;:!?)]+$/, "");
      const tagId = tagByName.get(foldName(name));
      if (!tagId) return match;
      tags.push({ tagId, exclude: minus === "-" });
      tokens.push(match.trim());
      return lead1 || " ";
    }
    const def = propByName.get(foldName(quotedName ?? plainName ?? ""));
    if (!def) return match;
    const raw = String(quotedValue ?? plainValue ?? "").trim();
    const filter = propertyFilter(def.id, def.type, raw, quotedValue !== undefined);
    if (!filter) return match;
    properties.push(filter);
    tokens.push(match.trim());
    return lead2 || " ";
  });
  return { text: text.replace(/\s+/g, " ").trim(), tags, properties, tokens };
}

function propertyFilter(propertyId: string, type: PagePropertyType, raw: string, quoted: boolean): PropertyFilter | null {
  // name:* and a bare name: → set; name:- and name:"" → empty.
  if (!quoted && (raw === "*" || raw === "")) return { propertyId, op: "has", value: "" };
  if ((!quoted && raw === "-") || (quoted && raw === "")) return { propertyId, op: "empty", value: "" };
  if (type === "number" || type === "date" || type === "created_at" || type === "updated_at") {
    const range = /^(.+?)\.\.(.+)$/.exec(raw);
    if (range) return { propertyId, op: "between", value: range[1], to: range[2] };
    const cmp = /^(>=|<=|>|<|=)(.+)$/.exec(raw);
    if (cmp) return { propertyId, op: ({ ">=": "gte", "<=": "lte", ">": "gt", "<": "lt", "=": "eq" } as const)[cmp[1] as ">="], value: cmp[2] };
    return { propertyId, op: "eq", value: raw };
  }
  if (type === "checkbox") return { propertyId, op: "eq", value: /^(yes|ja|oui|true|1|x|on|wahr)$/i.test(raw) ? "true" : "false" };
  if (type === "select" || type === "multiselect") return { propertyId, op: "eq", value: raw };
  return { propertyId, op: "contains", value: raw };
}

// Whether a page's value passes a filter. `people` names a person id;
// `me` is the searching person (for person:me).
export function matchesPropertyFilter(
  def: Pick<PagePropertyDef, "type">,
  value: unknown,
  filter: PropertyFilter,
  people: (id: string) => string | undefined = () => undefined,
  me?: string,
): boolean {
  if (filter.op === "has") return !isEmptyValue(value);
  if (filter.op === "empty") return isEmptyValue(value);
  if (isEmptyValue(value) && def.type !== "checkbox") return false;
  const fold = (s: string) => s.toLocaleLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  switch (def.type) {
    case "checkbox":
      return !!value === (filter.value === "true");
    case "number": {
      const n = Number(value),
        a = Number(filter.value.replace(",", "."));
      if (!Number.isFinite(n) || !Number.isFinite(a)) return false;
      if (filter.op === "between") {
        const b = Number(String(filter.to).replace(",", "."));
        return Number.isFinite(b) && n >= Math.min(a, b) && n <= Math.max(a, b);
      }
      return compare(n - a, filter.op);
    }
    case "date":
    case "created_at":
    case "updated_at": {
      // ISO texts compare as text; "2026-03" matches every day of March.
      const day = String(value).replace(" ", "T").slice(0, 10);
      const at = (bound: string) => bound.trim().slice(0, 10);
      if (filter.op === "between") return day >= at(filter.value) && day <= at(String(filter.to)).padEnd(10, "~");
      if (filter.op === "eq") return day.startsWith(at(filter.value));
      const bound = at(filter.value);
      return compare(day < bound ? -1 : day.startsWith(bound) ? 0 : 1, filter.op);
    }
    case "select":
      return fold(String(value)) === fold(filter.value);
    case "multiselect":
      return Array.isArray(value) && value.some((v) => fold(String(v)) === fold(filter.value));
    case "person":
    case "created_by":
    case "updated_by": {
      const ids = Array.isArray(value) ? value.map(String) : [String(value)];
      if (me && /^(me|ich|moi)$/i.test(filter.value)) return ids.includes(me);
      return ids.some((uid) => fold(people(uid) ?? "").includes(fold(filter.value)));
    }
    default:
      return fold(propertyText(def, value)).includes(fold(filter.value));
  }
}
function compare(diff: number, op: PropertyFilter["op"]) {
  if (op === "gt") return diff > 0;
  if (op === "lt") return diff < 0;
  if (op === "gte") return diff >= 0;
  if (op === "lte") return diff <= 0;
  return diff === 0;
}

// The token that finds a tag or a property value in the search.
export function tagToken(name: string) {
  return /^[^\s"#]+$/.test(name) && !/[.,;:!?)]$/.test(name) ? `#${name}` : `#"${name.replace(/"/g, "")}"`;
}
