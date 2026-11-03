// A guess at the language of pasted code, offered as a suggestion only (the
// chip in components/code-block.tsx) – never applied by itself. A handful
// of telling patterns per common language, weighted and added up; no model.
// Returns a Shiki id (lib/code-languages.ts) or null when nothing is clear.
type Rule = [RegExp, number];
const RULES: Record<string, Rule[]> = {
  python: [
    [/^\s*def \w+\(.*\)\s*(->\s*[\w\[\], .]+)?:\s*$/m, 4],
    [/^\s*(from [\w.]+ )?import [\w., ]+$/m, 2],
    [/^\s*class \w+(\([\w., ]*\))?:\s*$/m, 4],
    [/^\s*(if|elif|for|while|with|try|except)\b.*:\s*$/m, 2],
    [/\bprint\(/, 1],
    [/\bself\.\w+/, 2],
    [/^\s*@\w+(\.\w+)*(\(.*\))?\s*$/m, 1],
    [/\b(None|True|False)\b/, 1],
    [/if __name__ == ["']__main__["']/, 5],
  ],
  javascript: [
    [/\b(const|let|var) \w+\s*=/, 2],
    [/\bfunction\s*\w*\s*\(/, 2],
    [/=>\s*[{(\w]/, 1],
    [/\bconsole\.\w+\(/, 3],
    [/\b(require\(["']|module\.exports|export default|import .+ from ["'])/, 2],
    [/\bdocument\.\w+|\bwindow\.\w+/, 2],
    [/===|!==/, 1],
  ],
  typescript: [
    [/\b(interface|type) \w+(<[^>]+>)?\s*(=|\{|extends)/, 4],
    [/:\s*(string|number|boolean|void|unknown|any|never)(\[\])?\b/, 3],
    [/\b(public|private|protected|readonly) \w+\s*[:(]/, 2],
    [/\bas (const|string|number|unknown)\b/, 2],
    [/\benum \w+\s*\{/, 2],
  ],
  java: [
    [/\bpublic (static )?(final )?(class|interface|void|enum) /, 4],
    [/\bSystem\.out\.print/, 5],
    [/^\s*package [\w.]+;\s*$/m, 4],
    [/^\s*import (static )?[\w.]+(\.\*)?;\s*$/m, 3],
    [/@Override\b/, 3],
    [/\bString\[\] args\b/, 4],
  ],
  csharp: [
    [/^\s*using System(\.[\w.]+)?;\s*$/m, 5],
    [/^\s*namespace [\w.]+\s*[{;]?\s*$/m, 3],
    [/\bConsole\.Write(Line)?\(/, 5],
    [/\{\s*get;\s*(set;)?\s*\}/, 4],
    [/\bpublic (async )?(static )?\w+(<\w+>)? \w+\(/, 1],
  ],
  c: [
    [/^\s*#include\s*<\w+\.h>/m, 4],
    [/\bint main\s*\(/, 3],
    [/\bprintf\s*\(/, 2],
    [/\b(malloc|free|sizeof)\s*\(/, 2],
    [/^\s*#define \w+/m, 2],
  ],
  cpp: [
    [/^\s*#include\s*<(iostream|vector|string|map|memory|algorithm)>/m, 5],
    [/\bstd::\w+/, 4],
    [/\b(cout|cin|endl)\b/, 2],
    [/\btemplate\s*<\s*(typename|class)/, 4],
    [/^\s*using namespace std;/m, 5],
  ],
  go: [
    [/^\s*package \w+\s*$/m, 3],
    [/^\s*func (\(\w+ \*?\w+\) )?\w+\(/m, 4],
    [/:=/, 2],
    [/\bfmt\.\w+\(/, 4],
    [/^\s*import \(\s*$/m, 3],
  ],
  rust: [
    [/^\s*(pub )?fn \w+(<[^>]*>)?\(/m, 4],
    [/\blet mut \w+/, 4],
    [/\b(println|format|vec)!\(|\bvec!\[/, 4],
    [/^\s*use [\w:]+(::\{[^}]*\})?;\s*$/m, 2],
    [/\bimpl(<[^>]*>)? [\w<>]+( for \w+)?\s*\{/, 4],
    [/->\s*(Result|Option|Self|&?str|String|i32|u\d+|usize)\b/, 2],
  ],
  php: [
    [/<\?php/, 8],
    [/\$\w+\s*=/, 2],
    [/\becho\s/, 1],
    [/->\w+\(/, 1],
    [/\bfunction \w+\(\s*\$/, 3],
  ],
  ruby: [
    [/^\s*def \w+[?!]?(\(.*\))?\s*$/m, 3],
    [/^\s*end\s*$/m, 2],
    [/\bputs\b/, 2],
    [/^\s*require ["'][\w/]+["']\s*$/m, 2],
    [/\bdo \|\w+(, ?\w+)*\|/, 4],
    [/@\w+\s*=/, 1],
    [/\battr_(accessor|reader|writer)\b/, 4],
  ],
  kotlin: [
    [/\bfun \w+\(/, 4],
    [/\bval \w+(: \w+)?\s*=/, 3],
    [/\bprintln\(/, 1],
    [/\bdata class\b/, 4],
  ],
  swift: [
    [/\bfunc \w+\(/, 3],
    [/^\s*import (UIKit|Foundation|SwiftUI)\s*$/m, 6],
    [/\b(guard|let|var) \w+(: \w+)?\s*=/, 1],
    [/\bstruct \w+: (View|Codable)/, 4],
  ],
  shellscript: [
    [/^#!\/(usr\/)?bin\/(env )?(ba|z)?sh/m, 8],
    [/^\s*(sudo |apt(-get)? |brew |npm |npx |yarn |pnpm |pip3? |git |docker |cd |ls |mkdir |rm |cp |mv |chmod |export |echo |curl |wget )/m, 2],
    [/\$\{?\w+\}?/, 1],
    [/^\s*(if \[|fi$|then$|done$|esac$)/m, 3],
    [/\s(&&|\|\|)\s|\s\|\s\w/, 1],
  ],
  powershell: [
    [/\b(Get|Set|New|Remove|Write|Invoke)-[A-Z]\w+/, 5],
    [/\$\w+\s*=/, 1],
    [/\s-(eq|ne|lt|gt|like|match)\s/, 3],
  ],
  sql: [
    [/^\s*SELECT\b[\s\S]+\bFROM\b/im, 5],
    [/^\s*(INSERT INTO|UPDATE \w+ SET|DELETE FROM|CREATE (TABLE|INDEX|VIEW)|ALTER TABLE|DROP TABLE)\b/im, 5],
    [/\b(WHERE|JOIN|GROUP BY|ORDER BY|VALUES)\b/, 2],
  ],
  html: [
    [/<!DOCTYPE html>/i, 8],
    [/<(html|head|body|div|span|p|a|ul|li|script|link|meta)\b[^>]*>/i, 3],
    [/<\/(div|span|p|a|ul|li|body|html)>/i, 2],
  ],
  xml: [
    [/^\s*<\?xml /, 8],
    [/<\/?[\w-]+:[\w-]+[\s>]/, 2],
    [/<[\w-]+( [\w:-]+="[^"]*")*\s*\/>/, 1],
  ],
  css: [
    [/^\s*[.#:]?[\w-]+([ ,>+~]+[.#:]?[\w-]+)*\s*\{\s*$/m, 2],
    [/^\s*[\w-]+:\s*[^;{}]+;\s*$/m, 2],
    [/@media\s|@import\s|@keyframes\s/, 4],
    [/\b\d+(px|rem|em|vh|vw)\b/, 2],
  ],
  json: [],
  yaml: [
    [/^\s*[\w.-]+:\s*$/m, 2],
    [/^\s*[\w.-]+: [^{}\[\]]+$/m, 2],
    [/^\s*- [\w.-]+(: .*)?$/m, 1],
    [/^---\s*$/m, 2],
  ],
  toml: [
    [/^\s*\[[\w.-]+\]\s*$/m, 3],
    [/^\s*[\w.-]+ = ("[^"]*"|\d+|true|false|\[)/m, 3],
  ],
  dockerfile: [
    [/^\s*FROM [\w./:-]+( AS \w+)?\s*$/im, 5],
    [/^\s*(RUN|COPY|ADD|WORKDIR|ENTRYPOINT|CMD|EXPOSE|ENV|ARG) /m, 3],
  ],
  markdown: [
    [/^#{1,6} \S/m, 2],
    [/^\s*[-*] \[[ x]\] /m, 3],
    [/\[[^\]]+\]\([^)]+\)/, 2],
    [/^```/m, 3],
    [/\*\*[^*]+\*\*/, 1],
  ],
  diff: [
    [/^(---|\+\+\+) [ab]?\/?\S+/m, 4],
    [/^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/m, 6],
  ],
};

export function detectLanguage(text: string): string | null {
  const code = text.trim();
  if (code.length < 8) return null;
  // JSON: when it parses as an object or array, it is JSON.
  if (/^[[{]/.test(code)) {
    try {
      if (typeof JSON.parse(code) === "object") return "json";
    } catch {}
  }
  const sample = code.slice(0, 20_000);
  const scores = Object.entries(RULES)
    .map(([language, rules]) => ({
      language,
      score: rules.reduce((sum, [pattern, weight]) => sum + (pattern.test(sample) ? weight : 0), 0),
    }))
    .sort((a, b) => b.score - a.score);
  // TypeScript is JavaScript with types: its own signs decide.
  const ts = scores.find((s) => s.language === "typescript")!;
  const js = scores.find((s) => s.language === "javascript")!;
  if (ts.score >= 3 && js.score >= 2) ts.score += js.score;
  // C++ includes much of C.
  const cpp = scores.find((s) => s.language === "cpp")!;
  const c = scores.find((s) => s.language === "c")!;
  if (cpp.score >= 4) cpp.score += c.score;
  scores.sort((a, b) => b.score - a.score);
  const [best, second] = scores;
  // Clear enough: a minimum and a lead over the runner-up.
  if (best.score < 4 || best.score - second.score < 2) return null;
  return best.language;
}
