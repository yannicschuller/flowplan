// Block extensions ("Block-Erweiterungen"): the manifest a plugin publishes
// as flowplan-plugin.json and the postMessage protocol between a plugin
// block's sandboxed frame and the page around it. Shared by the server
// (registration, lib/plugins.ts) and the browser (components/plugin-block.ts),
// so it holds no server imports.
import { z } from "zod";

export const MANIFEST_FILE = "flowplan-plugin.json";
// Stored block data (JSON in the block's attributes) and the searchable text
// a plugin may hand over with it.
export const MAX_BLOCK_DATA = 64 * 1024;
export const MAX_BLOCK_TEXT = 2000;
// Frame heights: a plugin asks for a height, the page keeps it in bounds.
export const MIN_FRAME_HEIGHT = 40;
export const MAX_FRAME_HEIGHT = 2000;
export const DEFAULT_FRAME_HEIGHT = 200;
// At most this many records per database query.
export const MAX_QUERY_ROWS = 200;

const uuid = z.uuid();
// Permissions a manifest may request. Databases are named by their page ID
// and granted when an owner registers the plugin.
// "read:database" alone asks for databases the owner picks when registering.
export const PLUGIN_PERMISSION = /^(read:page|read:selection|write:block|read:database|read:database:[0-9a-f-]{36})$/i;
export const pluginPermission = z
  .string()
  .regex(PLUGIN_PERMISSION, "Unbekannte Berechtigung.")
  .transform((value) => value.toLowerCase());
export type PluginPermission = string;
export const databasePermission = (databaseId: string) => `read:database:${databaseId.toLowerCase()}`;
export const grantedDatabases = (permissions: readonly string[]) =>
  permissions.filter((p) => /^read:database:[0-9a-f-]{36}$/.test(p)).map((p) => p.slice("read:database:".length));

// A relative path below the manifest (no scheme, no host, no "..").
const entryPath = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !/^[a-z][a-z0-9+.-]*:|^\/\/|\\|(^|\/)\.\.(\/|$)/i.test(value), "Der Einstieg muss ein relativer Pfad sein.");
const settingField = z.object({
  type: z.enum(["string", "number", "boolean"]),
  label: z.string().trim().min(1).max(80),
  default: z.union([z.string().max(500), z.number(), z.boolean()]).optional(),
});
export const pluginManifestSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    version: z.string().trim().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}([-+][\w.-]{1,30})?$/, "Version im Format 1.2.3 angeben."),
    description: z.string().trim().max(300).optional(),
    // The page loaded into the frame, relative to the manifest.
    entry: entryPath.default("index.html"),
    blocks: z
      .array(
        z.object({
          type: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, "Blocktypen bestehen aus Kleinbuchstaben, Ziffern und Bindestrichen."),
          label: z.string().trim().min(1).max(60),
          // An emoji or a short symbol shown in the block menu.
          icon: z.string().trim().max(8).optional(),
          description: z.string().trim().max(160).optional(),
          // A page of its own for this block type (default: entry).
          entry: entryPath.optional(),
        }),
      )
      .min(1)
      .max(20)
      .refine((blocks) => new Set(blocks.map((b) => b.type)).size === blocks.length, "Blocktypen müssen eindeutig sein."),
    permissions: z.array(pluginPermission).max(20).default([]),
    size: z
      .object({
        height: z.number().int().min(MIN_FRAME_HEIGHT).max(MAX_FRAME_HEIGHT).default(DEFAULT_FRAME_HEIGHT),
        maxHeight: z.number().int().min(MIN_FRAME_HEIGHT).max(MAX_FRAME_HEIGHT).default(800),
      })
      .default({ height: DEFAULT_FRAME_HEIGHT, maxHeight: 800 }),
    settings: z
      .record(z.string().regex(/^[a-zA-Z][\w-]{0,39}$/), settingField)
      .refine((value) => Object.keys(value).length <= 20, "Höchstens 20 Einstellungen.")
      .default({}),
  })
  .transform((manifest) => ({ ...manifest, permissions: [...new Set(manifest.permissions)] }));
export type PluginManifest = z.infer<typeof pluginManifestSchema>;

// Settings an owner stores for a plugin, checked against its manifest.
export function validatePluginSettings(manifest: PluginManifest, input: unknown) {
  const values = z.record(z.string(), z.unknown()).parse(input ?? {});
  const out: Record<string, string | number | boolean> = {};
  for (const [key, field] of Object.entries(manifest.settings)) {
    const value = values[key] ?? field.default;
    if (value === undefined) continue;
    if (field.type === "string") out[key] = z.string().max(500).parse(value);
    else if (field.type === "number") out[key] = z.number().finite().parse(value);
    else out[key] = z.boolean().parse(value);
  }
  return out;
}

// ---- Block data ----

