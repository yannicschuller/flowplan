// Pasting answers from ChatGPT and similar assistants: formulas written as
// LaTeX (\[ … \], \( … \), $$ … $$) become formula blocks and inline
// formulas, Markdown (headings, bold, lists, tables) is formatted,
// tab-separated lines become a table, "☐" a checklist, and every line its own
// paragraph. Copied web pages with rendered KaTeX keep their formulas as LaTeX.
import { Marked, type Tokens } from "marked";

const OPEN = "",
  CLOSE = "",
  INLINE_OPEN = "",
  INLINE_CLOSE = "";
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Whether plain text is worth converting (otherwise it is pasted as usual).
export function looksLikeChatText(text: string) {
  if (!text.includes("\n")) return /\\\(|\\\[|\$\$/.test(text);
  return /\\\[|\\\(|\$\$|\\begin\{|^\s{0,3}#{1,6}\s|\*\*[^*\n]+\*\*|^\s*\|.+\|\s*$|^[^\t\n]+\t[^\n]+$|^\s*☐/m.test(text);
}

const listLine = /^\s*(?:[-*+•]|\d+[.)]|- \[[ xX]\])\s+\S/;
const tableLine = /^\s*\|.*\|\s*$/;

export function chatTextToHtml(text: string): string {
  const formulas: string[] = [];
  const keep = (tex: string) => formulas.push(tex.trim()) - 1;
  let s = text.replace(/\r\n?/g, "\n");
  // Formulas first, so Markdown does not touch their backslashes and stars.
  s = s
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, tex: string) => `\n\n${OPEN}${keep(tex)}${CLOSE}\n\n`)
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, tex: string) => `\n\n${OPEN}${keep(tex)}${CLOSE}\n\n`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, tex: string) => `${INLINE_OPEN}${keep(tex)}${INLINE_CLOSE}`)
    // $…$ only when it is clearly maths (not "5 $ and 6 $").
    .replace(/(?<![\\$\w])\$(?!\s)([^$\n]*?[\\^_=][^$\n]*?)(?<!\s)\$(?![\w$])/g, (_, tex: string) => `${INLINE_OPEN}${keep(tex)}${INLINE_CLOSE}`);
  const lines = s.split("\n");
  const out: string[] = [];
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence || /^\s*(```|~~~)/.test(line)) {
      out.push(line);
      continue;
    }
    // Tab-separated rows (copied tables): a Markdown table, first row as header.
    if (line.includes("\t") && lines[i + 1]?.includes("\t")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("\t")) rows.push(lines[i++].split("\t").map((c) => c.trim().replace(/\|/g, "\\|")));
      i--;
      const width = Math.max(...rows.map((r) => r.length));
      const row = (r: string[]) => `| ${Array.from({ length: width }, (_, k) => r[k] || "").join(" | ")} |`;
      out.push("", row(rows[0]), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(row), "");
      continue;
    }
    line = line.replace(/^(\s*)☐\s*/, "$1- [ ] ").replace(/^(\s*)[☑☒]\s*/, "$1- [x] ").replace(/^(\s*)•\s+/, "$1- ");
    // Chat answers put one thought per line: each line its own paragraph,
    // except inside lists and tables.
    const previous = out[out.length - 1];
    if (previous !== undefined && previous.trim() && line.trim()) {
      const together = (listLine.test(previous) && listLine.test(line)) || (tableLine.test(previous) && tableLine.test(line)) || /^\s{2,}\S/.test(line);
      if (!together) out.push("");
    }
    out.push(line);
  }
  const marked = new Marked({ gfm: true, breaks: false, async: false });
  marked.use({ renderer: { html: ({ text: raw }: Tokens.HTML | Tokens.Tag) => escapeHtml(raw) } });
  const html = (marked.parse(out.join("\n")) as string)
    // Task lists as the editor has them.
    .replace(/<ul>\s*((?:<li><input[^>]*type="checkbox"[^>]*>[\s\S]*?<\/li>\s*)+)<\/ul>/g, (_, items: string) =>
      `<ul data-type="taskList">${items.replace(/<li><input([^>]*)>\s*([\s\S]*?)<\/li>/g, (_m: string, attrs: string, body: string) => `<li data-type="taskItem" data-checked="${/checked/.test(attrs)}"><p>${body.replace(/^<p>|<\/p>$/g, "")}</p></li>`)}</ul>`,
    );
  const tex = (i: string) => escapeHtml(formulas[Number(i)] ?? "");
  return html
    .replace(new RegExp(`<p>\\s*${OPEN}(\\d+)${CLOSE}\\s*</p>`, "g"), (_, i: string) => `<div data-math="${tex(i)}"></div>`)
    .replace(new RegExp(`[${OPEN}${INLINE_OPEN}](\\d+)[${CLOSE}${INLINE_CLOSE}]`, "g"), (_, i: string) => `<span data-math="${tex(i)}"></span>`);
}

// Formulas written as text: \[ … \] and $$ … $$ (display), \( … \) (inline).
export const LATEX_PATTERN = /\\\[([\s\S]+?)\\\]|\$\$([\s\S]+?)\$\$|\\\(([\s\S]+?)\\\)/g;
export const hasLatexText = (text: string) => /\\\[[\s\S]+?\\\]|\$\$[\s\S]+?\$\$|\\\([\s\S]+?\\\)/.test(text);

// Copied web pages (ChatGPT in the browser): formulas rendered with KaTeX or
// MathML, or still written as \[ … \] text, become formulas; paragraphs of
// "☐" lines become task lists.
export function mathFromPastedHtml(html: string): string {
  if (!/katex|<math[\s>]|\\\[|\\\(|\$\$|☐|☑/i.test(html) || typeof DOMParser === "undefined") return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const texOf = (el: Element) => el.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim() || "";
  for (const el of [...doc.querySelectorAll(".katex-display, .katex, math")]) {
    if (!el.isConnected || el.closest("[data-math]")) continue;
    const tex = texOf(el);
    if (!tex) continue;
    const display = el.classList.contains("katex-display") || el.getAttribute("display") === "block" || !!el.closest(".katex-display");
    const target = el.closest(".katex-display") || el;
    const node = doc.createElement(display ? "div" : "span");
    node.setAttribute("data-math", tex);
    target.replaceWith(node);
  }
  const formula = (tag: "div" | "span", tex: string) => {
    const node = doc.createElement(tag);
    node.setAttribute("data-math", tex.trim());
    return node;
  };
  // Paragraphs made only of display formulas become formula blocks.
  for (const p of [...doc.querySelectorAll("p, div:not([data-math])")]) {
    if (p.children.length) continue;
    const text = p.textContent || "";
    const parts = [...text.matchAll(LATEX_PATTERN)];
    if (!parts.length || parts.some((m) => m[3] !== undefined) || text.replace(LATEX_PATTERN, "").trim()) continue;
    p.replaceWith(...parts.map((m) => formula("div", m[1] ?? m[2])));
  }
  // Formulas inside text become inline formulas.
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (hasLatexText(n.nodeValue || "") && !n.parentElement?.closest("pre, code, [data-math]")) texts.push(n as Text);
  for (const node of texts) {
    const value = node.nodeValue || "";
    const pieces: (string | Element)[] = [];
    let last = 0;
    for (const m of value.matchAll(LATEX_PATTERN)) {
      pieces.push(value.slice(last, m.index));
      pieces.push(formula("span", m[1] ?? m[2] ?? m[3]));
      last = m.index! + m[0].length;
    }
    pieces.push(value.slice(last));
    node.replaceWith(...pieces.filter((x) => x !== ""));
  }
  // "☐ a<br>☐ b" paragraphs: task lists.
  for (const p of [...doc.querySelectorAll("p")]) {
    const lines = p.innerHTML.split(/<br\s*\/?>/i).map((l) => l.trim()).filter(Boolean);
    if (!lines.length || !lines.every((l) => /^(☐|☑|☒|✅)\s*/.test(l))) continue;
    const list = doc.createElement("ul");
    list.setAttribute("data-type", "taskList");
    for (const line of lines) {
      const li = doc.createElement("li");
      li.setAttribute("data-type", "taskItem");
      li.setAttribute("data-checked", String(!line.startsWith("☐")));
      li.innerHTML = `<p>${line.replace(/^(☐|☑|☒|✅)\s*/, "")}</p>`;
      list.append(li);
    }
    p.replaceWith(list);
  }
  return doc.body.innerHTML;
}
