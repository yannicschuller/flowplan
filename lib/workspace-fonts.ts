// A workspace's look on the server (#196, lib/workspace-theme.ts): reading
// and saving it (owners), the faces its owners upload, and each person's
// choice of Flowplan's own look (users.plain_look).
//
//   workspaces.theme   JSON (accent, background, fonts) or NULL
//   workspace_fonts(id, workspace_id, name, mime, format, variable, data, created_by, created_at)
//     Uploaded faces (WOFF2, WOFF, TrueType, OpenType; at most 5 MB each and
//     20 per workspace), blobs like notebook templates: counted against the
//     workspace quota and the uploader's storage, removed with the workspace.
//     Served to members and guests of the workspace and – for its published
//     pages and forms – through the publication's or form's own address,
//     never to anyone else.
import { z } from "zod";
import { all, audit, id, one, run } from "./db";
import { HttpError } from "./auth";
import { requireMember } from "./permissions";
import { enforceQuota } from "./instance-ops";
import { enforceUserStorage } from "./user-limits";
import { sanitizeFileName } from "./upload-safety";
import { CUSTOM_PREFIX, FONT_SLOTS } from "./theme-fonts";
import { normalizeTheme, parseTheme, themeCustomFonts, workspaceThemeSchema, type ThemeFont, type WorkspaceLook, type WorkspaceTheme } from "./workspace-theme";
import type { Identity } from "./types";

export const FONT_LIMITS = { bytes: 5 * 1024 * 1024, perWorkspace: 20, nameLength: 60 };
export type FontFormat = ThemeFont["format"];
const MIME: Record<FontFormat, string> = { woff2: "font/woff2", woff: "font/woff", truetype: "font/ttf", opentype: "font/otf" };
export const fontMime = (format: FontFormat) => MIME[format];

// ---- What a file is ----

// WOFF2's table directory names known tables by index (WOFF2 spec, 5.1).
const WOFF2_TAGS = "cmap head hhea hmtx maxp name OS/2 post cvt  fpgm glyf loca prep CFF  VORG EBDT EBLC gasp hdmx kern LTSH PCLT VDMX vhea vmtx BASE GDEF GPOS GSUB EBSC JSTF MATH CBDT CBLC COLR CPAL SVG  sbix acnt avar bdat bloc bsln cvar fdsc feat fmtx fvar gvar hsty just lcar mort morx opbd prop trak Zapf Silf Glat Gloc Feat Sill"
  .match(/.{4}\s?/g)!
  .map((t) => t.slice(0, 4));

function woff2Tags(bytes: Buffer) {
  const count = bytes.readUInt16BE(12);
  const tags: string[] = [];
  let at = 48;
  const base128 = () => {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const b = bytes[at++];
      if (b === undefined || (i === 0 && b === 0x80)) throw new Error("bad");
      value = value * 128 + (b & 0x7f);
      if (!(b & 0x80)) return value;
    }
    throw new Error("bad");
  };
  for (let i = 0; i < count; i++) {
    const flags = bytes[at++];
    if (flags === undefined) throw new Error("bad");
    const index = flags & 0x3f;
    let tag: string;
    if (index === 63) {
      tag = bytes.toString("latin1", at, at + 4);
      at += 4;
    } else tag = WOFF2_TAGS[index];
    const version = (flags >> 6) & 3;
    base128();
    // glyf and loca carry a transform length unless version 3 (null
    // transform); every other table only when its version is not 0.
    if (tag === "glyf" || tag === "loca" ? version === 0 : version !== 0) base128();
    tags.push(tag);
  }
  return tags;
}
function sfntTags(bytes: Buffer, directory: number, entrySize: number, countAt: number) {
  const count = bytes.readUInt16BE(countAt);
  if (directory + count * entrySize > bytes.length) throw new Error("bad");
  return Array.from({ length: count }, (_, i) => bytes.toString("latin1", directory + i * entrySize, directory + i * entrySize + 4));
}

