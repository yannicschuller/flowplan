// Own whiteboard templates: a board or a selection saved for the
// workspace (or only for oneself) and inserted from the template gallery
// on any board of the workspace. Page templates (lib/page-templates.ts)
// replace a whole page and belong to page kinds; these are pieces of a
// board, inserted where the view is, so they have their own table
// (schema 71 in lib/db.ts).
import { z } from "zod";
import { all, id, one, run } from "./db";
import { HttpError } from "./auth";
import { isGuest, requireMember, requirePage } from "./permissions";
import { safeImageSource, whiteboardItemTypes, shapeKinds, type WhiteboardItem } from "./whiteboard-model";
import { boardEmbed, cropSchema, withValidExtras } from "./whiteboard-embeds";
import { cleanRackFields, type CableData, type DeviceData, type RackData } from "./whiteboard-rack";
import type { Identity } from "./types";

export const MAX_TEMPLATE_ITEMS = 1000;
const finite = z.number().finite().min(-1e7).max(1e7);
const end = z.object({ id: z.string().max(64).optional(), x: finite, y: finite, port: z.string().max(64).optional() });
// One element of a template, as the board stores it. Everything about
// people (votes, stamps, comments, authors) stays on the board.
export const templateDraftSchema = z
  .object({
    id: z.string().regex(/^[\w-]{1,64}$/),
    type: z.enum(whiteboardItemTypes).exclude(["comment"]),
    x: finite,
    y: finite,
    w: z.number().finite().min(0).max(1e6),
    h: z.number().finite().min(0).max(1e6),
    z: finite.optional(),
    rotation: finite.optional(),
    text: z.string().max(10000).optional(),
    fontSize: z.number().finite().min(1).max(500).optional(),
    align: z.enum(["left", "center", "right"]).optional(),
    bold: z.boolean().optional(),
    fill: z.string().max(40).optional(),
    stroke: z.string().max(40).optional(),
    strokeWidth: z.number().finite().min(0).max(100).optional(),
    textColor: z.string().max(40).optional(),
    shape: z.enum(shapeKinds).optional(),
    points: z.array(z.number().finite()).max(20000).optional(),
    pressures: z.array(z.number().finite()).max(10000).optional(),
    from: end.optional(),
    to: end.optional(),
    route: z.enum(["straight", "elbow", "curved"]).optional(),
    startArrow: z.boolean().optional(),
    endArrow: z.boolean().optional(),
    dashed: z.boolean().optional(),
    src: z.string().max(2000).optional(),
    pageId: z.string().max(64).optional(),
    rowId: z.string().max(64).optional(),
    emoji: z.string().max(200).optional(),
    cells: z.array(z.array(z.string().max(2000)).max(20)).max(50).optional(),
    header: z.boolean().optional(),
    credit: z.string().max(500).optional(),
    groups: z.array(z.string()).optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
    link: z.string().optional(),
    crop: cropSchema.optional().catch(undefined),
    slide: z.number().optional(),
    notes: z.string().optional(),
    presentHidden: z.boolean().optional(),
    url: z.string().max(2000).optional(),
    page: z.number().optional(),
    // Racks, devices and cables (#90), checked by cleanRackFields.
    rack: z.custom<RackData>().optional(),
    device: z.custom<DeviceData>().optional(),
    cable: z.custom<CableData>().optional(),
    rackId: z.string().max(64).optional(),
    u: z.number().optional(),
  })
  .strip();
export type TemplateDraft = z.infer<typeof templateDraftSchema>;

