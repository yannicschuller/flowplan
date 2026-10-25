// Text recognised in handwriting (on the device, lib/ink/recognition.ts).
// It comes from the client and is only ever treated as plain text: stored
// next to the ink, indexed for search, shown escaped. Control and
// direction-override characters go, whitespace is tidied, length capped.
export const RECOGNIZED_LIMITS = {
  // One surface: a notebook sheet, a drawing block, a PDF page.
  surface: 4000,
  // All PDF pages of one file together.
  file: 20000,
  // A recognition answer turned into a text annotation or paragraph.
  convert: 2000,
};

export function cleanRecognizedText(value: unknown, max = RECOGNIZED_LIMITS.surface): string {
  if (typeof value !== "string") return "";
  return (
    value
      .normalize("NFC")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g, " ")
      .replace(/[^\S\n]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, max)
      .trim()
  );
}

// Page key → text (PDF files: one entry per page). Keys like ink page keys.
export function cleanRecognizedMap(value: unknown, total = RECOGNIZED_LIMITS.file): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  let used = 0;
  for (const [key, text] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[\w.-]{1,64}$/.test(key)) continue;
    const clean = cleanRecognizedText(text, Math.min(RECOGNIZED_LIMITS.surface, total - used));
    if (!clean) continue;
    out[key] = clean;
    used += clean.length;
    if (used >= total) break;
  }
  return out;
}
export function parseRecognizedMap(stored: string | null | undefined): Record<string, string> {
  if (!stored) return {};
  try {
    return cleanRecognizedMap(JSON.parse(stored));
  } catch {
    return {};
  }
}