// The format of a font file from its first bytes (never from its name or
// the browser's type), and whether it is a variable font (an fvar table).
// null for anything else, font collections included.
export function sniffFont(bytes: Buffer): { format: FontFormat; mime: string; variable: boolean } | null {
  if (bytes.length < 64) return null;
  const magic = bytes.toString("latin1", 0, 4);
  let format: FontFormat, tags: string[];
  try {
    if (magic === "wOF2") [format, tags] = ["woff2", woff2Tags(bytes)];
    else if (magic === "wOFF") [format, tags] = ["woff", sfntTags(bytes, 44, 20, 12)];
    else if (magic === "OTTO") [format, tags] = ["opentype", sfntTags(bytes, 12, 16, 4)];
    else if (bytes.readUInt32BE(0) === 0x00010000 || magic === "true") [format, tags] = ["truetype", sfntTags(bytes, 12, 16, 4)];
    else return null;
  } catch {
    return null;
  }
  // A font has at least these tables; random bytes after a magic do not.
  if (!tags.length || !["cmap", "head"].every((t) => tags.includes(t))) return null;
  return { format, mime: MIME[format], variable: tags.includes("fvar") };
}

// ---- The look ----

type FontRow = { id: string; workspace_id: string; name: string; mime: string; format: FontFormat; variable: number; created_by: string | null; created_at: number };
const asThemeFont = (f: Pick<FontRow, "id" | "name" | "format" | "variable">): ThemeFont => ({ id: f.id, name: f.name, format: f.format, variable: !!Number(f.variable) });

export async function workspaceFonts(workspaceId: string) {
  return (await all<FontRow>("SELECT id,workspace_id,name,mime,format,variable,created_by,created_at FROM workspace_fonts WHERE workspace_id=? ORDER BY lower(name),created_at", workspaceId)).map(asThemeFont);
}
export async function storedTheme(workspaceId: string) {
  return parseTheme((await one<{ theme: string | null }>("SELECT theme FROM workspaces WHERE id=?", workspaceId))?.theme);
}
// The look as pages render it: the theme and the uploaded faces it uses
// (`allFonts`: every face of the workspace, for the settings).
export async function workspaceLook(workspaceId: string, allFonts = false): Promise<WorkspaceLook> {
  const theme = await storedTheme(workspaceId);
  const used = new Set(themeCustomFonts(theme));
  const fonts = allFonts || used.size ? (await workspaceFonts(workspaceId)).filter((f) => allFonts || used.has(f.id)) : [];
  return { theme, fonts };
}

// Owners only. Uploaded faces must be the workspace's own.
export async function saveWorkspaceTheme(user: Identity, workspaceId: string, input: unknown) {
  await requireMember(user, workspaceId, "owner");
  const theme: WorkspaceTheme | null = input === null ? null : normalizeTheme(workspaceThemeSchema.parse(input));
  const custom = themeCustomFonts(theme);
  if (custom.length) {
    const own = new Set((await all<{ id: string }>("SELECT id FROM workspace_fonts WHERE workspace_id=?", workspaceId)).map((f) => f.id));
    if (custom.some((fid) => !own.has(fid))) throw new HttpError(400, "Unbekannte Schrift.");
  }
  await run("UPDATE workspaces SET theme=? WHERE id=?", theme ? JSON.stringify(theme) : null, workspaceId);
  await audit(user.id, "workspace.theme", workspaceId);
  return await workspaceLook(workspaceId, true);
}

// Flowplan's own look for this person in every workspace.
export async function plainLook(userId: string) {
  return !!Number((await one<{ plain_look: number | null }>("SELECT plain_look FROM users WHERE id=?", userId))?.plain_look);
}
export async function setPlainLook(user: Identity, input: unknown) {
  const plain = z.boolean().parse(input);
  await run("UPDATE users SET plain_look=? WHERE id=?", plain ? 1 : 0, user.id);
  return { plainLook: plain };
}

// ---- Uploaded faces ----