// Drafts as stored: valid, ordered by depth, pictures and embeds only from
// allowed sources, newer properties checked (lib/whiteboard-embeds.ts).
export function cleanTemplateItems(raw: unknown): TemplateDraft[] {
  const list = z.array(z.unknown()).max(MAX_TEMPLATE_ITEMS).parse(raw);
  const out: TemplateDraft[] = [];
  for (const entry of list) {
    const parsed = templateDraftSchema.safeParse(entry);
    if (!parsed.success) continue;
    const item = cleanRackFields(withValidExtras(parsed.data as Partial<WhiteboardItem>)) as TemplateDraft;
    if (item.type === "image" && !safeImageSource(item.src)) continue;
    if (item.type === "embed" && !boardEmbed(item as WhiteboardItem)) continue;
    out.push(item);
  }
  if (!out.length) throw new HttpError(400, "Die Vorlage ist leer.");
  return out.sort((a, b) => (a.z || 0) - (b.z || 0));
}

type Row = { id: string; workspace_id: string; name: string; items: string; created_by: string | null; visibility: string; created_at: number };
async function boardPage(user: Identity, pageId: unknown, write = false) {
  const page = await requirePage(user, z.uuid().parse(pageId), write);
  if (page.kind !== "whiteboard") throw new HttpError(400, "Kein Whiteboard.");
  return page;
}
export async function listBoardTemplates(user: Identity, pageId: unknown) {
  const page = await boardPage(user, pageId);
  const role = await requireMember(user, page.workspace_id);
  const guest = await isGuest(user, page.workspace_id);
  const names = new Map((await all<{ id: string; name: string }>("SELECT id,name FROM users")).map((u) => [u.id, u.name]));
  return (await all<Row>(
    `SELECT * FROM whiteboard_templates WHERE workspace_id=? AND (created_by=? OR (visibility='workspace' AND ?=0)) ORDER BY lower(name)`,
    page.workspace_id,
    user.id,
    guest ? 1 : 0,
  )).map((row) => ({
    id: row.id,
    name: row.name,
    private: row.visibility === "private",
    author: row.created_by ? names.get(row.created_by) || "" : "",
    items: (() => {
      try {
        return cleanTemplateItems(JSON.parse(row.items));
      } catch {
        return [];
      }
    })(),
    canDelete: row.created_by === user.id || role === "owner",
  }));
}
const saveInput = z.object({
  name: z.string().trim().min(1).max(200),
  items: z.array(z.unknown()).min(1).max(MAX_TEMPLATE_ITEMS),
  private: z.boolean().optional(),
});
export async function saveBoardTemplate(user: Identity, pageId: unknown, raw: unknown) {
  const page = await boardPage(user, pageId, true);
  await requireMember(user, page.workspace_id, "editor");
  const input = saveInput.parse(raw);
  const items = cleanTemplateItems(input.items);
  const json = JSON.stringify(items);
  if (json.length > 4_000_000) throw new HttpError(413, "Vorlage zu groß.");
  if (((await one<{ n: number }>("SELECT COUNT(*) n FROM whiteboard_templates WHERE workspace_id=?", page.workspace_id))?.n || 0) >= 500)
    throw new HttpError(409, "Dieser Arbeitsbereich hat schon 500 Whiteboard-Vorlagen.");
  const templateId = id();
  await run(
    "INSERT INTO whiteboard_templates(id,workspace_id,name,items,created_by,visibility,created_at) VALUES(?,?,?,?,?,?,?)",
    templateId,
    page.workspace_id,
    input.name,
    json,
    user.id,
    input.private ? "private" : "workspace",
    Date.now(),
  );
  return { id: templateId };
}
export async function deleteBoardTemplate(user: Identity, pageId: unknown, templateId: unknown) {
  const page = await boardPage(user, pageId);
  const role = await requireMember(user, page.workspace_id, "editor");
  const row = await one<Row>("SELECT * FROM whiteboard_templates WHERE id=? AND workspace_id=?", z.uuid().parse(templateId), page.workspace_id);
  if (!row) throw new HttpError(404, "Vorlage fehlt.");
  if (row.created_by !== user.id && role !== "owner")
    throw new HttpError(403, "Nur der Ersteller oder ein Besitzer darf die Vorlage verwalten.");
  await run("DELETE FROM whiteboard_templates WHERE id=?", row.id);
  return { ok: true };
}
