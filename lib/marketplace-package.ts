// Marketplace packages (docs: Marketplace): one `*.flowplan-template` file,
// a ZIP with
//
//   template.json   {format: "flowplan-marketplace-1", kind, title, summary,
//                    description?, category, tags, minVersion, language,
//                    payload, license?, author?, marketplace?}  (≤ 64 KB)
//   payload/…       the kind's own exchange format, unchanged:
//                     document, database  payload/template.zip  (flowplan-template-1, lib/template-exchange.ts)
//                     workflow            payload/workflow.json (flowplan.workflow, lib/workflows/portable.ts)
//                                         + payload/workflow-meta.json (names, symbols and gaps for the
//                                           marketplace's viewer, lib/marketplace-workflow-meta.ts)
//                     whiteboard          payload/whiteboard.json (flowplan.whiteboard-template, lib/whiteboard-user-templates.ts)
//                     appearance          payload/theme.json + payload/fonts/<id>.<ext> (flowplan.workspace-look)
//                     link-rules          payload/link-rules.json (flowplan.link-rules)
//   preview/1…4     optional pictures (WebP, PNG, JPEG, ≤ 1 MB each)
//
// The whole file is at most 25 MB. Building is permission-checked like the
// kind's own export, and never by guests. Reading trusts nothing: the file
// may come from the marketplace, from a download or from anyone – sizes,
// ZIP safety (yauzl refuses absolute and ../ paths; budgets and the
// compression ratio stop zip bombs), the envelope and the kind's schema are
// checked again here, and the import of each kind validates once more.
import { z } from "zod";
import { HttpError } from "./auth";
import { audit } from "./db";
import { isGuest, pageRole, requireMember } from "./permissions";
import { readZip, writeZip } from "./archive";
import { templateCategoryIds } from "./template-categories";
import { requireTemplate } from "./page-templates";
import { exportTemplate, importTemplate, TEMPLATE_FORMAT } from "./template-exchange";
import { exportWorkflow, parseExport, type WorkflowExport } from "./workflows/portable";
import { requireWorkflow } from "./workflows/store";
import { parseGraph, type WorkflowGraph } from "./workflows/graph";
import { nodeSpec } from "./workflows/catalog";
import { BOARD_TEMPLATE_FORMAT, cleanTemplateItems, exportBoardTemplate, importBoardTemplate, portableTemplateItems } from "./whiteboard-user-templates";
import { exportLook, FONT_LIMITS, importLook, sniffFont } from "./workspace-fonts";
import { themeCustomFonts, workspaceThemeSchema } from "./workspace-theme";
import { importLinkRules, workspaceLinkRules } from "./auto-link-rules";
import { AUTO_LINK_LIMITS, autoLinkRuleSchema, ruleProblems } from "./auto-link";
import { packageMinVersion } from "./marketplace-config";
import { referenceGaps, workflowMeta, workflowMetaBytes, WORKFLOW_META_PATH } from "./marketplace-workflow-meta";
import { MAX_PACKAGE_BYTES, packageFileName } from "./marketplace-handover";
import type { Identity } from "./types";

export const MARKETPLACE_FORMAT = "flowplan-marketplace-1";
export const MARKETPLACE_KINDS = ["document", "database", "workflow", "whiteboard", "appearance", "link-rules"] as const;
export type MarketplaceKind = (typeof MARKETPLACE_KINDS)[number];
export const MARKETPLACE_LANGUAGES = ["de", "en", "fr", "zh", "multi"] as const;
export const LOOK_FORMAT = "flowplan.workspace-look";
export const LINK_RULES_FORMAT = "flowplan.link-rules";
export const PACKAGE_LIMITS = {
  packageBytes: MAX_PACKAGE_BYTES,
  manifestBytes: 64 * 1024,
  previewBytes: 1024 * 1024,
  previews: 4,
  title: 120,
  summary: 300,
  description: 10_000,
  tags: 10,
  tag: 32,
  entries: 300,
  // Everything unpacked together, nested ZIPs included.
  unpacked: 60 * 1024 * 1024,
  workflowBytes: 2 * 1024 * 1024,
  jsonBytes: 5 * 1024 * 1024,
} as const;