export async function uploadWorkspaceFont(user: Identity, workspaceId: string, input: { name: unknown; file: { name: string; bytes: Buffer } }) {
  await requireMember(user, workspaceId, "owner");
  if (user.demo) throw new HttpError(403, "In der Demo nicht verfügbar. Registriere dich, um das zu nutzen.");
  if (input.file.bytes.length > FONT_LIMITS.bytes) throw new HttpError(413, "Höchstens 5 MB pro Schrift.");
  const sniffed = sniffFont(input.file.bytes);
  if (!sniffed) throw new HttpError(400, "Bitte eine Schriftdatei wählen (WOFF2, WOFF, TTF oder OTF).");
  const count = Number((await one<{ n: number }>("SELECT COUNT(*) n FROM workspace_fonts WHERE workspace_id=?", workspaceId))?.n ?? 0);
  if (count >= FONT_LIMITS.perWorkspace) throw new HttpError(409, `Dieser Arbeitsbereich hat schon ${FONT_LIMITS.perWorkspace} eigene Schriften.`);
  await enforceQuota(workspaceId, input.file.bytes.length);
  await enforceUserStorage(user, input.file.bytes.length, workspaceId);
  const fallback = sanitizeFileName(input.file.name, "Schrift").replace(/\.[^.]+$/, "").slice(0, FONT_LIMITS.nameLength) || "Schrift";
  const name = z.string().trim().min(1).max(FONT_LIMITS.nameLength).catch(fallback).parse(input.name);
  const fontId = id();
  await run(
    "INSERT INTO workspace_fonts(id,workspace_id,name,mime,format,variable,data,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
    fontId,
    workspaceId,
    name,
    sniffed.mime,
    sniffed.format,
    sniffed.variable ? 1 : 0,
    input.file.bytes,
    user.id,
    Date.now(),
  );
  await audit(user.id, "workspace.font.add", workspaceId, name);
  return asThemeFont({ id: fontId, name, format: sniffed.format, variable: sniffed.variable ? 1 : 0 });
}

// The look stops using a deleted face (its slots go back to the default).
export async function deleteWorkspaceFont(user: Identity, workspaceId: string, fontId: unknown) {
  await requireMember(user, workspaceId, "owner");
  const key = z.uuid().parse(fontId);
  const row = await one<{ id: string; name: string }>("SELECT id,name FROM workspace_fonts WHERE id=? AND workspace_id=?", key, workspaceId);
  if (!row) throw new HttpError(404, "Schrift nicht gefunden.");
  const theme = await storedTheme(workspaceId);
  if (theme?.fonts && FONT_SLOTS.some((s) => theme.fonts?.[s] === `${CUSTOM_PREFIX}${row.id}`)) {
    const fonts = Object.fromEntries(Object.entries(theme.fonts).filter(([, v]) => v !== `${CUSTOM_PREFIX}${row.id}`));
    const next = normalizeTheme({ ...theme, fonts });
    await run("UPDATE workspaces SET theme=? WHERE id=?", next ? JSON.stringify(next) : null, workspaceId);
  }
  await run("DELETE FROM workspace_fonts WHERE id=?", row.id);
  await audit(user.id, "workspace.font.delete", workspaceId, row.name);
  return await workspaceLook(workspaceId, true);
}

export async function renameWorkspaceFont(user: Identity, workspaceId: string, fontId: unknown, name: unknown) {
  await requireMember(user, workspaceId, "owner");
  const key = z.uuid().parse(fontId);
  const value = z.string().trim().min(1).max(FONT_LIMITS.nameLength).parse(name);
  if (!(await run("UPDATE workspace_fonts SET name=? WHERE id=? AND workspace_id=?", value, key, workspaceId)).changes) throw new HttpError(404, "Schrift nicht gefunden.");
  return await workspaceLook(workspaceId, true);
}

