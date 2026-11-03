import { createCssVariablesTheme, createHighlighterCoreSync, type LanguageRegistration } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

// Shiki itself, loaded with the first code block that needs it
// (lib/code-highlight.ts). The JavaScript regex engine instead of
// Oniguruma: no WebAssembly to fetch, and it reads every bundled grammar.
// The theme names its colours as CSS variables ("var(--code-token-keyword)");
// tokens turn them into classes, coloured by app/globals.css in light and
// dark mode.
const THEME = "flowplan";
const highlighter = createHighlighterCoreSync({
  themes: [createCssVariablesTheme({ name: THEME, variablePrefix: "--code-", fontStyle: true })],
  langs: [],
  engine: createJavaScriptRegexEngine({ forgiving: true }),
});

export type CodeToken = { from: number; to: number; className: string };

export function addGrammars(grammars: LanguageRegistration[]) {
  highlighter.loadLanguageSync(grammars);
}

const FONT_STYLES: [number, string][] = [
  [1, "tok-italic"],
  [2, "tok-bold"],
  [4, "tok-underline"],
];
// Offsets into the text with the token's classes; text without a colour of
// its own (the foreground) gets none.
export function tokenize(language: string, text: string): CodeToken[] {
  const lines = highlighter.codeToTokensBase(text, { lang: language, theme: THEME });
  const tokens: CodeToken[] = [];
  for (const line of lines)
    for (const token of line) {
      const classes: string[] = [];
      const kind = /^var\(--code-token-([a-z-]+)/.exec(token.color || "")?.[1];
      if (kind) classes.push(`tok-${kind}`);
      for (const [flag, name] of FONT_STYLES) if ((token.fontStyle || 0) > 0 && (token.fontStyle! & flag) === flag) classes.push(name);
      if (classes.length && token.content)
        tokens.push({ from: token.offset, to: token.offset + token.content.length, className: classes.join(" ") });
    }
  return tokens;
}
