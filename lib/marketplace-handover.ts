// The browser hand-overs with the Flowplan Marketplace (docs: Marketplace),
// as pure functions the components and the tests share. Client-safe.
//
//   Publishing (instance → marketplace): the instance opens
//   <marketplace>/submit?handover=1; that page posts
//   {type: "flowplan-marketplace-ready"} to its opener; the instance answers
//   {type: "flowplan-marketplace-package", name, bytes} – only to the
//   configured marketplace origin and only to the window it opened.
//
//   Importing (marketplace → instance): the marketplace opens
//   <instance>/#marketplace-import; this page posts
//   {type: "flowplan-instance-ready", version} to its opener with the
//   marketplace origin as target; the marketplace answers
//   {type: "flowplan-marketplace-template", id, version, bytes, sha256, …},
//   accepted only from that origin and from the opener, and only when the
//   bytes match the checksum.
export const MAX_PACKAGE_BYTES = 25 * 1024 * 1024;
export const PACKAGE_EXTENSION = ".flowplan-template";
export const IMPORT_HASH = "#marketplace-import";

export const SUBMIT_READY = "flowplan-marketplace-ready";
export const SUBMIT_PACKAGE = "flowplan-marketplace-package";
export const INSTANCE_READY = "flowplan-instance-ready";
export const TEMPLATE_MESSAGE = "flowplan-marketplace-template";

// Links that open the marketplace carry #from=<this instance's origin>: the
// marketplace keeps it as the visitor's instance for "In Flowplan öffnen" –
// in the browser only; a fragment never reaches its server.
export function withFrom(url: string, instanceOrigin?: string | null) {
  if (!instanceOrigin) return url;
  return `${url}${url.includes("#") ? "&" : "#"}from=${encodeURIComponent(instanceOrigin)}`;
}
export const submitAddress = (origin: string, instanceOrigin?: string | null) => withFrom(`${origin}/submit?handover=1`, instanceOrigin);
// The marketplace for browsing (a path on it, default the start page); null
// when the marketplace is off here (FLOWPLAN_MARKETPLACE_URL=off or the
// admin switch: no config).
export function browseAddress(config: { origin: string } | null | undefined, instanceOrigin?: string | null, path = "/") {
  if (!config) return null;
  return withFrom(`${config.origin}${path.startsWith("/") ? path : `/${path}`}`, instanceOrigin);
}
// A marketplace page the marketplace itself named (a template's url): the
// fragment only when it really is on the configured marketplace.
export function marketplacePageAddress(url: string, config: { origin: string } | null | undefined, instanceOrigin?: string | null) {
  try {
    if (config && new URL(url).origin === config.origin) return withFrom(url, instanceOrigin);
  } catch {}
  return url;
}
export const isImportHash = (hash: string) => hash === IMPORT_HASH || hash.startsWith(`${IMPORT_HASH}&`) || hash.startsWith(`${IMPORT_HASH}?`);

// Messages are answered only when they come from the configured origin and
// from the window we expect (the opener, or the window we opened).
export type MessageLike = { origin: string; source: unknown; data: unknown };
export function trustedSource(event: MessageLike, origin: string | null, expected: unknown) {
  return !!origin && !!expected && event.origin === origin && event.source === expected;
}

export const instanceReady = (version: string) => ({ type: INSTANCE_READY, version: version.slice(0, 40) });

// {type: "flowplan-marketplace-ready"} from the submit page.
export const isSubmitReady = (data: unknown) => !!data && typeof data === "object" && (data as { type?: unknown }).type === SUBMIT_READY;

export const packageMessage = (name: string, bytes: ArrayBuffer) => ({ type: SUBMIT_PACKAGE, name: name.slice(0, 120), bytes });

export type TemplateMessage = {
  id: string;
  version: number;
  bytes: ArrayBuffer;
  sha256: string;
  slug?: string;
  title?: string;
  kind?: string;
  author?: string;
  license?: string;
  url?: string;
};
const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const isBuffer = (v: unknown): v is ArrayBuffer => v instanceof ArrayBuffer || Object.prototype.toString.call(v) === "[object ArrayBuffer]";

// The template from the marketplace: required id, version, bytes and a
// hex sha256; the extras only for the preview (the package itself decides).
export function parseTemplateMessage(data: unknown): TemplateMessage | null {
  if (!data || typeof data !== "object") return null;
  const m = data as Record<string, unknown>;
  if (m.type !== TEMPLATE_MESSAGE) return null;
  if (!isBuffer(m.bytes) || m.bytes.byteLength === 0 || m.bytes.byteLength > MAX_PACKAGE_BYTES) return null;
  if (typeof m.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(m.sha256)) return null;
  const id = text(m.id, 100);
  if (!id || typeof m.version !== "number" || !Number.isInteger(m.version) || m.version < 0) return null;
  const url = text(m.url, 500);
  return {
    id,
    version: m.version,
    bytes: m.bytes,
    sha256: m.sha256.toLowerCase(),
    slug: text(m.slug, 120),
    title: text(m.title, 200),
    kind: text(m.kind, 30),
    author: text(m.author, 120),
    license: text(m.license, 30),
    url: url && /^https?:\/\//i.test(url) ? url : undefined,
  };
}

export async function sha256Hex(bytes: ArrayBuffer | Uint8Array) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", view as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function checksumMatches(message: TemplateMessage) {
  return (await sha256Hex(message.bytes)) === message.sha256;
}

// A safe file name for "Als Datei herunterladen".
export const packageFileName = (title: string) => `${(title.replace(/[\u0000-\u001f\u007f\\/:*?"<>|]+/g, "-").trim() || "vorlage").slice(0, 80)}${PACKAGE_EXTENSION}`;
