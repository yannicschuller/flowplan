// Due dates on tasks: a chip at the right of the task line, outside the
// text so the caret never lands behind it (red when overdue, highlighted
// today). A date is set from the text menu or the toolbar (pickTaskDue);
// clicking the chip changes or removes it.
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";

export const taskDueKey = new PluginKey("taskDue");
const pad = (n: number) => String(n).padStart(2, "0");
export function localToday(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
export function dueLabel(due: string, today = localToday()) {
  const day = (value: string) => Date.parse(`${value}T00:00:00Z`);
  const diff = Math.round((day(due) - day(today)) / 864e5);
  if (diff === 0) return "Heute";
  if (diff === 1) return "Morgen";
  if (diff === -1) return "Gestern";
  const date = new Date(`${due}T00:00:00Z`);
  const sameYear = due.slice(0, 4) === today.slice(0, 4);
  return date.toLocaleDateString("de-DE", {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });
}
export function dueState(due: string, checked: boolean, today = localToday()) {
  if (checked) return "done";
  if (due < today) return "overdue";
  if (due === today) return "today";
  return "later";
}

function pickDate(view: EditorView, pos: number, current: string | null, anchor: HTMLElement) {
  document.querySelector(".task-due-popover")?.remove();
  const box = document.createElement("div");
  box.className = "task-due-popover";
  const input = document.createElement("input");
  input.type = "date";
  input.className = "task-due-picker";
  input.setAttribute("aria-label", "Fällig am");
  input.value = current || localToday();
  box.append(input);
  const rect = anchor.getBoundingClientRect();
  Object.assign(box.style, {
    position: "fixed",
    left: `${Math.min(rect.left, window.innerWidth - 240)}px`,
    top: `${rect.bottom + 4}px`,
    zIndex: "1000",
  });
  const set = (value: string | null) => {
    const node = view.state.doc.nodeAt(pos);
    if (node?.type.name !== "taskItem") return;
    view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, due: value }));
    view.focus();
  };
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    box.remove();
    document.removeEventListener("mousedown", outside, true);
  };
  const outside = (event: MouseEvent) => {
    if (!box.contains(event.target as Node)) finish();
  };
  if (current) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "task-due-remove";
    remove.textContent = "Datum entfernen";
    remove.addEventListener("click", () => {
      set(null);
      finish();
    });
    box.append(remove);
  }
  document.body.append(box);
  document.addEventListener("mousedown", outside, true);
  input.addEventListener("change", () => {
    set(input.value || null);
    finish();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") finish();
    if (event.key === "Enter") {
      set(input.value || null);
      finish();
    }
  });
  input.focus();
  try {
    input.showPicker();
  } catch {
    // Older browsers: the visible input remains usable.
  }
}

// The task around the cursor, if any.
export function taskAtSelection(view: EditorView) {
  const { $from } = view.state.selection;
  for (let d = $from.depth; d > 0; d--)
    if ($from.node(d).type.name === "taskItem") return { pos: $from.before(d), node: $from.node(d) };
  return null;
}
// Opens the date picker for the task around the cursor, below `anchor`.
export function pickTaskDue(view: EditorView, anchor: HTMLElement) {
  const task = taskAtSelection(view);
  if (!task) return false;
  pickDate(view, task.pos, (task.node.attrs.due as string | null) || null, anchor);
  return true;
}

function chip(view: EditorView, pos: number, node: PMNode, editable: boolean) {
  const due = node.attrs.due as string | null;
  const el = document.createElement(editable ? "button" : "span");
  el.contentEditable = "false";
  el.className = `task-due task-due-${due ? dueState(due, !!node.attrs.checked) : "later"}`;
  el.textContent = due ? `📅 ${dueLabel(due)}` : "";
  if (due) el.title = `Fällig am ${new Date(`${due}T00:00:00Z`).toLocaleDateString("de-DE", { timeZone: "UTC" })}${editable ? " – klicken zum Ändern oder Entfernen" : ""}`;
  if (editable && el instanceof HTMLButtonElement) {
    el.type = "button";
    el.setAttribute("aria-label", due ? `Fälligkeit ${dueLabel(due)} ändern` : "Fälligkeit setzen");
    el.addEventListener("mousedown", (event) => event.preventDefault());
    el.addEventListener("click", (event) => {
      event.preventDefault();
      pickDate(view, pos, due, el);
    });
  }
  return el;
}

export const TaskDue = Extension.create({
  name: "taskDue",
  addProseMirrorPlugins() {
    const editable = () => this.editor.isEditable;
    return [
      new Plugin({
        key: taskDueKey,
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (node.type.name !== "taskItem") return true;
              const first = node.firstChild;
              if (!first || !first.isTextblock || !node.attrs.due) return true;
              // After the task's first line, not inside its text.
              const after = pos + 1 + first.nodeSize;
              decorations.push(
                Decoration.widget(after, (view) => chip(view, pos, node, editable()), {
                  side: -1,
                  ignoreSelection: true,
                  key: `due-${pos}-${node.attrs.due}-${node.attrs.checked}-${editable()}`,
                }),
              );
              return true;
            });
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});
