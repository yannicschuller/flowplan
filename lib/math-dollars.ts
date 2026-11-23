// Formulas written with dollars (#446), as Pandoc's tex_math_dollars reads
// them – shared by the editor's input rule (lib/math-input.ts), the
// Markdown import (lib/markdown-html.ts) and pasted text (lib/chat-paste.ts),
// so all three agree on what is a formula:
//
// - $…$ is an inline formula when the opening "$" is not followed by
//   whitespace, the closing "$" is not preceded by whitespace and not
//   followed immediately by a digit, and the content is not empty – so
//   "costs $5 and $10" stays text.
// - $$…$$ is a display formula (non-empty content, no blank line inside);
//   "$$" is never an inline delimiter.
// - A backslash escapes the next character: "\$" is a literal dollar that
//   never opens or closes a formula (inside a formula it stays LaTeX).
// - No formula spans a blank line or is longer than MAX_MATH_LENGTH.
import { MAX_MATH_LENGTH } from "./math-render-lazy";

export type DollarMath = {
  // Offsets in the text: from the opening "$" to after the closing one.
  from: number;
  to: number;
  expression: string;
  display: boolean;
};

const SPACE = /\s/;
const DIGIT = /[0-9]/;

// A blank line (a paragraph break) starts at text[i] === "\n".
function blankLineAt(text: string, i: number) {
  for (let k = i + 1; k < text.length; k++) {
    if (text[k] === "\n") return true;
    if (!SPACE.test(text[k])) return false;
  }
  return false;
}

// The formula that starts at text[at] (a "$"), or null. The caller makes
// sure the "$" is not the second of a "$$" and not escaped.
export function dollarMathAt(text: string, at: number): DollarMath | null {
  if (text[at] !== "$") return null;
  const limit = Math.min(text.length, at + 2 + MAX_MATH_LENGTH + 2);
  if (text[at + 1] === "$") {
    for (let j = at + 2; j < limit; j++) {
      const ch = text[j];
      if (ch === "\\") j++;
      else if (ch === "\n" && blankLineAt(text, j)) return null;
      else if (ch === "$" && text[j + 1] === "$") {
        const expression = text.slice(at + 2, j).trim();
        return expression && expression.length <= MAX_MATH_LENGTH ? { from: at, to: j + 2, expression, display: true } : null;
      }
    }
    return null;
  }
  const first = text[at + 1];
  if (first === undefined || SPACE.test(first)) return null;
  for (let j = at + 1; j < limit; j++) {
    const ch = text[j];
    if (ch === "\\") j++;
    else if (ch === "\n" && blankLineAt(text, j)) return null;
    else if (ch === "$") {
      // The first "$" ends it; when that one may not close, it is no formula.
      if (SPACE.test(text[j - 1]) || text[j + 1] === "$" || DIGIT.test(text[j + 1] ?? "")) return null;
      const expression = text.slice(at + 1, j).replace(/\s*\n\s*/g, " ");
      return expression && expression.length <= MAX_MATH_LENGTH ? { from: at, to: j + 1, expression, display: false } : null;
    }
  }
  return null;
}

// Every formula in a text, left to right. With `codeSpans`, Markdown code
// spans (`…`) are skipped as they are.
export function findDollarMath(text: string, options: { codeSpans?: boolean } = {}): DollarMath[] {
  const found: DollarMath[] = [];
  if (!text.includes("$")) return found;
  for (let i = 0; i < text.length; ) {
    const ch = text[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`" && options.codeSpans) {
      let n = 1;
      while (text[i + n] === "`") n++;
      const fence = "`".repeat(n);
      let close = text.indexOf(fence, i + n);
      while (close >= 0 && text[close + n] === "`") {
        let k = close;
        while (text[k] === "`") k++;
        close = text.indexOf(fence, k);
      }
      i = close < 0 ? i + n : close + n;
      continue;
    }
    if (ch !== "$") {
      i++;
      continue;
    }
    const math = dollarMathAt(text, i);
    if (math) {
      found.push(math);
      i = math.to;
    } else i += text[i + 1] === "$" ? 2 : 1;
  }
  return found;
}

// The formula that ends exactly at the end of the text (the "$" just typed),
// or null – the editor's input rule.
export function dollarMathAtEnd(text: string): DollarMath | null {
  if (!text.endsWith("$")) return null;
  const found = findDollarMath(text);
  const last = found[found.length - 1];
  return last && last.to === text.length ? last : null;
}

// Whether the text ends inside a formula still being typed: an opening "$"
// (or "$$") that a "$" typed now would close.
export function insideOpenDollarMath(text: string): boolean {
  const math = dollarMathAtEnd(text + "x$") ?? dollarMathAtEnd(text + "x$$");
  return !!math && math.from < text.length;
}
