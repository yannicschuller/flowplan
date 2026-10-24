// The operating system of THIS device – not of the account: the same person
// sees ⌘ on their Mac and Ctrl on their Windows laptop. Read in the browser
// from navigator.userAgentData.platform, navigator.platform and the user
// agent (the desktop app, flowplan-desktop, is Electron and names the real
// system in all of them; the mobile apps' web views do as well).
export type DeviceOS = "macos" | "ios" | "ipados" | "windows" | "chromeos" | "android" | "linux" | "unknown";

export type OSHints = {
  // navigator.userAgentData?.platform: "macOS", "Windows", "Android", "Chrome OS", "Linux", "" …
  uaPlatform?: string;
  // navigator.platform: "MacIntel", "Win32", "iPhone", "Linux armv8l" …
  platform?: string;
  userAgent?: string;
  // navigator.maxTouchPoints: tells an iPad ("MacIntel" since iPadOS 13) from a Mac.
  maxTouchPoints?: number;
};

function fromUserAgent(ua: string, touch: number): DeviceOS | null {
  if (/\bCrOS\b/.test(ua)) return "chromeos";
  if (/\bAndroid\b/i.test(ua)) return "android";
  if (/\biPad\b/.test(ua)) return "ipados";
  if (/\biP(hone|od)\b/.test(ua)) return "ios";
  if (/\bWindows\b/.test(ua)) return "windows";
  // iPadOS asks for desktop pages as a Mac; only the touch screen gives it away.
  if (/\bMac(intosh| OS X)\b/.test(ua)) return touch > 1 ? "ipados" : "macos";
  if (/\bLinux\b|\bX11\b/.test(ua)) return "linux";
  return null;
}

// Pure, for the tests: the strongest hint wins. Client Hints first (not
// frozen, not spoofed by "request desktop site"), then the user agent (it
// carries Android/CrOS, which navigator.platform reports as plain Linux),
// then navigator.platform.
export function detectOS({ uaPlatform, platform, userAgent, maxTouchPoints = 0 }: OSHints): DeviceOS {
  const hint = (uaPlatform || "").toLowerCase();
  if (hint) {
    if (hint === "macos") return maxTouchPoints > 1 ? "ipados" : "macos";
    if (hint === "ios") return /\biPad\b/.test(userAgent || "") ? "ipados" : "ios";
    if (hint === "ipados") return "ipados";
    if (hint === "windows") return "windows";
    if (hint === "android") return "android";
    if (hint === "chrome os" || hint === "chromeos" || hint === "chromium os") return "chromeos";
    if (hint === "linux") {
      // A Linux hint with an Android user agent is Android (older WebViews).
      const ua = fromUserAgent(userAgent || "", maxTouchPoints);
      return ua === "android" || ua === "chromeos" ? ua : "linux";
    }
  }
  const ua = fromUserAgent(userAgent || "", maxTouchPoints);
  if (ua) return ua;
  const p = (platform || "").toLowerCase();
  if (/iphone|ipod/.test(p)) return "ios";
  if (/ipad/.test(p)) return "ipados";
  if (/mac/.test(p)) return maxTouchPoints > 1 ? "ipados" : "macos";
  if (/win/.test(p)) return "windows";
  if (/android/.test(p)) return "android";
  if (/cros/.test(p)) return "chromeos";
  if (/linux|x11|freebsd|openbsd/.test(p)) return "linux";
  return "unknown";
}

// Apple systems write shortcuts with ⌘ ⌥ ⇧ ⌃ and use ⌘ where others use Ctrl.
export const appleOS = (os: DeviceOS) => os === "macos" || os === "ios" || os === "ipados";

let cached: DeviceOS | null = null;
export function currentOS(): DeviceOS {
  if (typeof navigator === "undefined") return "unknown";
  if (cached) return cached;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  cached = detectOS({
    uaPlatform: nav.userAgentData?.platform,
    platform: nav.platform,
    userAgent: nav.userAgent,
    maxTouchPoints: nav.maxTouchPoints,
  });
  return cached;
}
