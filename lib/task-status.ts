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

// A journal task copied on to a later day (#469, journal option "Offene
// Aufgaben: kopieren"): the original stays on its day, closed as cancelled
// (so every count, "My tasks" and an older client see it as not open) and
// marked with the date of the day it continues on (`journalContinued`).
// It is shown as carried over, not as cancelled, and never carried again.
type ContinuedAttrs =
  | ({ checked?: unknown; status?: unknown; symbol?: unknown; journalContinued?: unknown; journalWas?: unknown })
  | null
  | undefined;
export const isContinuedTask = (attrs: ContinuedAttrs) =>
  typeof attrs?.journalContinued === "string" && !!attrs.journalContinued && taskStatusOf(attrs) === "cancelled";

// The day a task was continued on (#469), whatever was done with it on its
// own day since (#536): the marker stays until it is removed on purpose.
export const continuedOn = (attrs: ContinuedAttrs): string | null =>
  typeof attrs?.journalContinued === "string" && /^\d{4}-\d{2}-\d{2}$/.test(attrs.journalContinued) ? attrs.journalContinued : null;
// The state a continued task shows on its day (#536, `journalWas`): stored
// closed as cancelled for everything that counts, it keeps the look it had
// when it was continued – open or in progress (or deferred) – or the one
// given to it there since. Done is stored as done.
export const CONTINUED_SHOWN = ["open", "progress", "deferred", "cancelled"] as const;
type ContinuedShown = (typeof CONTINUED_SHOWN)[number];
export const isContinuedShown = (value: unknown): value is ContinuedShown =>
  typeof value === "string" && (CONTINUED_SHOWN as readonly string[]).includes(value);
// What the task shows: its state, or the one a continued task keeps. A task
// continued before #536 (no `journalWas`) shows as cancelled here and keeps
// its carried-over look in the editor (isLegacyContinued).
export function shownStatusOf(attrs: ContinuedAttrs): TaskStatus {
  const status = taskStatusOf(attrs);
  if (status === "cancelled" && continuedOn(attrs) && isContinuedShown(attrs?.journalWas)) return attrs!.journalWas as ContinuedShown;
  return status;
}
// Continued before #536: its first state is not known.
export const isLegacyContinued = (attrs: ContinuedAttrs) => isContinuedTask(attrs) && !isContinuedShown(attrs?.journalWas);
// The attributes that give a task this state – a continued one stays closed
// (cancelled, showing the state) unless it is done, and keeps its marker.
export function taskStatusAttrs(attrs: ContinuedAttrs, status: TaskStatus) {
  if (!continuedOn(attrs)) return statusAttrs(status);
  if (status === "done") return { ...statusAttrs("done"), journalWas: null };
  return { ...statusAttrs("cancelled"), journalWas: status as ContinuedShown };
}
// The attributes of a continued task as an ordinary one again (the state
// menu's "Nicht mehr als weitergeführt markieren"): the state it shows, open
// for one continued before #536.
export function uncontinuedAttrs(attrs: ContinuedAttrs) {
  const status = isLegacyContinued(attrs) ? "open" : shownStatusOf(attrs);
  return { ...statusAttrs(status), journalContinued: null, journalWas: null };
}
// Behind a continued task's text in exports that show its state (PDF and
// print, e-book, Word, Jira, Confluence): " (→ 2026-11-26)", with the box of
// the state it shows (#536). Markdown keeps it closed as "[-]", so it does
// not come back open when the file is read in again.
export const continuedSuffix = (attrs: ContinuedAttrs) => {
  const on = continuedOn(attrs);
  return on ? ` (→ ${on})` : "";
};