const localized = (max: number) => z.object({ de: z.string().max(max).optional(), en: z.string().max(max).optional() }).passthrough();
// Unknown fields are kept (the marketplace adds license, author, marketplace).
export const packageManifestSchema = z
  .object({
    format: z.literal(MARKETPLACE_FORMAT),
    kind: z.enum(MARKETPLACE_KINDS),
    title: z.string().trim().min(1).max(PACKAGE_LIMITS.title),
    summary: localized(PACKAGE_LIMITS.summary),
    description: localized(PACKAGE_LIMITS.description).optional(),
    category: z.enum(templateCategoryIds).catch("other"),
    tags: z.array(z.string().trim().min(1).max(PACKAGE_LIMITS.tag)).max(PACKAGE_LIMITS.tags).catch([]).default([]),
    minVersion: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/),
    language: z.enum(MARKETPLACE_LANGUAGES).catch("multi"),
    payload: z.string().regex(/^payload\/[A-Za-z0-9._/-]{1,190}$/).refine((p) => !p.split("/").includes(".."), "payload path"),
    license: z.string().max(30).optional().catch(undefined),
    author: z.object({ name: z.string().max(120).optional(), handle: z.string().max(80).optional() }).passthrough().optional().catch(undefined),
    marketplace: z
      .object({ id: z.string().max(100).optional(), slug: z.string().max(120).optional(), version: z.number().optional(), url: z.string().max(500).optional() })
      .passthrough()
      .optional()
      .catch(undefined),
  })
  .passthrough();
export type PackageManifest = z.infer<typeof packageManifestSchema>;

// What the person sets in the publish dialog.
export const packageMetaSchema = z.object({
  title: z.string().trim().min(1).max(PACKAGE_LIMITS.title),
  summary: z.object({ de: z.string().trim().max(PACKAGE_LIMITS.summary).default(""), en: z.string().trim().max(PACKAGE_LIMITS.summary).default("") }),
  description: z.object({ de: z.string().max(PACKAGE_LIMITS.description).default(""), en: z.string().max(PACKAGE_LIMITS.description).default("") }).optional(),
  category: z.enum(templateCategoryIds).catch("other"),
  tags: z.array(z.string().trim().min(1).max(PACKAGE_LIMITS.tag)).max(PACKAGE_LIMITS.tags).default([]),
  language: z.enum(MARKETPLACE_LANGUAGES).default("de"),
});
export type PackageMeta = z.infer<typeof packageMetaSchema>;

const fail = (message: string, status = 400) => new HttpError(status, message);
const fontExtension = { woff2: "woff2", woff: "woff", truetype: "ttf", opentype: "otf" } as const;

// ---- Pictures ----

export type ImageType = "png" | "jpeg" | "webp";
export function sniffImage(bytes: Buffer): ImageType | null {
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length > 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}
const imageExtension = (type: ImageType) => (type === "jpeg" ? "jpg" : type);
const imageMime = (type: ImageType) => `image/${type}`;
function checkPreviews(previews: Buffer[]) {
  if (previews.length > PACKAGE_LIMITS.previews) throw fail("Höchstens 4 Vorschaubilder.");
  return previews.map((bytes) => {
    if (bytes.length > PACKAGE_LIMITS.previewBytes) throw fail("Ein Vorschaubild ist größer als 1 MB.", 413);
    const type = sniffImage(bytes);
    if (!type) throw fail("Vorschaubilder müssen WebP-, PNG- oder JPEG-Bilder sein.");
    return { type, bytes };
  });
}

// ---- Building (instance → marketplace) ----

export type PackageSource = { kind: MarketplaceKind; workspaceId: string; id?: string | null };
// What the publish dialog shows before building: defaults and what stays here.
export type PackageNote = { code: "images-dropped" | "references-cleared" | "fonts" | "secrets-never"; count?: number };
type Payload = { kind: MarketplaceKind; title: string; category: string; path: string; entries: [string, Buffer][]; notes: PackageNote[] };

