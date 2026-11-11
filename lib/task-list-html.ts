// Task lists ("- [ ] …") as the editor has them, rendered from marked's list
// tokens: use as the `list` renderer (`renderer: { list(token) { return
// taskList.call(this, token) } }`). Nested lists and items with several
// paragraphs keep their structure, as they are rendered by marked itself.
//
// Earlier this was a regex over marked's HTML, which ended a list at the
// first "</li></ul>" – the end of a nested list – so subtasks lost their
// checkbox and later tasks fell out of the list.
//
// Besides "[ ]" and "[x]" the states of Obsidian (#201, lib/task-status.ts):
// "[/]" in progress, "[-]" cancelled, "[>]" deferred, and further symbols
// ("[?]", "[!]" …) kept as they are on an open task.
import type { Renderer, Token, Tokens } from "marked";
import { attrsOfSymbol, statusHtml } from "./task-status";

// "[/] …" and the like: marked reads no task there, nor in "- [ ]" without text.
const SYMBOL_TASK = /^\[([^\]\s]| )\](?=[ \t\n]|$)/;
const symbolOf = (item: Tokens.ListItem) => {
  if (item.task) return null;
  const match = SYMBOL_TASK.exec(item.text.trimStart());
  return match && attrsOfSymbol(match[1]) ? match[1] : null;
};
const isTask = (item: Tokens.ListItem) => item.task || symbolOf(item) !== null;
// The symbol as marked rendered it at the start of the text.
const RENDERED_SYMBOL = /^\[(?:&[#a-z0-9]+;|[^\]<\s]| )\][ \t]*/;

type Options = {
  // The rendered first line of a task, to take attributes from (the due date).
  head?: (html: string) => { html: string; attrs: string };
};

// A list with task items as task lists (runs of other items stay plain
// bullet lists, as the editor splits them anyway); false for other lists,
// so marked renders them as usual.
export function taskList(this: Renderer, token: Tokens.List, options: Options = {}): string | false {
  if (token.ordered || !token.items.some(isTask)) return false;
  const parser = this.parser;
  const runs: { task: boolean; items: string[] }[] = [];
  for (const item of token.items) {
    const symbol = symbolOf(item);
    const task = isTask(item);
    let html: string;
    if (!task) html = `<li>${parser.parse(item.tokens)}</li>\n`;
    else {
      const attrs = symbol !== null ? attrsOfSymbol(symbol)! : { checked: !!item.checked, status: null, symbol: null };
      const tokens = item.tokens.filter((t) => t.type !== "checkbox");
      // The first paragraph is the task's text; what follows (more
      // paragraphs, nested lists) is rendered as it is.
      const first = tokens[0] as Tokens.Text | Tokens.Paragraph | undefined;
      let head = "",
        rest: Token[] = tokens;
      if (first && (first.type === "text" || first.type === "paragraph")) {
        head = parser.parseInline(first.tokens ? first.tokens.filter((t) => t.type !== "checkbox") : [{ type: "text", raw: first.text, text: first.text }]);
        if (symbol !== null) head = head.replace(RENDERED_SYMBOL, "");
        rest = tokens.slice(1);
      }
      const done = options.head ? options.head(head) : { html: head, attrs: "" };
      html = `<li data-type="taskItem" data-checked="${attrs.checked}"${statusHtml(attrs)}${done.attrs}><p>${done.html}</p>${parser.parse(rest)}</li>\n`;
    }
    const run = runs[runs.length - 1];
    if (run && run.task === task) run.items.push(html);
    else runs.push({ task, items: [html] });
  }
  return runs.map((run) => `<ul${run.task ? ' data-type="taskList"' : ""}>${run.task ? "" : "\n"}${run.items.join("")}</ul>\n`).join("");
}
