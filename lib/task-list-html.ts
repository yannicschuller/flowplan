// The task lists in HTML rendered by marked, found in linear time: use as
// `html.replace(TASK_LISTS, (list, items) => …)`.
//
// It matches exactly what the regex
//   /<ul>\s*((?:<li><input[^>]*type="checkbox"[^>]*>[\s\S]*?<\/li>\s*)+)<\/ul>/g
// did: a list whose first item starts with a checkbox runs to the first
// "</li>" that only white space separates from a "</ul>", and `items` is
// everything between "<ul>\s*" and that "</ul>". That regex backtracked
// exponentially on input like '<ul><li><input' followed by many
// 'type="checkbox"' (CodeQL js/redos), and the server renders Markdown sent
// through the API, MCP, synced issues and imports.
type TaskListReplacer = (list: string, items: string) => string;

function replaceTaskLists(html: string, replace: TaskListReplacer): string {
  const listStart = /<ul>\s*<li><input([^>]*)>/g;
  const listEnd = /<\/li>\s*<\/ul>/g;
  let out = "";
  let copied = 0;
  // The first list end found so far (-1: none left, -2: not searched yet):
  // searches only ever move forwards, so the whole run stays linear.
  let endAt = -2;
  let endLength = 0;
  for (let start = listStart.exec(html); start; start = listStart.exec(html)) {
    if (!start[1].includes('type="checkbox"')) {
      listStart.lastIndex = start.index + 1;
      continue;
    }
    const bodyFrom = listStart.lastIndex;
    if (endAt === -2 || (endAt !== -1 && endAt < bodyFrom)) {
      listEnd.lastIndex = bodyFrom;
      const end = listEnd.exec(html);
      endAt = end ? end.index : -1;
      endLength = end ? end[0].length : 0;
    }
    if (endAt === -1) break; // no list end left: no later list can match either
    const after = endAt + endLength;
    const itemsFrom = start.index + start[0].indexOf("<li>");
    out += html.slice(copied, start.index) + replace(html.slice(start.index, after), html.slice(itemsFrom, after - "</ul>".length));
    copied = after;
    listStart.lastIndex = after;
  }
  return copied === 0 ? html : out + html.slice(copied);
}

export const TASK_LISTS = {
  [Symbol.replace]: (html: string, replace: TaskListReplacer) => replaceTaskLists(html, replace),
};