// Guests never publish; each kind checks its own permission.
async function payloadFor(user: Identity, source: PackageSource): Promise<Payload> {
  const wid = z.uuid().parse(source.workspaceId);
  await requireMember(user, wid);
  if (await isGuest(user, wid)) throw fail("Gäste dürfen nichts im Marketplace veröffentlichen.", 403);
  switch (source.kind) {
    case "document":
    case "database": {
      // Own templates of this workspace: their creator or an owner (like managing them).
      const template = await requireTemplate(user, source.id, wid);
      const role = await requireMember(user, wid, "editor");
      if (template.workspace_id !== wid || (template.created_by !== user.id && role !== "owner"))
        throw fail("Nur der Ersteller oder ein Besitzer darf die Vorlage veröffentlichen.", 403);
      const exported = await exportTemplate(user, wid, template.id);
      return { kind: template.kind as MarketplaceKind, title: template.name, category: template.category || "other", path: "payload/template.zip", entries: [["payload/template.zip", exported.zip]], notes: [] };
    }
    case "workflow": {
      const page = await requireWorkflow(user, z.uuid().parse(source.id));
      if (page.workspace_id !== wid) throw fail("Workflow muss im Arbeitsbereich liegen.");
      const role = await pageRole(user, page);
      if (role !== "editor" && role !== "owner") throw fail("Nur wer den Workflow bearbeiten darf, kann ihn veröffentlichen.", 403);
      const data = publicWorkflow(await exportWorkflow(user, page.id));
      const references = Object.keys(data.references).length;
      const graph = parseGraph(data.graph);
      return {
        kind: "workflow",
        title: data.title || page.title,
        category: "other",
        path: "payload/workflow.json",
        entries: [
          ["payload/workflow.json", Buffer.from(JSON.stringify(data, null, 2))],
          [WORKFLOW_META_PATH, workflowMetaBytes(workflowMeta(graph, referenceGaps(data, graph)))],
        ],
        notes: [{ code: "secrets-never" }, ...(references ? [{ code: "references-cleared" as const, count: references }] : [])],
      };
    }
    case "whiteboard": {
      const board = await exportBoardTemplate(user, wid, source.id);
      const data = { format: BOARD_TEMPLATE_FORMAT, version: 1, name: board.name, items: board.items };
      return {
        kind: "whiteboard",
        title: board.name,
        category: "other",
        path: "payload/whiteboard.json",
        entries: [["payload/whiteboard.json", Buffer.from(JSON.stringify(data))]],
        notes: board.dropped ? [{ code: "images-dropped", count: board.dropped }] : [],
      };
    }
    case "appearance": {
      await requireMember(user, wid, "owner");
      const look = await exportLook(wid);
      if (!look.theme) throw fail("Dieser Arbeitsbereich hat noch kein eigenes Erscheinungsbild.");
      const used = new Set(themeCustomFonts(look.theme));
      const fonts = look.fonts.filter((f) => used.has(f.id));
      const entries: [string, Buffer][] = [];
      const listed = fonts.map((f) => {
        const sniffed = sniffFont(f.data);
        const file = `payload/fonts/${f.id}.${fontExtension[sniffed?.format ?? "woff2"]}`;
        entries.push([file, f.data]);
        return { id: f.id, name: f.name, file };
      });
      const data = { format: LOOK_FORMAT, version: 1, theme: look.theme, fonts: listed };
      return {
        kind: "appearance",
        title: "",
        category: "other",
        path: "payload/theme.json",
        entries: [["payload/theme.json", Buffer.from(JSON.stringify(data, null, 2))], ...entries],
        notes: fonts.length ? [{ code: "fonts", count: fonts.length }] : [],
      };
    }
    case "link-rules": {
      await requireMember(user, wid, "owner");
      const rules = await workspaceLinkRules(wid);
      if (!rules.length) throw fail("Dieser Arbeitsbereich hat noch keine automatischen Links.");
      const data = { format: LINK_RULES_FORMAT, version: 1, rules: rules.map(({ name, pattern, template, enabled }) => ({ name, pattern, template, enabled })) };
      return { kind: "link-rules", title: "", category: "other", path: "payload/link-rules.json", entries: [["payload/link-rules.json", Buffer.from(JSON.stringify(data, null, 2))]], notes: [] };
    }
  }
}

