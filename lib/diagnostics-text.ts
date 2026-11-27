// Installation details for bug reports (#630): one line to paste into an
// issue, e.g.
//   "Backend: Flowplan 0.12.1 (beta, build 28c0c38, built 2026-11-27T12:10Z,
//    Node.js v26.13.1, docker-compose, SQLite, local disk, single instance)
//    · Frontend: iPhone, iOS 27.0.1, Flowplan app 1.1.7"
//
// The backend part comes from the server (lib/diagnostics.ts), filtered by
// the reader's rights: everyone signed in sees version, channel, build and
// build date; only instance admins see Node.js, the install method, the
// database, the storage and the mode. The frontend part is read in the
// browser (user agent, the apps' bridges) and never leaves it, except in
// the text the person copies themselves.
//
// No server-only imports: Settings → Über Flowplan builds the text in the
// page. Nothing personal goes in: no host names, addresses, URLs or e-mail
// addresses (the install method, a free text, passes cleanInstallMethod).
import { detectOS, type DeviceOS } from "./device-os";

export type DiagnosticsChannel = "beta" | "release" | "";

// What GET /api/diagnostics answers, and what the boot data carries.
export type BackendDiagnostics = {
  // "admin": the instance details below are included; "member": not.
  scope: "member" | "admin";
  version: string;
  channel: DiagnosticsChannel;
  // The short commit (7 characters), "" when not known.
  commit: string;
  // ISO 8601, "" when not known.
  builtAt: string;
  // Instance admins only.
  node?: string;
  database?: "sqlite" | "postgres";
  // PostgreSQL's major version (null: not known; SQLite: always null).
  databaseVersion?: number | null;
  storage?: "local" | "s3";
  mode?: "single" | "cluster";
  // FLOWPLAN_INSTALL_METHOD when set (cleaned), otherwise what was detected
  // ("kubernetes", "docker", "podman", "no container").
  installMethod?: string;
  installMethodSource?: "setting" | "detected";
  // The backend line: "Backend: Flowplan …".
  text: string;
};

export const INSTALL_METHOD_MAX = 40;

