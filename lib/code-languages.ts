import { bundledLanguagesInfo } from "shiki/langs";
import { tr } from "./locale-tag";

// The languages of code blocks: every language Shiki bundles (the TextMate
// grammars of VS Code), by id with its full name. Only this list (names and
// aliases) is part of the editor's JavaScript; a grammar loads when a block
// needs it (lib/code-highlight.ts).
//
// Blocks store the language id ("language-…" class in the HTML, the fence
// of Markdown). Ids from before Shiki (highlight.js) and common aliases
// stay readable: canonicalLanguage() turns them into Shiki's ids.

export const PLAIN_LANGUAGE = "plaintext";
const PLAIN_ALIASES = ["plaintext", "text", "txt", "plain"];

// highlight.js ids and aliases (the editor before Shiki) that Shiki names
// differently, plus file extensions for the search. Languages Shiki does not
// know stay as they are (shown as "imported", without highlighting).
const LEGACY: Record<string, string> = {
  as: "actionscript-3",
  apacheconf: "apache",
  osascript: "applescript",
  arduino: "cpp",
  ino: "cpp",
  armasm: "asm",
  arm: "asm",
  avrasm: "asm",
  x86asm: "asm",
  nasm: "asm",
  s: "asm",
  autohotkey: "ahk",
  xhtml: "html",
  htm: "html",
  rss: "xml",
  atom: "xml",
  xjb: "xml",
  xsd: "xml",
  plist: "xml",
  wsf: "xml",
  svg: "xml",
  h: "c",
  cc: "cpp",
  "h++": "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  cxx: "cpp",
  edn: "clojure",
  "clojure-repl": "clojure",
  "cmake.in": "cmake",
  cson: "coffee",
  iced: "coffee",
  cr: "crystal",
  mkdown: "markdown",
  mkd: "markdown",
  delphi: "pascal",
  dpr: "pascal",
  dfm: "pascal",
  pas: "pascal",
  patch: "diff",
  django: "jinja",
  dos: "bat",
  ex: "elixir",
  exs: "elixir",
  "erlang-repl": "erlang",
  gemspec: "ruby",
  podspec: "ruby",
  thor: "ruby",
  irb: "ruby",
  gemfile: "ruby",
  fortran: "fortran-free-form",
  feature: "gherkin",
  golang: "go",
  gradle: "groovy",
  "html.hbs": "handlebars",
  "html.handlebars": "handlebars",
  htmlbars: "handlebars",
  hx: "haxe",
  https: "http",
  hylang: "hy",
  jsp: "java",
  ktm: "kotlin",
  ktx: "kotlin",
  "julia-repl": "julia",
  jldoctest: "julia",
  pluto: "lua",
  mk: "makefile",
  mak: "makefile",
  mathematica: "wolfram",
  mma: "wolfram",
  pl: "perl",
  pm: "perl",
  nginxconf: "nginx",
  nixos: "nix",
  "node-repl": "javascript",
  objectivec: "objective-c",
  "obj-c": "objective-c",
  m: "objective-c",
  mm: "objective-cpp",
  "obj-c++": "objective-cpp",
  "objective-c++": "objective-cpp",
  ml: "ocaml",
  pgsql: "sql",
  postgres: "sql",
  postgresql: "sql",
  mysql: "sql",
  pp: "puppet",
  gyp: "python",
  ipython: "python",
  "python-repl": "python",
  pycon: "python",
  pyw: "python",
  pyi: "python",
  qt: "qml",
  scm: "scheme",
  st: "smalltalk",
  do: "stata",
  ado: "stata",
  tk: "tcl",
  craftcms: "twig",
  vbnet: "vb",
  vbscript: "vb",
  vbs: "vb",
  sv: "system-verilog",
  svh: "system-verilog",
  accesslog: "log",
  mjs: "javascript",
  cjs: "javascript",
  node: "javascript",
  mts: "typescript",
  cts: "typescript",
  ps1: "powershell",
  psm1: "powershell",
  kts: "kotlin",
  containerfile: "dockerfile",
  docker: "dockerfile",
  rb: "ruby",
  cs: "csharp",
  hs: "haskell",
  tex: "latex",
  md: "markdown",
  conf: "ini",
  cfg: "ini",
  env: "dotenv",
};

export type CodeLanguage = {
  id: string;
  name: string;
  // Ids, aliases and file extensions that find it in the search.
  terms: string[];
};

