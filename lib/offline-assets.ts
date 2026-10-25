// The app's own files for offline use (#47): every script, style sheet,
// font and worker of the client build, listed by the server
// (GET /api/offline/assets, lib/offline-assets-server.ts) and stored by
// components/offline.ts in a cache named after the build. Parts of the app
// that were never opened online (editor, database views, dashboards,
// notebooks …) then load offline as well. Pure functions, so the plan is
// testable; public/sw.js repeats them for Periodic Background Sync
// (tests/offline-assets.test.ts checks both agree).

export type OfflineAsset = { path: string; size: number };
export type OfflineAssets = {
  // Next's build id: a new release brings new file names.
  build: string;
  // The release (package.json), shown in Settings → Data.
  version: string;
  files: OfflineAsset[];
  bytes: number;
};

export const STATIC_CACHE_PREFIX = "flowplan-static-";
// Before #47 every release shared this cache and old files stayed in it.
export const LEGACY_STATIC_CACHE = "flowplan-static-v1";
export const staticCacheName = (build: string) => `${STATIC_CACHE_PREFIX}${build}`;
export const isStaticCache = (name: string) => name.startsWith(STATIC_CACHE_PREFIX);

// Caches of other builds (and the shared one before #47): removed once the
// current build is stored completely.
export function staleStaticCaches(names: string[], build: string): string[] {
  const current = staticCacheName(build);
  return names.filter((name) => isStaticCache(name) && name !== current);
}

// Listed files the cache does not hold yet (keys are path plus query).
export function missingAssets(files: OfflineAsset[], keys: string[]): OfflineAsset[] {
  const stored = new Set(keys);
  return files.filter((file) => !stored.has(file.path));
}

// Room for the files: the browser's estimate minus a reserve, so the
// copy never fills the device. Without an estimate the browser decides.
export const STORAGE_RESERVE = 20 * 1024 * 1024;
export function fitsQuota(bytes: number, estimate: { quota?: number; usage?: number } | null | undefined) {
  if (!estimate?.quota) return true;
  return estimate.quota - (estimate.usage || 0) - STORAGE_RESERVE >= bytes;
}
