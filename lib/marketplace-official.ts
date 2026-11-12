// The templates that come with Flowplan as marketplace packages
// (scripts/marketplace-official.mjs): every document and database template
// of the catalog (lib/template-catalog.ts, English texts from
// lib/template-catalog-en.ts), the whiteboard gallery
// (lib/whiteboard-template-gallery.ts) and the workflow gallery
// (lib/workflows/templates.ts), each a `<kind>-<id>.flowplan-template`.
//
// Deterministic: fixed ZIP timestamps, sorted entries, row ids derived from
// the template's key and example dates relative to a fixed day – running it
// again only changes the files whose content changed.
//
// The content is German (language "de"); the English name and description
// go into the English summary and description. Licence CC0-1.0.
// Workflows keep their gaps as "$ask:<gap>" tokens plus a `gaps` list
// (labels); the import clears what is still open and lists it
// (lib/marketplace-package.ts).
import { createHash } from "node:crypto";
import { ZipFile } from "yazl";
import { templateCatalog, resolveCatalogDates, type CatalogTemplate } from "./template-catalog";
import { templateCatalogEn } from "./template-catalog-en";
import { galleryTemplates, galleryCategories, type GalleryCategory } from "./whiteboard-template-gallery";
import { workflowTemplates, type Gap } from "./workflows/templates";
import { GRAPH_FORMAT, GRAPH_VERSION } from "./workflows/graph";
import { TEMPLATE_FORMAT } from "./template-exchange";
import { BOARD_TEMPLATE_FORMAT, cleanTemplateItems, portableTemplateItems } from "./whiteboard-user-templates";
import { MARKETPLACE_FORMAT, type MarketplaceKind } from "./marketplace-package";
import { packageMinVersion } from "./marketplace-config";
import { templateCategoryLabels, type TemplateCategory } from "./template-categories";

const MTIME = new Date(Date.UTC(2026, 0, 1));
// Example dates ("@+3") are resolved against this day.
export const OFFICIAL_REFERENCE_DAY = new Date(2027, 0, 4);
const tDe = (d: string, _e: string) => d;
const tEn = (_d: string, e: string) => e;
const deLabels = templateCategoryLabels(tDe);