// A workflow export without what identifies this instance or its people:
// no source (instance address, workspace), no names of people; ids stay so
// an import can match by title where one is left.
export function publicWorkflow(data: WorkflowExport): WorkflowExport {
  const references = Object.fromEntries(
    Object.entries(data.references).map(([id, ref]) => [id, ref.kind === "person" ? { ...ref, title: "" } : ref.kind === "address" ? { ...ref, title: "" } : ref]),
  );
  const { source: _source, ...rest } = data;
  void _source;
  return { ...rest, references };
}

export async function packageDraft(user: Identity, source: PackageSource) {
  const payload = await payloadFor(user, source);
  return {
    kind: payload.kind,
    title: payload.title,
    category: payload.category,
    minVersion: packageMinVersion(),
    notes: payload.notes,
    bytes: payload.entries.reduce((n, [, b]) => n + b.length, 0),
  };
}

export async function buildPackage(user: Identity, source: PackageSource, rawMeta: unknown, previewBytes: Buffer[] = []) {
  const meta = packageMetaSchema.parse(rawMeta);
  if (!meta.summary.de && !meta.summary.en) throw fail("Bitte eine Kurzbeschreibung angeben.");
  const previews = checkPreviews(previewBytes);
  const payload = await payloadFor(user, source);
  const drop = (o: { de?: string; en?: string } | undefined) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => typeof v === "string" && v.trim()));
  const description = drop(meta.description);
  const manifest = {
    format: MARKETPLACE_FORMAT,
    kind: payload.kind,
    title: meta.title,
    summary: drop(meta.summary),
    ...(Object.keys(description).length ? { description } : {}),
    category: meta.category,
    tags: [...new Set(meta.tags)],
    minVersion: packageMinVersion(),
    language: meta.language,
    payload: payload.path,
  };
  const json = Buffer.from(JSON.stringify(manifest, null, 2));
  if (json.length > PACKAGE_LIMITS.manifestBytes) throw fail("Die Beschreibung ist zu lang.", 413);
  const entries = new Map<string, Buffer>([["template.json", json], ...payload.entries]);
  previews.forEach((p, i) => entries.set(`preview/${i + 1}.${imageExtension(p.type)}`, p.bytes));
  const bytes = await writeZip(entries);
  if (bytes.length > PACKAGE_LIMITS.packageBytes) throw fail("Das Paket wäre größer als 25 MB.", 413);
  await audit(user.id, "marketplace.package", source.workspaceId, `${payload.kind}${source.id ? ` ${source.id}` : ""}`);
  return { name: packageFileName(meta.title), bytes, kind: payload.kind };
}

// ---- Reading (marketplace or file → instance) ----

export type LookFont = { id: string; name: string; data: Buffer };
export type ParsedPayload =
  | { kind: "document" | "database"; zip: Buffer; name: string; files: number; fields?: number; views?: number; rows?: number }
  | { kind: "workflow"; data: WorkflowExport; gaps: { id: string; kind: string; label: string; optional?: boolean }[] }
  | { kind: "whiteboard"; name: string; items: unknown[]; dropped: number }
  | { kind: "appearance"; theme: z.infer<typeof workspaceThemeSchema>; fonts: LookFont[] }
  | { kind: "link-rules"; rules: z.infer<typeof autoLinkRuleSchema>[]; invalid: number };
export type ParsedPackage = { manifest: PackageManifest; payload: ParsedPayload; previews: { type: ImageType; bytes: Buffer }[]; size: number };