// The bytes of a face for whoever may see the look: the workspace's members
// and guests (`user`), or visitors of one of its publications or forms
// (`workspaceOf`: the workspace the publication or form belongs to,
// checked by the caller). Another workspace's face is "not found".
export async function workspaceFontFile(fontId: string, access: { user: Identity } | { workspaceOf: string }) {
  const key = z.uuid().safeParse(fontId);
  if (!key.success) throw new HttpError(404, "Schrift nicht gefunden.");
  const row = await one<FontRow & { data: Uint8Array }>("SELECT * FROM workspace_fonts WHERE id=?", key.data);
  if (!row) throw new HttpError(404, "Schrift nicht gefunden.");
  if ("user" in access) {
    try {
      await requireMember(access.user, row.workspace_id);
    } catch {
      throw new HttpError(404, "Schrift nicht gefunden.");
    }
  } else if (access.workspaceOf !== row.workspace_id) throw new HttpError(404, "Schrift nicht gefunden.");
  return { mime: MIME[row.format] ?? "application/octet-stream", data: Buffer.from(row.data) };
}
// Fonts are never changed in place (a new upload is a new id): cached for
// a year, privately (members) or by anyone (publications).
export function fontResponse(file: { mime: string; data: Buffer }, shared = false) {
  return new Response(new Uint8Array(file.data), {
    headers: {
      "Content-Type": file.mime,
      "Content-Length": String(file.data.length),
      "Cache-Control": `${shared ? "public" : "private"}, max-age=31536000, immutable`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}

// ---- Archives (lib/archive.ts) ----

// The look and its uploaded faces for a workspace archive.
export async function exportLook(workspaceId: string) {
  const theme = await storedTheme(workspaceId);
  const fonts = await all<{ id: string; name: string; data: Uint8Array }>("SELECT id,name,data FROM workspace_fonts WHERE workspace_id=? ORDER BY created_at", workspaceId);
  return { theme, fonts: fonts.map((f) => ({ id: f.id, name: f.name, data: Buffer.from(f.data) })) };
}
// An archive's look in the workspace it is imported into: only by an owner
// and only into a workspace that still has Flowplan's own look (an import
// never replaces a look someone chose). Checked like the settings: the
// theme by workspaceThemeSchema, each face like an upload (a real font, at
// most 5 MB, at most 20 per workspace, within the workspace quota and the
// importer's storage). What fails is left out and counted (`droppedTheme`,
// `droppedFonts`), never the whole import. Faces get new ids; a slot whose
// face was left out goes back to the default. `data: null`: a face the
// archive declares larger than allowed (not read at all).
// `replace` (a look the owner chose to apply, from the marketplace):
// replaces the workspace's look instead of only filling an empty one.
export async function importLook(user: Identity, workspaceId: string, look: { theme: unknown; fonts: { id: string; name: string; data: Buffer | null }[] }, options: { replace?: boolean } = {}) {
  const result = { imported: false, droppedTheme: false, droppedFonts: 0 };
  if ((await one<{ role: string }>("SELECT role FROM members WHERE workspace_id=? AND user_id=?", workspaceId, user.id))?.role !== "owner") return result;
  if (!options.replace && (await storedTheme(workspaceId))) return result;
  const parsed = look.theme === null || look.theme === undefined ? null : workspaceThemeSchema.safeParse(look.theme);
  if (parsed && !parsed.success) result.droppedTheme = true;
  const remap = new Map<string, string>();
  let count = Number((await one<{ n: number }>("SELECT COUNT(*) n FROM workspace_fonts WHERE workspace_id=?", workspaceId))?.n ?? 0);
  for (const font of look.fonts) {
    const sniffed = font.data && font.data.length <= FONT_LIMITS.bytes && count < FONT_LIMITS.perWorkspace ? sniffFont(font.data) : null;
    if (!sniffed || !font.data) {
      result.droppedFonts++;
      continue;
    }
    try {
      await enforceQuota(workspaceId, font.data.length);
      await enforceUserStorage(user, font.data.length, workspaceId);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      result.droppedFonts++;
      continue;
    }
    const fontId = id();
    await run(
      "INSERT INTO workspace_fonts(id,workspace_id,name,mime,format,variable,data,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      fontId,
      workspaceId,
      font.name.trim().slice(0, FONT_LIMITS.nameLength).trim() || "Schrift",
      sniffed.mime,
      sniffed.format,
      sniffed.variable ? 1 : 0,
      font.data,
      user.id,
      Date.now(),
    );
    remap.set(font.id, fontId);
    count++;
  }
  const chosen = parsed?.success ? parsed.data : {};
  const fonts: Record<string, string> = {};
  for (const slot of FONT_SLOTS) {
    const ref = chosen.fonts?.[slot];
    if (!ref) continue;
    if (!ref.startsWith(CUSTOM_PREFIX)) fonts[slot] = ref;
    else if (remap.has(ref.slice(CUSTOM_PREFIX.length))) fonts[slot] = `${CUSTOM_PREFIX}${remap.get(ref.slice(CUSTOM_PREFIX.length))}`;
  }
  const theme = normalizeTheme({ ...chosen, fonts });
  if (!theme && !remap.size) return result;
  if (theme) await run("UPDATE workspaces SET theme=? WHERE id=?", JSON.stringify(theme), workspaceId);
  if (options.replace) await audit(user.id, "workspace.theme", workspaceId);
  result.imported = true;
  return result;
}