// A ZIP that is the same byte for byte for the same content.
export function stableZip(entries: [string, Buffer][]): Promise<Buffer> {
  const zip = new ZipFile();
  for (const [name, data] of [...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) zip.addBuffer(data, name, { mtime: MTIME, mode: 0o100644, compress: true });
  zip.end();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (c: Buffer) => chunks.push(c));
    zip.outputStream.once("error", reject);
    zip.outputStream.once("end", () => resolve(Buffer.concat(chunks)));
  });
}
// A UUID (version 4 layout) derived from a name.
export function stableUuid(name: string) {
  const h = createHash("sha256").update(name).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const json = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

export type OfficialPackage = { file: string; kind: MarketplaceKind; id: string; title: string; bytes: Buffer };
type Meta = { kind: MarketplaceKind; id: string; title: string; titleEn: string; summary: { de: string; en: string }; category: Exclude<TemplateCategory, "">; tags: string[]; payload: string; entries: [string, Buffer][] };

async function envelope(m: Meta, version: string, previews: Map<string, Buffer>): Promise<OfficialPackage> {
  // The marketplace takes the file name as the template's slug: kebab case.
  const key = `${m.kind}-${m.id}`;
  const file = key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  const englishOnly = m.titleEn && m.titleEn !== m.title;
  const descriptionDe = `${m.summary.de}\n\nDiese Vorlage gehört zu Flowplan und ist gemeinfrei (CC0).`;
  const descriptionEn = `${englishOnly ? `**${m.titleEn}** – ` : ""}${m.summary.en}\n\nThis template comes with Flowplan and is in the public domain (CC0). Its content is in German.`;
  const manifest = {
    format: MARKETPLACE_FORMAT,
    kind: m.kind,
    title: m.title.slice(0, 120),
    summary: { de: m.summary.de.slice(0, 300), en: m.summary.en.slice(0, 300) },
    // Package text, not interface text (kept out of the language catalogues).
    description: { de: descriptionDe, en: descriptionEn },
    category: m.category,
    tags: [...new Set(m.tags)].slice(0, 10).map((t) => t.slice(0, 32)),
    minVersion: packageMinVersion(version),
    language: "de",
    payload: m.payload,
    license: "CC0-1.0",
    author: { name: "Flowplan", handle: "flowplan" },
  };
  const preview = previews.get(key) ?? previews.get(file);
  const bytes = await stableZip([["template.json", json(manifest)], ...m.entries, ...(preview ? ([["preview/1.png", preview]] as [string, Buffer][]) : [])]);
  return { file: `${file}.flowplan-template`, kind: m.kind, id: m.id, title: m.title, bytes };
}

// A catalog template as flowplan-template-1 (what "Als Vorlage speichern" would write).
async function catalogPayload(key: string, t: CatalogTemplate) {
  const content =
    t.kind === "document"
      ? { html: t.html || "", icon: t.icon }
      : {
          database: { fields: t.fields || [], views: t.views || [] },
          rows: (t.rows || []).map((row, i) => ({ id: stableUuid(`official:${key}:row:${i}`), cells: resolveCatalogDates(row.cells, OFFICIAL_REFERENCE_DAY), content: row.content || "", position: i })),
          relationPairs: [],
          icon: t.icon,
        };
  const manifest = { format: TEMPLATE_FORMAT, name: t.name, kind: t.kind, category: t.category, payload: JSON.stringify(content), files: [] };
  return await stableZip([["template.json", Buffer.from(JSON.stringify(manifest))]]);
}

const boardCategory: Record<GalleryCategory, Exclude<TemplateCategory, "">> = { retro: "meetings", meetings: "meetings", planning: "planning", strategy: "planning", ideas: "other", diagrams: "knowledge" };
const workflowCategory: Record<string, Exclude<TemplateCategory, "">> = {
  "subpages-overview": "knowledge",
  "due-reminder": "projects",
  "form-triage": "other",
  "weekly-report": "planning",
  "mail-ticket": "projects",
  "webhook-record": "other",
};
// Catalog templates that need the instance itself (the survey builder) stay out.
export const OFFICIAL_SKIPPED = ["survey"];

export async function officialPackages(version: string, previews: Map<string, Buffer> = new Map()): Promise<OfficialPackage[]> {
  const out: OfficialPackage[] = [];
  for (const [key, t] of Object.entries(templateCatalog)) {
    if (t.survey || OFFICIAL_SKIPPED.includes(key)) continue;
    const e = templateCatalogEn[key as keyof typeof templateCatalogEn];
    out.push(
      await envelope(
        {
          kind: t.kind,
          id: key,
          title: t.name,
          titleEn: e?.name ?? "",
          summary: { de: t.description, en: e?.description ?? "" },
          category: t.category,
          tags: ["Flowplan", deLabels[t.category], t.kind === "database" ? "Datenbank" : "Dokument"],
          payload: "payload/template.zip",
          entries: [["payload/template.zip", await catalogPayload(key, t)]],
        },
        version,
        previews,
      ),
    );
  }
  for (const g of galleryTemplates) {
    const items = portableTemplateItems(cleanTemplateItems(g.items(tDe))).items;
    const category = galleryCategories.find((c) => c.id === g.category);
    out.push(
      await envelope(
        {
          kind: "whiteboard",
          id: g.id,
          title: g.name(tDe),
          titleEn: g.name(tEn),
          summary: { de: g.description(tDe), en: g.description(tEn) },
          category: boardCategory[g.category],
          tags: ["Flowplan", "Whiteboard", category ? category.name(tDe) : g.category],
          payload: "payload/whiteboard.json",
          entries: [["payload/whiteboard.json", json({ format: BOARD_TEMPLATE_FORMAT, version: 1, name: g.name(tDe), items })]],
        },
        version,
        previews,
      ),
    );
  }
  const english = new Map(workflowTemplates(tEn).map((w) => [w.id, w]));
  for (const w of workflowTemplates(tDe)) {
    // Every gap stays a token the import asks for; toggles keep their default.
    const answers = Object.fromEntries(w.gaps.map((g) => [g.id, g.kind === "toggle" ? (g.value ?? true) : `$ask:${g.id}`]));
    const graph = w.build(answers, { t: tDe, timeZone: "Europe/Berlin", fields: () => undefined });
    const gaps = w.gaps.filter((g) => g.kind !== "toggle").map((g: Gap) => ({ id: g.id, kind: g.kind, label: g.label, ...(g.help ? { help: g.help } : {}), ...(g.optional ? { optional: true } : {}) }));
    const e = english.get(w.id);
    out.push(
      await envelope(
        {
          kind: "workflow",
          id: w.id,
          title: w.name,
          titleEn: e?.name ?? "",
          summary: { de: w.description, en: e?.description ?? "" },
          category: workflowCategory[w.id] ?? "other",
          tags: ["Flowplan", "Workflow", "Automatisierung"],
          payload: "payload/workflow.json",
          entries: [["payload/workflow.json", json({ format: GRAPH_FORMAT, version: GRAPH_VERSION, title: w.name, graph, references: {}, gaps })]],
        },
        version,
        previews,
      ),
    );
  }
  return out;
}