export const byteLength = (text: string) => new TextEncoder().encode(text).length;
// Data as stored in the block: JSON text of at most 64 KB.
export function encodeBlockData(data: unknown) {
  let text: string | undefined;
  try {
    text = JSON.stringify(data ?? null);
  } catch {
    text = undefined;
  }
  if (text === undefined) throw new Error("Die Blockdaten sind kein JSON.");
  if (byteLength(text) > MAX_BLOCK_DATA) throw new Error("Die Blockdaten sind größer als 64 KB.");
  return text;
}
export function decodeBlockData(text: string | null | undefined): unknown {
  if (!text || byteLength(text) > MAX_BLOCK_DATA) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
// Stored attribute values that are too large or not JSON fall back to empty.
export function storedBlockData(text: unknown) {
  if (typeof text !== "string" || !text) return "null";
  return decodeBlockData(text) === null && text !== "null" ? "null" : text;
}
export const blockText = (text: unknown) =>
  typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, MAX_BLOCK_TEXT) : "";

export function clampFrameHeight(height: unknown, maxHeight = MAX_FRAME_HEIGHT) {
  const cap = Math.min(Math.max(maxHeight, MIN_FRAME_HEIGHT), MAX_FRAME_HEIGHT);
  const value = typeof height === "number" && Number.isFinite(height) ? Math.round(height) : DEFAULT_FRAME_HEIGHT;
  return Math.min(Math.max(value, MIN_FRAME_HEIGHT), cap);
}

// ---- postMessage protocol ----

export const PROTOCOL = "flowplan-plugin/1";
// A fresh random nonce per frame; every message of the plugin repeats it.
export const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
export function createNonce() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 32);
}
const envelope = { protocol: z.literal(PROTOCOL), nonce: z.string().regex(NONCE_PATTERN) };
const request = { ...envelope, id: z.string().min(1).max(64) };
export const pluginMessageSchema = z.discriminatedUnion("type", [
  z.object({ ...envelope, type: z.literal("ready") }).strict(),
  z.object({ ...envelope, type: z.literal("resize"), height: z.number().finite() }).strict(),
  z.object({ ...request, type: z.literal("getData") }).strict(),
  z.object({ ...request, type: z.literal("setData"), data: z.unknown(), text: z.string().max(MAX_BLOCK_TEXT * 2).optional() }).strict(),
  z.object({ ...request, type: z.literal("getContext") }).strict(),
  z
    .object({ ...request, type: z.literal("query"), databaseId: uuid, limit: z.number().int().min(1).max(MAX_QUERY_ROWS).optional() })
    .strict(),
]);
export type PluginMessage = z.infer<typeof pluginMessageSchema>;

// A message from a frame, or null when it is not one of ours: wrong shape,
// wrong protocol or a nonce other than the one this frame was given.
export function parsePluginMessage(raw: unknown, nonce: string): PluginMessage | null {
  const parsed = pluginMessageSchema.safeParse(raw);
  if (!parsed.success || parsed.data.nonce !== nonce) return null;
  return parsed.data;
}
// Messages from a sandboxed frame (sandbox="allow-scripts", no
// allow-same-origin) come from an opaque origin: "null", and only from the
// frame's own window.
export function trustedSource(event: { origin: string; source: unknown }, frame: unknown) {
  return event.origin === "null" && !!frame && event.source === frame;
}

export type FrameContext = {
  // Viewers and published pages: nothing is written.
  readOnly: boolean;
  // Published pages: no database queries either.
  public: boolean;
  permissions: readonly string[];
};
// Whether a request may run in this frame; the reason otherwise.
export function permissionError(message: PluginMessage, context: FrameContext): string | null {
  if (message.type === "setData") {
    if (context.readOnly) return "read-only";
    if (!context.permissions.includes("write:block")) return "permission:write:block";
  }
  if (message.type === "query") {
    if (context.public) return "public";
    if (!context.permissions.includes(databasePermission(message.databaseId))) return `permission:${databasePermission(message.databaseId)}`;
  }
  return null;
}

// What getContext answers: never who is reading (no name, no e-mail). The
// page title and the selected text only with their permission.
export function pluginContext(
  input: { title: string; theme: "light" | "dark"; locale: string; selection?: string; readOnly: boolean; blockType: string },
  permissions: readonly string[],
) {
  return {
    theme: input.theme,
    locale: input.locale,
    readOnly: input.readOnly,
    blockType: input.blockType,
    ...(permissions.includes("read:page") ? { page: { title: input.title.slice(0, 500) } } : {}),
    ...(permissions.includes("read:selection") ? { selection: (input.selection || "").slice(0, 5000) } : {}),
  };
}

// Messages the page sends into a frame.
export type HostMessage =
  | { protocol: typeof PROTOCOL; nonce: string; type: "init"; blockType: string; readOnly: boolean; permissions: string[]; settings: Record<string, unknown> }
  | { protocol: typeof PROTOCOL; nonce: string; type: "response"; id: string; ok: true; result: unknown }
  | { protocol: typeof PROTOCOL; nonce: string; type: "response"; id: string; ok: false; error: string }
  | { protocol: typeof PROTOCOL; nonce: string; type: "data"; data: unknown };
