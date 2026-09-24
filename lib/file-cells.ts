import { z } from "zod";

// "Files & media" cells hold uploaded files of the database page
// (/api/files/<id>) or external http(s) links. Older values are a single
// string; new values are an array. Both are read through fileUrls.
export const MAX_CELL_FILES = 50;
export const fileIdOf = (url: string) =>
  /^\/api\/files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
    url,
  )?.[1];
export const fileRefSchema = z
  .string()
  .max(2000)
  .refine(
    (value) => !!fileIdOf(value) || /^https?:\/\/[^\s]+$/i.test(value),
    "Bitte eine hochgeladene Datei oder einen http(s)-Link verwenden.",
  );
export function fileUrls(value: unknown): string[] {
  if (typeof value === "string") return value ? [value] : [];
  if (Array.isArray(value))
    return value.filter((v): v is string => typeof v === "string" && !!v);
  return [];
}
// Rewrites every reference while keeping the stored shape.
export function mapFileCell(value: unknown, map: (url: string) => string) {
  if (typeof value === "string") return value ? map(value) : value;
  if (Array.isArray(value))
    return value.map((v) => (typeof v === "string" ? map(v) : v));
  return value;
}
export function fileLabel(url: string, names: ReadonlyMap<string, string>) {
  if (names.has(url)) return names.get(url)!;
  if (fileIdOf(url)) return "Datei";
  try {
    const parsed = new URL(url);
    return (
      decodeURIComponent(parsed.pathname.split("/").pop() || "") ||
      parsed.hostname
    );
  } catch {
    return url;
  }
}
