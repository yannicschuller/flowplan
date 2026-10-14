// Catalogues of the languages beyond German and English, keyed by the
// English text (locales/en.json lists every key; `npm run i18n` keeps the
// catalogues in step with the code). Texts built with variables appear with
// numbered placeholders – "Group {0}" – and are matched as patterns, so
// t(`Gruppe ${name}`, `Group ${name}`) needs no change in the code. An
// empty or missing translation shows the English text.
import fr from "../locales/fr.json";

type Catalog = Record<string, string>;
// Register a new language here and in LANGUAGES (lib/i18n.ts).
const catalogs: Record<string, Catalog> = { fr };

type Pattern = { regex: RegExp; translation: string; strict: boolean };
const compiled = new Map<string, { patterns: Pattern[]; cache: Map<string, string> }>();
const PLACEHOLDER = /\{(\d+)\}/g;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function prepare(locale: string) {
  let entry = compiled.get(locale);
  if (entry) return entry;
  const patterns: Pattern[] = [];
  for (const [key, translation] of Object.entries(catalogs[locale] || {})) {
    if (!translation || !key.includes("{0}")) continue;
    // Something to recognise besides the placeholders.
    if (!/\p{L}/u.test(key.replace(PLACEHOLDER, ""))) continue;
    const seen = new Set<string>();
    const source = escape(key).replace(/\\\{(\d+)\\\}/g, (_, n: string) =>
      seen.has(n) ? `\\k<p${n}>` : (seen.add(n), `(?<p${n}>[\\s\\S]*?)`),
    );
    // Little fixed text ("{0} of {1}") could match any sentence: such patterns
    // only take short values without spaces (numbers, names, dates).
    const strict = (key.replace(PLACEHOLDER, "").match(/\p{L}/gu) || []).length < 6;
    patterns.push({ regex: new RegExp(`^${source}$`), translation, strict });
  }
  // Longer keys first: they are the more specific patterns.
  patterns.sort((a, b) => b.regex.source.length - a.regex.source.length);
  entry = { patterns, cache: new Map() };
  compiled.set(locale, entry);
  return entry;
}

export function translateCatalog(locale: string, english: string): string {
  const catalog = catalogs[locale];
  if (!catalog || !english) return english;
  const exact = catalog[english];
  if (exact) return exact;
  const { patterns, cache } = prepare(locale);
  const known = cache.get(english);
  if (known !== undefined) return known;
  let result = english;
  for (const { regex, translation, strict } of patterns) {
    const match = regex.exec(english);
    if (!match) continue;
    if (strict && Object.values(match.groups || {}).some((value) => value && !/^\S{1,30}$/.test(value))) continue;
    result = translation.replace(PLACEHOLDER, (_, n) => match.groups?.[`p${n}`] ?? "");
    break;
  }
  if (cache.size > 5000) cache.clear();
  cache.set(english, result);
  return result;
}
// For `npm run i18n` and tests.
export const catalogLanguages = () => Object.keys(catalogs);
