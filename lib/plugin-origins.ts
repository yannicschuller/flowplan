// Origins block extensions may load from (lib/plugins.ts). Kept small: the
// proxy (proxy.ts) reads it for the frame-src of the Content Security Policy.
import { all } from "./db";

// PLUGIN_ALLOWED_ORIGINS: HTTPS origins separated by commas or spaces.
export function envPluginOrigins(raw = process.env.PLUGIN_ALLOWED_ORIGINS || ""): string[] {
  const out = new Set<string>();
  for (const part of raw.split(/[\s,]+/).filter(Boolean)) {
    try {
      const url = new URL(part);
      if (url.protocol === "https:" && !url.username && !url.password) out.add(url.origin);
    } catch {}
  }
  return [...out];
}
// Everything frames may come from: the listed origins and those of the
// registered plugins.
export function pluginFrameOrigins(): string[] {
  const out = new Set(envPluginOrigins());
  try {
    for (const row of all<{ origin: string }>("SELECT DISTINCT origin FROM plugins WHERE enabled=1"))
      if (/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(row.origin)) out.add(row.origin);
  } catch {}
  return [...out].sort();
}
