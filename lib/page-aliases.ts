// Server side of aliases (lib/aliases.ts): the checks of the API and the
// command "page.aliases".
import { z } from "zod";
import { HttpError } from "./auth";
import { run } from "./db";
import { requirePage } from "./permissions";
import { aliasList, fold, MAX_ALIAS_LENGTH, MAX_ALIASES, storedAliases } from "./aliases";
import type { Identity } from "./types";

// What the API accepts: a list of at most 10 names of at most 100
// characters (counted after trimming and removing duplicates).
export function parseAliases(input: unknown): string[] {
  const list = z.array(z.string().max(1000)).max(100).parse(input);
  if (list.some((alias) => alias.trim().length > MAX_ALIAS_LENGTH))
    throw new HttpError(400, "Ein Alias hat höchstens 100 Zeichen.");
  if (new Set(list.map((alias) => fold(alias.replace(/\s+/g, " ").trim())).filter(Boolean)).size > MAX_ALIASES)
    throw new HttpError(400, "Höchstens 10 Aliasse.");
  return aliasList(list);
}

// Command "page.aliases": { pageId, aliases }. Needs editor rights.
export function setPageAliases(user: Identity, input: unknown) {
  const b = z.object({ pageId: z.string().uuid(), aliases: z.unknown() }).parse(input);
  const page = requirePage(user, b.pageId, true);
  const aliases = parseAliases(b.aliases);
  run("UPDATE pages SET aliases=? WHERE id=?", storedAliases(aliases), page.id);
  return { ok: true, aliases };
}
