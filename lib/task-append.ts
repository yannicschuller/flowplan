// One new task in a document (#208): "Aufgabe hinzufügen" in My tasks
// (lib/personal-tasks.ts) and the workflow node "Aufgabe erstellen"
// (lib/workflows/nodes/pages.ts). The task joins the task list it follows –
// at the end of the document, or at the end of the section below a heading
// (made at the end when there is none) – instead of starting a list of its
// own each time. Plain functions on ProseMirror nodes, no database.
import type { Node as PMNode, Schema } from "@tiptap/pm/model";

type Json = { type: string; attrs?: Record<string, unknown>; content?: Json[]; text?: string; marks?: unknown[] };

// The task item: its line (text nodes, links), a person and a due date.
export function taskItemJson(line: Json[], options: { due?: string | null; assignee?: { id: string; name: string } | null } = {}): Json {
  const content: Json[] = [...line];
  if (options.assignee) content.push({ type: "text", text: " " }, { type: "mention", attrs: { userId: options.assignee.id, label: options.assignee.name } });
  return {
    type: "taskItem",
    attrs: { checked: false, ...(options.due ? { due: options.due } : {}) },
    content: [{ type: "paragraph", ...(content.length ? { content } : {}) }],
  };
}

const isEmptyDoc = (children: PMNode[]) => children.length === 1 && children[0].type.name === "paragraph" && !children[0].content.size;
const sameHeading = (node: PMNode, wanted: string) => node.type.name === "heading" && node.textContent.trim().toLowerCase() === wanted;

// The document with the task added. `heading`: below the first heading with
// that text (case does not matter), else a new heading at the end.
export function appendTask(doc: PMNode, schema: Schema, item: Json, heading = ""): PMNode {
  const task = schema.nodeFromJSON(item);
  const list = () => schema.nodes.taskList.create(null, [task]);
  const children: PMNode[] = [];
  doc.content.forEach((n) => children.push(n));
  const kept = isEmptyDoc(children) ? [] : children;
  // Into the task list just before `end`, or a new list at `end`.
  const insertAt = (end: number, from: number) => {
    const before = end - 1 >= from ? kept[end - 1] : undefined;
    if (before?.type.name === "taskList") kept[end - 1] = before.copy(before.content.addToEnd(task));
    else kept.splice(end, 0, list());
  };
  const wanted = heading.trim().toLowerCase();
  if (!wanted) insertAt(kept.length, 0);
  else {
    const at = kept.findIndex((n) => sameHeading(n, wanted));
    if (at < 0) kept.push(schema.nodes.heading.create({ level: 2 }, schema.text(heading.trim())), list());
    else {
      // The section: up to the next heading of the same or a higher level.
      const level = Number(kept[at].attrs.level || 1);
      let end = at + 1;
      while (end < kept.length && !(kept[end].type.name === "heading" && Number(kept[end].attrs.level || 1) <= level)) end++;
      insertAt(end, at + 1);
    }
  }
  return doc.type.create(doc.attrs, kept, doc.marks);
}
