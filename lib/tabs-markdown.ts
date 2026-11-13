// Tabs in Markdown (#272): the syntax of Obsidian's Tabs plugin
// (github.com/xhuajin/obsidian-tabs), so a tabs block survives the round
// trip through Markdown files, Obsidian vaults and the source view:
//
//   ```tabs
//   tab: First tab
//   Content of the first tab
//
//   tab: Second tab
//   Content of the second tab
//   ```
//
// A tab's content is ordinary Markdown. When it holds code blocks the
// outer fence is longer (````tabs) or uses tildes (~~~tabs). A line of
// options before the first tab ("top, multi") is the plugin's own and is
// ignored. Written by lib/markdown.ts, read by lib/markdown-html.ts.

const TAB_LINE = /^tab:[ \t]?(.*)$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const OPTIONS = /^\s*(?:top|left|right|bottom|one|multi)(?:\s*,\s*(?:top|left|right|bottom|one|multi))*\s*$/i;

export type MarkdownTab = { title: string; body: string };

// Walks the lines of Markdown, telling for each whether it is inside a
// fenced code block (its fence lines count as inside).
function eachLine(markdown: string, visit: (line: string, fenced: boolean) => string | void) {
  let fence: string | null = null;
  return markdown.split("\n").map((line) => {
    const opening = FENCE.exec(line);
    let fenced = !!fence;
    if (fence) {
      if (opening && opening[1][0] === fence[0] && opening[1].length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) fence = null;
    } else if (opening) {
      fence = opening[1];
      fenced = true;
    }
    const out = visit(line, fenced);
    return out === undefined ? line : out;
  });
}

// The tabs of a ```tabs block's text.
export function splitTabs(text: string): MarkdownTab[] {
  const tabs: MarkdownTab[] = [];
  const before: string[] = [];
  let current: { title: string; lines: string[] } | null = null;
  const parts: { title: string; lines: string[] }[] = [];
  eachLine(text.replace(/\r\n?/g, "\n"), (line, fenced) => {
    const tab = fenced ? null : TAB_LINE.exec(line);
    if (tab) {
      current = { title: tab[1].trim(), lines: [] };
      parts.push(current);
      return;
    }
    if (current) current.lines.push(line);
    else before.push(line);
  });
  // Text before the first tab that is no option line: a tab of its own.
  const lead = before.filter((line) => line.trim() && !OPTIONS.test(line));
  if (lead.length) tabs.push({ title: "", body: before.filter((line) => !OPTIONS.test(line)).join("\n").trim() });
  for (const part of parts) tabs.push({ title: part.title, body: part.lines.join("\n").trim() });
  return tabs;
}

// A line of content that would read as a new tab is written with its
// first letter as an entity (Markdown shows it as the letter).
const protect = (body: string) => eachLine(body, (line, fenced) => (!fenced && TAB_LINE.test(line) ? `&#116;${line.slice(1)}` : undefined)).join("\n");

// The ```tabs block for tabs with their content as Markdown.
export function tabsMarkdown(tabs: MarkdownTab[]) {
  const text = tabs
    .map((tab) => {
      const title = tab.title.replace(/\s+/g, " ").trim();
      const body = protect(tab.body.trim());
      return `tab: ${title}${body ? `\n${body}` : ""}`;
    })
    .join("\n\n");
  // Longer than any backtick run inside (code blocks in a tab).
  const runs = text.match(/`+/g) || [];
  const fence = "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
  return `${fence}tabs\n${text}\n${fence}`;
}
