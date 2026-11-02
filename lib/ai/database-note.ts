// Which databases an AI answer read its records from ("Daten aus: Server
// (12 Einträge)"): shared by the server (lib/ai/database-context.ts) and the
// browser (writing assistant, AI actions). No server imports.

export type DatabaseNote = { pageId: string; title: string; included: number; total: number };

// The writing assistant's answer carries the list in this header.
export const DATABASES_HEADER = "X-Flowplan-AI-Databases";

// Base64 of UTF-8 JSON (titles are not header-safe).
export function encodeDatabaseNotes(notes: DatabaseNote[]): string {
  const bytes = new TextEncoder().encode(JSON.stringify(notes));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeDatabaseNotes(header: string | null | undefined): DatabaseNote[] {
  if (!header) return [];
  try {
    const bytes = Uint8Array.from(atob(header), (c) => c.charCodeAt(0));
    const list = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(list)) return [];
    return list
      .filter((n) => n && typeof n.pageId === "string" && typeof n.title === "string" && Number.isFinite(n.included) && Number.isFinite(n.total))
      .slice(0, 10)
      .map((n) => ({ pageId: n.pageId, title: n.title.slice(0, 200), included: n.included, total: n.total }));
  } catch {
    return [];
  }
}
