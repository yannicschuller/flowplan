// The five states of a task in a document (#201): open "[ ]", in progress
// "[/]", done "[x]", cancelled "[-]" and deferred "[>]" – the symbols of
// Obsidian and its Tasks plugin. A task item keeps `checked` (what older
// clients, "My tasks", the journal and every export already read) and adds
// `status` for the three further states; `checked` decides when the two
// disagree (an older client ticked or unticked the task), so a task is
// never shown done and open at once:
//
//   open        checked false, status null
//   progress    checked false, status "progress"
//   done        checked true,  status null
//   cancelled   checked true,  status "cancelled"  (closed, not done)
//   deferred    checked false, status "deferred"   (still open)
//
// Other Obsidian symbols ("[?]", "[!]", "[<]" …) are kept in `symbol`: the
// task counts as open and is written back with its own symbol.
export const TASK_STATUSES = ["open", "progress", "done", "cancelled", "deferred"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
// The values `status` may hold (open and done are `checked` alone).
export const STORED_STATUSES = ["progress", "cancelled", "deferred"] as const;
export type StoredStatus = (typeof STORED_STATUSES)[number];

export const STATUS_SYMBOL: Record<TaskStatus, string> = { open: " ", progress: "/", done: "x", cancelled: "-", deferred: ">" };

type Attrs = { checked?: unknown; status?: unknown; symbol?: unknown } | null | undefined;

export const isStoredStatus = (value: unknown): value is StoredStatus =>
  typeof value === "string" && (STORED_STATUSES as readonly string[]).includes(value);
// The symbols kept as they are: letters and the marks of Obsidian's themes
// and the Tasks plugin. Not digits ("- [1] Source" is a reference list) and
// not brackets.
export const isTaskSymbol = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z?!*"<+~']$/.test(value) && value !== "x" && value !== "X";

// The state of a task item from its attributes.
export function taskStatusOf(attrs: Attrs): TaskStatus {
  const status = attrs?.status;
  if (attrs?.checked) return status === "cancelled" ? "cancelled" : "done";
  return status === "progress" || status === "deferred" ? status : "open";
}
// The unknown symbol a task shows (only while it is open).
export const taskSymbolOf = (attrs: Attrs): string | null =>
  taskStatusOf(attrs) === "open" && isTaskSymbol(attrs?.symbol) ? (attrs!.symbol as string) : null;
// The attributes that give a task this state (an unknown symbol goes).
export function statusAttrs(status: TaskStatus): { checked: boolean; status: StoredStatus | null; symbol: null } {
  return {
    checked: status === "done" || status === "cancelled",
    status: isStoredStatus(status) ? status : null,
    symbol: null,
  };
}
// Done or cancelled: nothing left to do.
export const isClosedStatus = (status: TaskStatus) => status === "done" || status === "cancelled";

// Ctrl/Cmd+L: open → in progress → done → open; cancelled and deferred
// start again as open.
export function nextStatus(status: TaskStatus): TaskStatus {
  return status === "open" ? "progress" : status === "progress" ? "done" : "open";
}

// The symbol between the brackets of "- [ ] …" for a task.
export function markdownSymbol(attrs: Attrs): string {
  return taskSymbolOf(attrs) ?? STATUS_SYMBOL[taskStatusOf(attrs)];
}
// The attributes of a task written "- [c] …"; null when c is no task symbol.
export function attrsOfSymbol(symbol: string): { checked: boolean; status: StoredStatus | null; symbol: string | null } | null {
  if (symbol === " " || symbol === "") return statusAttrs("open");
  if (symbol === "x" || symbol === "X") return statusAttrs("done");
  if (symbol === "/") return statusAttrs("progress");
  if (symbol === "-") return statusAttrs("cancelled");
  if (symbol === ">") return statusAttrs("deferred");
  if (isTaskSymbol(symbol)) return { checked: false, status: null, symbol };
  return null;
}
// The data- attributes of a task item in HTML (beside data-checked).
export function statusHtmlAttrs(attrs: Attrs) {
  const status = taskStatusOf(attrs);
  const symbol = taskSymbolOf(attrs);
  return {
    ...(isStoredStatus(status) ? { "data-status": status } : {}),
    ...(symbol ? { "data-symbol": symbol } : {}),
  };
}
// The same as an attribute string: ` data-status="progress"`.
export function statusHtml(attrs: Attrs) {
  return Object.entries(statusHtmlAttrs(attrs))
    .map(([name, value]) => ` ${name}="${value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")}"`)
    .join("");
}

type T = (de: string, en: string) => string;
// The name of a state, for menus and screen readers.
export function statusName(t: T, status: TaskStatus) {
  switch (status) {
    case "progress":
      return t("In Arbeit", "In progress");
    case "done":
      return t("Erledigt", "Done");
    case "cancelled":
      return t("Abgebrochen", "Cancelled");
    case "deferred":
      return t("Verschoben", "Deferred");
    default:
      return t("Offen", "Open||task status");
  }
}
// A box to put in front of a task's text where no checkbox can be (plain
// text exports): ☐ ◐ ☑ ☒ ➔.
export const STATUS_BOX: Record<TaskStatus, string> = { open: "☐", progress: "◐", done: "☑", cancelled: "☒", deferred: "➔" };
