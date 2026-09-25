import { createHash } from "node:crypto";
import { templateCategoryIds } from "./template-categories";
import { quotaCheckpoint } from "./instance-ops";
import { z } from "zod";
import { all, id, run, transaction } from "./db";
import { HttpError } from "./auth";
import { requireMember } from "./permissions";
import { readZip, writeZip } from "./archive";
import { requireTemplate, savedDatabaseTemplateSchema } from "./page-templates";
import { mapTemplateFiles } from "./template-files";
import { appearanceSchema } from "./page-appearance";
import type { Identity } from "./types";

// Portable template files: template.json (manifest and content) plus the
// attachments under files/<original id>, verified by SHA-256.
export const TEMPLATE_FORMAT = "flowplan-template-1";
const manifestSchema = z.object({
  format: z.literal(TEMPLATE_FORMAT),
  name: z.string().trim().min(1).max(200),
  kind: z.enum(["document", "database"]),
  category: z.enum(templateCategoryIds).or(z.literal("")).catch("").optional(),
  payload: z.string().max(20_000_000),
  files: z
    .array(
      z.object({
        id: z.string().uuid(),
        name: z.string().max(300),
        mime: z.string().max(200),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(200),
});
const sha = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

export async function exportTemplate(
  user: Identity,
  workspaceId: string,
  templateId: string,
) {
  const template = requireTemplate(user, templateId, workspaceId);
  const files = all<{
    original_id: string;
    name: string;
    mime: string;
    data: Uint8Array;
  }>(
    "SELECT original_id,name,mime,data FROM template_files WHERE template_id=?",
    template.id,
  );
  const manifest = {
    format: TEMPLATE_FORMAT,
    name: template.name,
    kind: template.kind,
    category: template.category || "",
    payload: template.payload,
    files: files.map((f) => ({
      id: f.original_id,
      name: f.name,
      mime: f.mime,
      sha256: sha(f.data),
    })),
  };
  const entries = new Map<string, Buffer>([
    ["template.json", Buffer.from(JSON.stringify(manifest))],
    ...files.map(
      (f) =>
        [`files/${f.original_id}`, Buffer.from(f.data)] as [string, Buffer],
    ),
  ]);
  return { name: template.name, zip: await writeZip(entries) };
}

// Validates like saving from a page: document HTML or a complete database
// template, and every referenced attachment must be included.
export async function importTemplate(
  user: Identity,
  workspaceId: string,
  bytes: Buffer,
  visibility: "private" | "workspace",
) {
  requireMember(user, workspaceId, "editor");
  const entries = await readZip(bytes, { foreign: true, maxEntries: 202 });
  const raw = entries.get("template.json");
  if (!raw) throw new HttpError(400, "template.json fehlt.");
  let manifest: z.infer<typeof manifestSchema>;
  try {
    manifest = manifestSchema.parse(JSON.parse(raw.toString("utf8")));
  } catch {
    throw new HttpError(400, "Keine gültige Flowplan-Vorlage.");
  }
  let content: unknown;
  try {
    content = JSON.parse(manifest.payload);
  } catch {
    throw new HttpError(400, "Vorlageninhalt ist beschädigt.");
  }
  const valid =
    manifest.kind === "database"
      ? savedDatabaseTemplateSchema.safeParse(content).success
      : z
          .object({
            html: z.string().max(2_000_000),
            appearance: appearanceSchema.optional(),
          })
          .safeParse(content).success;
  if (!valid) throw new HttpError(400, "Vorlageninhalt ist ungültig.");
  const listed = new Map(manifest.files.map((f) => [f.id, f]));
  const referenced = new Set<string>();
  mapTemplateFiles(manifest.payload, (url) => {
    const fid = /^\/api\/files\/([0-9a-f-]{36})/i.exec(url)?.[1];
    if (fid) referenced.add(fid);
    return url;
  });
  for (const fid of referenced)
    if (!listed.has(fid)) throw new HttpError(400, "Ein Vorlagenanhang fehlt.");
  for (const file of manifest.files) {
    const data = entries.get(`files/${file.id}`);
    if (!data || sha(data) !== file.sha256)
      throw new HttpError(
        400,
        `Anhang „${file.name}“ fehlt oder ist beschädigt.`,
      );
  }
  return transaction(() => {
    const quota = quotaCheckpoint(workspaceId);
    const templateId = id();
    run(
      "INSERT INTO templates(id,workspace_id,name,kind,payload,created_by,visibility,category) VALUES(?,?,?,?,?,?,?,?)",
      templateId,
      workspaceId,
      manifest.name,
      manifest.kind,
      manifest.payload,
      user.id,
      visibility,
      manifest.category || "",
    );
    for (const file of manifest.files)
      run(
        "INSERT INTO template_files(id,template_id,original_id,name,mime,data) VALUES(?,?,?,?,?,?)",
        id(),
        templateId,
        file.id,
        file.name,
        file.mime,
        entries.get(`files/${file.id}`)!,
      );
    quota();
    return { id: templateId };
  }, user);
}