const shikiLanguages: CodeLanguage[] = bundledLanguagesInfo.map((info) => ({
  id: info.id,
  name: info.name,
  terms: [info.id, ...(info.aliases || [])],
}));
const byTerm = new Map<string, string>();
for (const language of shikiLanguages)
  for (const term of language.terms) byTerm.set(term, language.id);
for (const [term, alias] of Object.entries(LEGACY)) {
  const id = byTerm.get(alias);
  if (!byTerm.has(term) && id) {
    byTerm.set(term, id);
    shikiLanguages.find((language) => language.id === id)!.terms.push(term);
  }
}

export const SHIKI_LANGUAGE_IDS = new Set(shikiLanguages.map((language) => language.id));

// The id a block's language means: Shiki's id for an id, alias or older
// highlight.js name ("js" → "javascript", "plaintext"/"text" → "plaintext"),
// otherwise the value itself (lower case, trimmed), "" for none.
export function canonicalLanguage(language: string | null | undefined): string {
  const value = String(language || "").trim().toLowerCase();
  if (!value) return "";
  if (PLAIN_ALIASES.includes(value)) return PLAIN_LANGUAGE;
  return byTerm.get(value) || value;
}
export const isPlainLanguage = (language: string | null | undefined) => {
  const id = canonicalLanguage(language);
  return !id || id === PLAIN_LANGUAGE;
};
export const isKnownLanguage = (language: string | null | undefined) => {
  const id = canonicalLanguage(language);
  return id === PLAIN_LANGUAGE || SHIKI_LANGUAGE_IDS.has(id);
};

// Plain text first (named in the reader's language), then A–Z.
export function codeLanguages(): CodeLanguage[] {
  return [
    { id: PLAIN_LANGUAGE, name: tr("Klartext", "Plain text"), terms: [...PLAIN_ALIASES] },
    ...[...shikiLanguages].sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" })),
  ];
}

// The full name of a language ("JavaScript", "C++"); unknown ids as they are.
export function languageLabel(language: string | null | undefined): string {
  const id = canonicalLanguage(language);
  if (!id || id === PLAIN_LANGUAGE) return tr("Klartext", "Plain text");
  return shikiLanguages.find((l) => l.id === id)?.name || String(language);
}

// The search of the language picker: names (start of a word or anywhere),
// ids, aliases and file extensions ("ts", "py", "yml", "tf", ".rs").
export function searchLanguages(query: string, languages = codeLanguages()): CodeLanguage[] {
  const q = query.trim().toLowerCase().replace(/^\./, "");
  if (!q) return languages;
  const rank = (language: CodeLanguage) => {
    const name = language.name.toLowerCase();
    if (language.terms.includes(q) || name === q) return 0;
    if (name.startsWith(q)) return 1;
    if (language.terms.some((term) => term.startsWith(q))) return 2;
    if (name.split(/[\s()/+-]+/).some((word) => word.startsWith(q))) return 3;
    if (name.includes(q)) return 4;
    if (language.terms.some((term) => term.includes(q))) return 5;
    return -1;
  };
  return languages
    .map((language, index) => ({ language, index, score: rank(language) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((entry) => entry.language);
}

// The id for a Markdown fence: Shiki's id where there is one, plain text as
// "plaintext"; unknown languages as they were written.
export function fenceLanguage(language: string | null | undefined): string {
  const value = String(language || "").trim();
  const id = canonicalLanguage(value);
  return id && (id === PLAIN_LANGUAGE || SHIKI_LANGUAGE_IDS.has(id)) ? id : value;
}

// Recently chosen languages, newest first, kept in this browser (like the
// recent blocks of the slash menu, lib/slash-commands.ts).
export const MAX_RECENT_LANGUAGES = 5;
const RECENTS_KEY = "flowplan.code-languages";
export function readRecentLanguages(): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]");
    return Array.isArray(stored)
      ? stored
          .filter((id): id is string => typeof id === "string" && isKnownLanguage(id))
          .map(canonicalLanguage)
          .slice(0, MAX_RECENT_LANGUAGES)
      : [];
  } catch {
    return [];
  }
}
export function rememberLanguage(id: string, current = readRecentLanguages()): string[] {
  const language = canonicalLanguage(id);
  if (!isKnownLanguage(language)) return current;
  const next = [language, ...current.filter((other) => other !== language)].slice(0, MAX_RECENT_LANGUAGES);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {}
  return next;
}