// FLOWPLAN_INSTALL_METHOD is free text ("docker-compose", "coolify",
// "helm" …). Only letters, digits, spaces and . _ + - / stay; words that
// look like an address (IP, host name, e-mail, URL) are dropped, so a value
// like "docker on nas.example.org" cannot put a host into a bug report.
export function cleanInstallMethod(value: string | undefined | null): string {
  const words = (value || "")
    .replace(/[^\p{L}\p{N} ._+\-/@:]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((word) => !/[@:]/.test(word)) // e-mail, URL, IPv6, host:port
    .filter((word) => !/\d+\.\d+\.\d+/.test(word)) // IPv4 (and long dotted numbers)
    .filter((word) => !/[\p{L}\p{N}-]\.\p{L}/u.test(word)) // a host name: a dot followed by a letter
    .filter((word) => !/^[./]+$/.test(word));
  let text = "";
  for (const word of words) {
    const next = text ? `${text} ${word}` : word;
    if (next.length > INSTALL_METHOD_MAX) break;
    text = next;
  }
  return text;
}

// "2026-11-27T12:10:28.014Z" → "2026-11-27T12:10Z"; "" when not a date.
export function shortBuildDate(builtAt: string) {
  const time = Date.parse(builtAt);
  if (!builtAt || Number.isNaN(time)) return "";
  return `${new Date(time).toISOString().slice(0, 16)}Z`;
}

export function databaseLabel(kind: BackendDiagnostics["database"], major?: number | null) {
  if (kind === "postgres") return major ? `PostgreSQL ${major}` : "PostgreSQL";
  return kind === "sqlite" ? "SQLite" : "";
}

// "Flowplan 0.12.1 (beta, build 28c0c38, built 2026-11-27T12:10Z, …)",
// without the "Backend: " in front.
export function backendSummary(d: Omit<BackendDiagnostics, "text" | "scope">) {
  const details = [
    d.channel,
    d.commit ? `build ${d.commit.slice(0, 7)}` : "",
    shortBuildDate(d.builtAt) ? `built ${shortBuildDate(d.builtAt)}` : "",
    d.node ? `Node.js ${d.node}` : "",
    d.installMethod || "",
    databaseLabel(d.database, d.databaseVersion),
    d.storage === "s3" ? "S3 storage" : d.storage === "local" ? "local disk" : "",
    d.mode === "cluster" ? "cluster" : d.mode === "single" ? "single instance" : "",
  ].filter(Boolean);
  return `Flowplan ${d.version || "(version unknown)"}${details.length ? ` (${details.join(", ")})` : ""}`;
}

export const backendLine = (d: Omit<BackendDiagnostics, "text" | "scope">) => `Backend: ${backendSummary(d)}`;

// ---- The frontend, read in the browser ----

export type ClientHints = {
  userAgent?: string;
  // navigator.userAgentData?.platform
  uaPlatform?: string;
  // navigator.platform
  platform?: string;
  maxTouchPoints?: number;
  // window.FlowplanApp (iPhone, iPad, Android; lib/native-app.ts).
  app?: { platform?: unknown; version?: unknown } | null;
  // window.FlowplanDesktop (flowplan-desktop).
  desktop?: { version?: unknown; os?: unknown } | null;
};

export type ClientDiagnostics = {
  // "iPhone", "iPad", "Pixel 9" (Android's model, when the user agent names it), "".
  device: string;
  // "iOS 27.0.1", "Android 16", "macOS", "Windows", "Linux" …
  os: string;
  // "Firefox 140", "Chrome 141", "Safari 18.2", "Edge 141"; "" inside the apps.
  browser: string;
  // "Flowplan app 1.1.7", "Flowplan desktop 1.3.14"; "" in a browser.
  app: string;
};

const OS_NAMES: Record<DeviceOS, string> = {
  macos: "macOS",
  ios: "iOS",
  ipados: "iPadOS",
  windows: "Windows",
  chromeos: "ChromeOS",
  android: "Android",
  linux: "Linux",
  unknown: "",
};

// A version as the user agent or a bridge gives it: digits and dots only.
const versionOf = (value: unknown) => {
  const v = typeof value === "string" ? value.trim() : "";
  return /^\d+(\.\d+){0,3}([-+][\w.]{1,20})?$/.test(v) ? v : "";
};

function browserOf(ua: string) {
  const major = (pattern: RegExp) => pattern.exec(ua)?.[1] || "";
  if (/\bEdg(A|iOS)?\//.test(ua)) return `Edge ${major(/\bEdg(?:A|iOS)?\/(\d+)/)}`.trim();
  if (/\bFirefox\/|\bFxiOS\//.test(ua)) return `Firefox ${major(/\b(?:Firefox|FxiOS)\/(\d+)/)}`.trim();
  if (/\bCriOS\//.test(ua)) return `Chrome ${major(/\bCriOS\/(\d+)/)}`.trim();
  // Headless Chromium (automated browsers) names itself "HeadlessChrome/".
  if (/\b(Headless)?Chrome\//.test(ua)) return `Chrome ${major(/\b(?:Headless)?Chrome\/(\d+)/)}`.trim();
  if (/\bSafari\//.test(ua)) return `Safari ${/\bVersion\/(\d+(?:\.\d+)?)/.exec(ua)?.[1] || ""}`.trim();
  return "";
}

// The system's version where the user agent still tells it: iOS and iPadOS
// ("CPU iPhone OS 27_0_1"), Android ("Android 16"). macOS and Windows
// freeze theirs in the user agent, so none is given.
function osVersion(os: DeviceOS, ua: string) {
  if (os === "ios" || os === "ipados") return (/\bOS (\d+(?:_\d+){0,2}) like Mac OS X/.exec(ua)?.[1] || "").replace(/_/g, ".");
  if (os === "android") return /\bAndroid (\d+(?:\.\d+){0,2})/.exec(ua)?.[1] || "";
  return "";
}

// Android's model from "(Linux; Android 16; Pixel 9 Build/…; wv)"; Chrome's
// reduced user agent says "K" instead.
function androidModel(ua: string) {
  const inside = /\(Linux; Android [^;)]*; ([^;)]+)/.exec(ua)?.[1] || "";
  const model = inside.replace(/\s*Build\/.*$/, "").trim();
  return model && model !== "K" && model !== "wv" && /^[\w .+-]{1,40}$/.test(model) ? model : "";
}

export function clientDiagnostics(hints: ClientHints): ClientDiagnostics {
  const ua = hints.userAgent || "";
  const bridge = hints.app && typeof hints.app === "object" ? hints.app : null;
  let os = detectOS({ uaPlatform: hints.uaPlatform, platform: hints.platform, userAgent: ua, maxTouchPoints: hints.maxTouchPoints });
  // The iPad app asks for desktop pages ("Macintosh"); its bridge knows better.
  if (bridge?.platform === "ios" && os === "macos") os = "ipados";
  const mobileVersion = versionOf(/\bFlowplanMobile\/([\w.+-]{1,20})/.exec(ua)?.[1]) || versionOf(bridge?.version);
  const desktopVersion = versionOf(/\bFlowplanDesktop\/([\w.+-]{1,20})/.exec(ua)?.[1]) || versionOf(hints.desktop?.version);
  const inMobileApp = !!bridge || /\bFlowplanMobile\//.test(ua);
  const inDesktopApp = !inMobileApp && (!!hints.desktop || /\bFlowplanDesktop\//.test(ua));
  const app = inMobileApp ? `Flowplan app ${mobileVersion}`.trim() : inDesktopApp ? `Flowplan desktop ${desktopVersion}`.trim() : "";
  const device = os === "ios" ? (/\biPod\b/.test(ua) ? "iPod" : "iPhone") : os === "ipados" ? "iPad" : os === "android" ? androidModel(ua) : "";
  const version = osVersion(os, ua);
  return {
    device,
    os: [OS_NAMES[os], version].filter(Boolean).join(" "),
    // Inside the apps the web view is not a browser of its own choice.
    browser: inMobileApp ? "" : inDesktopApp ? (/\bElectron\/(\d+)/.exec(ua) ? `Electron ${/\bElectron\/(\d+)/.exec(ua)![1]}` : "") : browserOf(ua),
    app,
  };
}

// "iPhone, iOS 27.0.1, Flowplan app 1.1.7" · "Firefox 140, macOS".
export function clientSummary(c: ClientDiagnostics) {
  const parts = c.app ? [c.device, c.os, c.app, c.browser] : [c.browser, c.device, c.os];
  return parts.filter(Boolean).join(", ") || "unknown";
}

export const clientLine = (c: ClientDiagnostics) => `Frontend: ${clientSummary(c)}`;

// The whole paragraph for the bug report.
export function diagnosticsText(backend: Pick<BackendDiagnostics, "text">, client: ClientDiagnostics) {
  return `${backend.text} · ${clientLine(client)}`;
}

// The hints of this browser (only in the page).
export function currentClientHints(): ClientHints {
  if (typeof navigator === "undefined") return {};
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const host = typeof window === "undefined" ? undefined : (window as unknown as { FlowplanApp?: ClientHints["app"]; FlowplanDesktop?: ClientHints["desktop"] });
  return {
    userAgent: nav.userAgent,
    uaPlatform: nav.userAgentData?.platform,
    platform: nav.platform,
    maxTouchPoints: nav.maxTouchPoints,
    app: host?.FlowplanApp ?? null,
    desktop: host?.FlowplanDesktop ?? null,
  };
}
