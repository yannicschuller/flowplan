// draw.io diagrams in documents (#110). The block (lib/drawio-node.ts)
// keeps the diagram's XML and a picture of it (SVG, cleaned by
// lib/drawio-svg.ts). Editing opens draw.io in embed mode in a frame
// (components/drawio-editor.tsx), talking JSON over postMessage
// (https://www.drawio.com/doc/faq/embed-mode); reading only shows the
// stored picture, draw.io is never loaded for it.
//
// DRAWIO_URL names the draw.io to use, e.g. an own jgraph/drawio container;
// without it the public https://embed.diagrams.net. Shared by server and
// browser, without dependencies (the proxy reads it for frame-src).

export const DEFAULT_DRAWIO_URL = "https://embed.diagrams.net";
// Hosts of the public service: the editor tells that the diagram is sent
// there while editing.
const PUBLIC_HOSTS = /(^|\.)(diagrams\.net|draw\.io|drawio\.com)$/i;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

// Each diagram's limits, so that a page stays within the 2 MB of HTML the
// rest of Flowplan accepts (imports, templates, versions).
export const MAX_DRAWIO_XML = 800_000;
export const MAX_DRAWIO_SVG = 800_000;

export const DRAWIO_THEMES = ["auto", "light", "dark"] as const;
export type DrawioTheme = (typeof DRAWIO_THEMES)[number];
// draw.io's interfaces (its ui= parameter).
export const DRAWIO_UIS = ["kennedy", "min", "sketch"] as const;
export type DrawioUi = (typeof DRAWIO_UIS)[number];

export type DrawioConfig = {
  // Address of draw.io's page, without parameters.
  url: string;
  origin: string;
  // The public diagrams.net service (not an own installation).
  external: boolean;
};

// The checked address: HTTPS, plain HTTP only on this machine (a local
// container while developing); no user name or password. An address that
// fails the check switches draw.io off instead of falling back to the
// public service – the operator meant to keep diagrams in house.
export function drawioConfig(raw: string | undefined = typeof process !== "undefined" ? process.env.DRAWIO_URL : undefined): DrawioConfig | null {
  const value = (raw ?? "").trim() || DEFAULT_DRAWIO_URL;
  const config = parseDrawioUrl(value);
  if (!config && !warned.has(value)) {
    warned.add(value);
    console.warn(`DRAWIO_URL "${value}" is not usable (https://…, or http:// only for localhost); draw.io diagrams are switched off.`);
  }
  return config;
}
const warned = new Set<string>();
function parseDrawioUrl(value: string): DrawioConfig | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname.toLowerCase()))) return null;
  const path = url.pathname.replace(/\/+$/, "");
  return { url: `${url.origin}${path}/`, origin: url.origin, external: PUBLIC_HOSTS.test(url.hostname) };
}

// The editor's address: embed mode with JSON messages, a spinner while
// loading, one "Save & exit" button, the chosen interface and theme and
// Flowplan's language.
export function drawioEditorUrl(config: DrawioConfig, options: { ui?: string; dark?: boolean; lang?: string } = {}) {
  const ui = DRAWIO_UIS.includes(options.ui as DrawioUi) ? (options.ui as DrawioUi) : "kennedy";
  const params = new URLSearchParams({
    embed: "1",
    proto: "json",
    spin: "1",
    ui,
    dark: options.dark ? "1" : "0",
    saveAndExit: "1",
    noSaveBtn: "1",
    noExitBtn: "0",
    libraries: "1",
  });
  if (options.lang && /^[a-z]{2}(-[a-z]{2})?$/i.test(options.lang)) params.set("lang", options.lang.toLowerCase());
  return `${config.url}?${params}`;
}

// The theme draw.io opens with: the person's choice, or Flowplan's.
export const drawioDark = (theme: DrawioTheme, appDark: boolean) => (theme === "auto" ? appDark : theme === "dark");

// Messages from draw.io (JSON text). Anything else is ignored.
export type DrawioMessage =
  | { event: "init" }
  | { event: "load" }
  | { event: "autosave"; xml: string }
  | { event: "save"; xml: string; exit: boolean }
  | { event: "export"; data: string; xml: string }
  | { event: "exit"; modified: boolean };
export function parseDrawioMessage(data: unknown): DrawioMessage | null {
  if (typeof data !== "string" || data.length > 2 * (MAX_DRAWIO_XML + MAX_DRAWIO_SVG) + 10_000) return null;
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(data);
  } catch {
    return null;
  }
  if (!message || typeof message !== "object") return null;
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  switch (message.event) {
    case "init":
    case "load":
      return { event: message.event };
    case "autosave":
      return { event: "autosave", xml: text(message.xml) };
    case "save":
      return { event: "save", xml: text(message.xml), exit: message.exit === true };
    case "export":
      return { event: "export", data: text(message.data), xml: text(message.xml) };
    case "exit":
      return { event: "exit", modified: message.modified === true };
  }
  return null;
}

// The SVG text of an export's data address (data:image/svg+xml;base64,…
// or URL-encoded), or "" when it is none.
export function svgFromDataUrl(data: string): string {
  const match = /^data:image\/svg\+xml(;[^,]*)?,/i.exec(data);
  if (!match) return /^\s*(<\?xml[^>]*>\s*)?(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(data) ? data : "";
  const body = data.slice(match[0].length);
  try {
    if (/;base64/i.test(match[1] || "")) {
      const binary = atob(body);
      return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
    }
    return decodeURIComponent(body);
  } catch {
    return "";
  }
}

// The stored picture as an address for an <img>: no scripts run and nothing
// loads in a picture, whatever the SVG holds.
export const drawioImageUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

const attributeText = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("\n", "&#10;");
// A .drawio.svg file (exports): the picture with the diagram in its
// content attribute, as draw.io writes it – draw.io opens it for editing
// again, any viewer shows the picture.
export function drawioSvgFile(svg: string, xml: string): string {
  const body = svg.replace(/^[\s\S]*?(?=<svg[\s>])/i, "");
  if (!/^<svg[\s>]/i.test(body)) return "";
  const root = body.replace(/^<svg\b([^>]*?)\s+content="[^"]*"/i, "<svg$1");
  const withContent = xml ? root.replace(/^<svg\b/i, `<svg content="${attributeText(xml)}"`) : root;
  return `<?xml version="1.0" encoding="UTF-8"?>\n${withContent}`;
}

// Diagram XML as draw.io saves it (<mxfile>, or a bare <mxGraphModel>).
export const isDrawioXml = (text: string) => /^\s*<(mxfile|mxGraphModel)[\s>]/.test(text) && text.length <= MAX_DRAWIO_XML;
