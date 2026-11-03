import { bundledLanguagesInfo } from "shiki/langs";
import { canonicalLanguage, PLAIN_LANGUAGE, SHIKI_LANGUAGE_IDS } from "./code-languages";
import type { CodeToken } from "./code-highlighter-core";

// Syntax highlighting with Shiki (lib/code-highlighter-core.ts). Neither
// Shiki nor a grammar is part of the page's JavaScript: both load on demand,
// the first time a block of that language is shown. Until then a block reads
// as plain text; once loaded, highlighting is synchronous – the editor's
// decorations (lib/code-highlight-plugin.ts) and renderCode() ask without
// waiting. Highlighting is never stored: documents keep plain code with its
// language, so collaborators always share the same content.
export type { CodeToken };
export const MAX_HIGHLIGHT_LENGTH = 50_000;

type Core = typeof import("./code-highlighter-core");
let core: Core | null = null;
let corePromise: Promise<Core> | null = null;
const ready = new Set<string>();
const loading = new Map<string, Promise<boolean>>();
const failed = new Set<string>();
const imports = new Map(bundledLanguagesInfo.map((info) => [info.id, info.import]));

const highlightable = (language: string | null | undefined) => {
  const id = canonicalLanguage(language);
  return id && id !== PLAIN_LANGUAGE && SHIKI_LANGUAGE_IDS.has(id) ? id : null;
};

// Whether a language can be highlighted right away (plain text and unknown
// languages need nothing).
export function isLanguageReady(language: string | null | undefined) {
  const id = highlightable(language);
  return !id || ready.has(id) || failed.has(id);
}

// Loads Shiki and the language's grammar (with the languages it embeds);
// true once it highlights, false for plain text, unknown languages or when
// loading failed.
export function loadLanguage(language: string | null | undefined): Promise<boolean> {
  const id = highlightable(language);
  if (!id || failed.has(id)) return Promise.resolve(false);
  if (ready.has(id)) return Promise.resolve(true);
  let pending = loading.get(id);
  if (!pending) {
    corePromise ||= import("./code-highlighter-core").then((module) => (core = module));
    pending = Promise.all([corePromise, imports.get(id)!()])
      .then(([shiki, grammar]) => {
        shiki.addGrammars(grammar.default);
        ready.add(id);
        return true;
      })
      .catch(() => {
        failed.add(id);
        return false;
      })
      .finally(() => loading.delete(id));
    loading.set(id, pending);
  }
  return pending;
}

// The highlighted ranges of a code text, or null while the language is not
// loaded yet (the caller shows plain text and may loadLanguage()). Plain
// text, unknown languages and very long code: no ranges.
export function highlightTokens(language: string | null | undefined, text: string): CodeToken[] | null {
  const id = highlightable(language);
  if (!id || failed.has(id) || text.length > MAX_HIGHLIGHT_LENGTH) return [];
  if (!ready.has(id) || !core) return null;
  try {
    return core.tokenize(id, text);
  } catch {
    return [];
  }
}

const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

// Highlighted HTML of a code text (spans with tok-… classes, the text
// escaped); plain escaped text while the language is not loaded.
export function renderCode(text: string, language: string | null | undefined) {
  const tokens = highlightTokens(language, text) || [];
  let html = "",
    at = 0;
  for (const token of tokens) {
    if (token.from < at) continue;
    html += escape(text.slice(at, token.from));
    html += `<span class="${token.className}">${escape(text.slice(token.from, token.to))}</span>`;
    at = token.to;
  }
  return html + escape(text.slice(at));
}

// The same after loading the language – for the server and read-only views.
export async function renderCodeAsync(text: string, language: string | null | undefined) {
  await loadLanguage(language);
  return renderCode(text, language);
}