const parseJson = (bytes: Buffer | undefined): unknown => {
  if (!bytes) throw fail("Ein Teil der Vorlage fehlt im Paket.");
  if (bytes.length > PACKAGE_LIMITS.jsonBytes) throw fail("Ein Teil der Vorlage ist zu groß.", 413);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw fail("Ein Teil der Vorlage ist kein gültiges JSON.");
  }
};
const safeName = (name: string) => !name.startsWith("/") && !name.includes("\\") && !name.split("/").some((s) => s === ".." || s === ".") && !/[\u0000-\u001f]/.test(name);

export async function readPackage(input: Buffer): Promise<ParsedPackage> {
  if (input.length > PACKAGE_LIMITS.packageBytes) throw fail("Das Paket ist größer als 25 MB.", 413);
  const budget = { left: PACKAGE_LIMITS.unpacked };
  const entries = await readZip(input, { foreign: true, maxEntries: PACKAGE_LIMITS.entries, budget });
  for (const name of entries.keys()) if (!safeName(name)) throw fail("Unzulässiger Dateipfad im Paket.");
  const raw = entries.get("template.json");
  if (!raw) throw fail("Keine Marketplace-Vorlage (template.json fehlt).");
  if (raw.length > PACKAGE_LIMITS.manifestBytes) throw fail("template.json ist größer als 64 KB.", 413);
  const parsed = packageManifestSchema.safeParse(parseJson(raw));
  if (!parsed.success) {
    const format = (() => {
      try {
        return (JSON.parse(raw.toString("utf8")) as { format?: unknown })?.format;
      } catch {
        return undefined;
      }
    })();
    throw fail(format === MARKETPLACE_FORMAT ? "Die Beschreibung der Vorlage (template.json) ist ungültig." : "Keine Marketplace-Vorlage (flowplan-marketplace-1).");
  }
  const manifest = parsed.data;
  if (!manifest.summary.de?.trim() && !manifest.summary.en?.trim()) throw fail("Die Vorlage hat keine Kurzbeschreibung.");
  const payloadBytes = entries.get(manifest.payload);
  if (!payloadBytes) throw fail("Der Inhalt der Vorlage fehlt im Paket.");
  const previews: ParsedPackage["previews"] = [];
  for (const n of [1, 2, 3, 4]) {
    const name = [...entries.keys()].find((k) => new RegExp(`^preview/${n}\\.(png|webp|jpe?g)$`, "i").test(k));
    if (!name) continue;
    const bytes = entries.get(name)!;
    const type = sniffImage(bytes);
    if (bytes.length > PACKAGE_LIMITS.previewBytes || !type) continue;
    previews.push({ type, bytes });
  }
  const payload = await parsePayload(manifest, payloadBytes, entries, budget);
  return { manifest, payload, previews, size: input.length };
}

