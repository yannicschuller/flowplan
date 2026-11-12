// Where a menu or popover that floats above the content is rendered: inside
// the open dialog its button sits in (a database record, #232), else in
// <body>. A modal dialog turns pointer events off on <body> and treats every
// press outside its content as one outside the dialog – a menu in <body>
// would take no clicks, and its own "click elsewhere" would close it. Inside
// the dialog it stays clickable and within the dialog's focus trap. Dialogs
// hold no transform once open (app/globals.css, .modal), so position: fixed
// still means the window there.
export function layerHost(from: Element | null | undefined): HTMLElement {
  return from?.closest<HTMLElement>('[role="dialog"]') ?? document.body;
}

// Escape while the focus is in such a menu or popover (marked data-layer)
// inside a dialog: the menu closes, not the dialog (components/ui.tsx,
// Modal). Radix sees Escape on the document before the menu does; the
// dialog keeps it from closing (preventDefault) and marks the event, so the
// menu still takes it.
const layerEscapes = new WeakSet<Event>();
export function keepDialogForLayer(dialog: Element | null, event: KeyboardEvent) {
  const layer = (event.target as Element | null)?.closest?.("[data-layer]");
  if (!dialog || !layer || !dialog.contains(layer)) return;
  event.preventDefault();
  layerEscapes.add(event);
}
// Whether Escape was left to the menu (it is defaultPrevented all the same).
export function escapeForLayer(event: Event) {
  return layerEscapes.has(event);
}
