// Which requests the offline copy answers, and from which part: "static"
// (the app's own files, looked up in every build's cache) or "data" (the
// app's page, workspace, pages, records and files). Mirrors offlineKind in
// public/sw.js (tests/offline-app.test.ts compares them); lib/offline-app.ts
// uses it where no service worker runs (the iPhone and iPad app).
export type OfflineKind = "static" | "data";

export function offlineKind(
  request: { method: string; url: string; navigate?: boolean; offlineHeader?: string | null },
  origin: string,
): OfflineKind | null {
  let url: URL;
  try {
    url = new URL(request.url, origin);
  } catch {
    return null;
  }
  if (request.method.toUpperCase() !== "GET" || url.origin !== origin) return null;
  // Refreshes of the copy (components/offline.ts) store answers themselves.
  if (request.offlineHeader === "1") return null;
  if (request.navigate) return url.pathname === "/" ? "data" : null;
  const path = url.pathname;
  if (path.startsWith("/_next/static/") || path.startsWith("/icons/") || path === "/fonts.css" || path.startsWith("/fonts/")) return "static";
  if (path === "/api/bootstrap" || path.startsWith("/api/pages/") || path.startsWith("/api/files/")) return "data";
  return null;
}