async function parsePayload(manifest: PackageManifest, bytes: Buffer, entries: Map<string, Buffer>, budget: { left: number }): Promise<ParsedPayload> {
  switch (manifest.kind) {
    case "document":
    case "database": {
      const inner = await readZip(bytes, { foreign: true, maxEntries: 202, budget });
      for (const name of inner.keys()) if (!safeName(name)) throw fail("Unzulässiger Dateipfad in der Vorlage.");
      const t = parseJson(inner.get("template.json")) as { format?: unknown; kind?: unknown; name?: unknown; payload?: unknown; files?: unknown } | null;
      if (!t || t.format !== TEMPLATE_FORMAT) throw fail("Der Inhalt ist keine Flowplan-Vorlage (flowplan-template-1).");
      if (t.kind !== manifest.kind) throw fail("Die Art der Vorlage passt nicht zum Paket.");
      if (typeof t.name !== "string" || !t.name.trim() || typeof t.payload !== "string") throw fail("Keine gültige Flowplan-Vorlage.");
      let content: { database?: { fields?: unknown[]; views?: unknown[] }; rows?: unknown[]; html?: unknown } | null = null;
      try {
        content = JSON.parse(t.payload);
      } catch {}
      if (!content || typeof content !== "object") throw fail("Vorlageninhalt ist beschädigt.");
      if (manifest.kind === "document" && typeof content.html !== "string") throw fail("Vorlageninhalt ist ungültig.");
      if (manifest.kind === "database" && (!Array.isArray(content.database?.fields) || !Array.isArray(content.database?.views))) throw fail("Vorlageninhalt ist ungültig.");
      return {
        kind: manifest.kind,
        zip: bytes,
        name: t.name.trim().slice(0, 200),
        files: Array.isArray(t.files) ? t.files.length : 0,
        ...(manifest.kind === "database" ? { fields: content.database!.fields!.length, views: content.database!.views!.length, rows: Array.isArray(content.rows) ? content.rows.length : 0 } : {}),
      };
    }
    case "workflow": {
      if (bytes.length > PACKAGE_LIMITS.workflowBytes) throw fail("Der Workflow ist größer als 2 MB.", 413);
      const raw = parseJson(bytes);
      const data = publicWorkflow(parseExport(raw));
      // Gaps of a gallery workflow ("$ask:<gap>", lib/workflows/templates.ts):
      // cleared like an unmatched reference, listed for the person to fill in.
      const gaps = z
        .array(z.object({ id: z.string().max(40), kind: z.string().max(20), label: z.string().max(200), optional: z.boolean().optional() }))
        .max(50)
        .catch([])
        .parse((raw as { gaps?: unknown } | null)?.gaps ?? []);
      const graph = parseGraph(data.graph);
      const open = new Set<string>();
      for (const m of JSON.stringify(graph.nodes).matchAll(/\$ask:([a-z0-9_]{1,40})/gi)) open.add(m[1]);
      return { kind: "workflow", data: open.size ? { ...data, graph: clearTokens(graph) } : data, gaps: [...open].map((id) => gaps.find((g) => g.id === id) ?? { id, kind: "", label: id }) };
    }
    case "whiteboard": {
      const data = parseJson(bytes) as { format?: unknown; name?: unknown; items?: unknown } | unknown[] | null;
      const items = Array.isArray(data) ? data : data && typeof data === "object" && Array.isArray(data.items) ? data.items : null;
      if (!items) throw fail("Die Whiteboard-Vorlage hat keine Elemente.");
      if (!Array.isArray(data) && data && data.format !== undefined && data.format !== BOARD_TEMPLATE_FORMAT) throw fail("Keine Whiteboard-Vorlage (flowplan.whiteboard-template).");
      const clean = portableTemplateItems(cleanTemplateItems(items));
      if (!clean.items.length) throw fail("Die Whiteboard-Vorlage ist leer.");
      const name = !Array.isArray(data) && data && typeof data.name === "string" && data.name.trim() ? data.name.trim().slice(0, 200) : manifest.title;
      return { kind: "whiteboard", name, items: clean.items, dropped: items.length - clean.items.length };
    }
    case "appearance": {
      const data = parseJson(bytes) as { format?: unknown; theme?: unknown; fonts?: unknown } | null;
      if (!data || typeof data !== "object") throw fail("Das Erscheinungsbild ist ungültig.");
      const themeRaw = "theme" in data ? data.theme : data;
      const theme = workspaceThemeSchema.safeParse(themeRaw);
      if (!theme.success) throw fail("Das Erscheinungsbild ist ungültig.");
      // Faces: listed {id, name, file} or, without a list, every font file
      // under payload/ (its name without the extension is its id).
      const listed = Array.isArray(data.fonts)
        ? z.array(z.object({ id: z.string().regex(/^[\w-]{1,64}$/), name: z.string().max(200).default(""), file: z.string().max(200) })).max(FONT_LIMITS.perWorkspace).safeParse(data.fonts)
        : null;
      if (listed && !listed.success) throw fail("Die Schriftenliste ist ungültig.");
      const candidates = listed
        ? listed.data
        : [...entries.keys()]
            .filter((n) => n.startsWith("payload/") && /\.(woff2?|ttf|otf)$/i.test(n))
            .slice(0, FONT_LIMITS.perWorkspace)
            .map((file) => ({ id: file.replace(/^.*\//, "").replace(/\.[^.]+$/, ""), name: file.replace(/^.*\//, "").replace(/\.[^.]+$/, ""), file }));
      const fonts: LookFont[] = [];
      for (const f of candidates) {
        const data = f.file.startsWith("payload/") ? entries.get(f.file) : undefined;
        if (!data) throw fail("Eine Schrift fehlt im Paket.");
        if (data.length > FONT_LIMITS.bytes) throw fail("Eine Schrift ist größer als 5 MB.", 413);
        if (!sniffFont(data)) throw fail("Eine Schriftdatei ist keine Schrift.");
        fonts.push({ id: f.id, name: f.name || f.id, data });
      }
      return { kind: "appearance", theme: theme.data, fonts };
    }
    case "link-rules": {
      const data = parseJson(bytes) as { rules?: unknown } | unknown[] | null;
      const list = Array.isArray(data) ? data : data && typeof data === "object" && Array.isArray(data.rules) ? data.rules : null;
      if (!list || !list.length) throw fail("Das Paket enthält keine Linkregeln.");
      if (list.length > AUTO_LINK_LIMITS.rules) throw fail("Höchstens 50 Linkregeln.");
      const rules: z.infer<typeof autoLinkRuleSchema>[] = [];
      let invalid = 0;
      for (const entry of list) {
        const rule = autoLinkRuleSchema.safeParse(entry);
        if (!rule.success || ruleProblems(rule.data).length) invalid++;
        else rules.push(rule.data);
      }
      if (!rules.length) throw fail("Keine der Linkregeln ist gültig.");
      return { kind: "link-rules", rules, invalid };
    }
  }
}

// "$ask:<gap>" tokens out of a graph: a string that is only a token (or
// "field:<token>") becomes empty, list entries and `values` keys with one go.
const ASK = /\$ask:[a-z0-9_]{1,40}/gi;
export function clearTokens(graph: WorkflowGraph): WorkflowGraph {
  const clean = (s: string) => {
    const out = s.replace(ASK, "");
    return out === "field:" ? "" : out;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return clean(v);
    if (Array.isArray(v)) return v.map(walk).filter((x) => x !== "" || !v.some((y) => typeof y === "string"));
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v)
          .map(([k, x]) => [clean(k), walk(x)] as const)
          .filter(([k]) => k !== ""),
      );
    return v;
  };
  return { ...graph, nodes: graph.nodes.map((n) => ({ ...n, config: walk(n.config) as Record<string, unknown> })) };
}

// ---- The preview dialog ----

const fixedHost = (url: string) => /^https?:\/\/([^/?#{}\\@\s]+)(?:[/?#]|$)/i.exec(url.trim())?.[1]?.toLowerCase() ?? null;
export function workflowSummary(data: WorkflowExport) {
  const graph = parseGraph(data.graph);
  const hosts = new Set<string>();
  for (const n of graph.nodes) {
    const url = (n.config as { url?: unknown }).url;
    if (n.type === "http.request" && typeof url === "string") {
      const host = fixedHost(url);
      if (host) hosts.add(host);
    }
  }
  const types = graph.nodes.map((n) => n.type);
  return {
    nodes: graph.nodes.map((n) => ({ type: n.type, label: n.label, name: nodeSpec(n.type)?.name ?? null })),
    hosts: [...hosts].sort(),
    ai: types.some((t) => t.startsWith("ai.")),
    email: types.some((t) => t === "notify.email" || t === "trigger.mail.received"),
    chat: types.includes("notify.chat"),
    webhook: types.includes("trigger.webhook"),
    references: Object.keys(data.references).length,
  };
}

export function packagePreview(pkg: ParsedPackage) {
  const m = pkg.manifest;
  const p = pkg.payload;
  const creates = (() => {
    switch (p.kind) {
      case "document":
      case "database":
        return { name: p.name, files: p.files, fields: p.fields, views: p.views, rows: p.rows };
      case "workflow":
        return { name: p.data.title || m.title, workflow: { ...workflowSummary(p.data), gaps: p.gaps.map((g) => g.label) } };
      case "whiteboard":
        return { name: p.name, items: p.items.length, dropped: p.dropped };
      case "appearance":
        return { accent: p.theme.accent ?? null, background: p.theme.background ?? null, fonts: p.fonts.map((f) => f.name) };
      case "link-rules":
        return { rules: p.rules.map((r) => ({ name: r.name || "", pattern: r.pattern, template: r.template })), invalid: p.invalid };
    }
  })();
  return {
    kind: m.kind,
    title: m.title,
    summary: { de: m.summary.de || "", en: m.summary.en || "" },
    description: m.description ? { de: m.description.de || "", en: m.description.en || "" } : null,
    category: m.category,
    tags: m.tags,
    language: m.language,
    minVersion: m.minVersion,
    license: typeof m.license === "string" ? m.license : null,
    author: m.author?.name ? String(m.author.name).slice(0, 120) : null,
    url: typeof m.marketplace?.url === "string" && /^https:\/\//i.test(m.marketplace.url) ? m.marketplace.url : null,
    previews: pkg.previews.map((x) => `data:${imageMime(x.type)};base64,${x.bytes.toString("base64")}`),
    size: pkg.size,
    creates,
  };
}

// ---- Importing ----

export const importTargetSchema = z.object({
  workspaceId: z.uuid(),
  spaceId: z.uuid().nullish(),
  parentId: z.uuid().nullish(),
  private: z.boolean().default(false),
});
export type ImportTarget = z.infer<typeof importTargetSchema>;

// Through the kind's own import, which checks the permissions: templates
// and whiteboard templates editors, a workflow (a paused draft, never
// active) editors of the space, the look and link rules owners.
type ImportResult = { templateId?: string; pageId?: string; unresolved?: number; gaps?: number; imported?: boolean; droppedFonts?: number; added?: number; dropped?: number };
export async function importPackage(user: Identity, pkg: ParsedPackage, rawTarget: unknown): Promise<ImportResult & { kind: MarketplaceKind }> {
  const target = importTargetSchema.parse(rawTarget);
  const wid = target.workspaceId;
  await requireMember(user, wid);
  const p = pkg.payload;
  let result: ImportResult;
  switch (p.kind) {
    case "document":
    case "database": {
      const imported = await importTemplate(user, wid, p.zip, target.private ? "private" : "workspace", target.spaceId ?? null);
      result = { templateId: imported.id };
      break;
    }
    case "workflow": {
      await requireMember(user, wid, "editor");
      if (!target.spaceId) throw fail("Bitte einen Bereich wählen.");
      const { command } = await import("./api");
      const title = (p.data.title || pkg.manifest.title).trim().slice(0, 200) || "Workflow";
      const page = (await command(user, { action: "page.create", workspaceId: wid, spaceId: target.spaceId, parentId: target.parentId ?? undefined, kind: "workflow", title })) as { id: string };
      const imported = (await command(user, { action: "workflow.import", pageId: page.id, data: p.data })) as { unresolved: unknown[] };
      result = { pageId: page.id, unresolved: imported.unresolved.length, gaps: p.gaps.length };
      break;
    }
    case "whiteboard": {
      const imported = await importBoardTemplate(user, wid, { name: p.name, items: p.items, private: target.private });
      result = { templateId: imported.id };
      break;
    }
    case "appearance": {
      await requireMember(user, wid, "owner");
      const look = await importLook(user, wid, { theme: p.theme, fonts: p.fonts }, { replace: true });
      result = { imported: look.imported, droppedFonts: look.droppedFonts };
      break;
    }
    case "link-rules": {
      await requireMember(user, wid, "owner");
      const imported = await importLinkRules(user, wid, p.rules);
      result = { added: imported.added, dropped: imported.dropped + p.invalid };
      break;
    }
  }
  await audit(user.id, "marketplace.import", wid, `${pkg.manifest.kind}: ${pkg.manifest.title}`.slice(0, 300));
  return { kind: pkg.manifest.kind, ...result };
}
