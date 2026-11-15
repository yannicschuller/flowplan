// Drawing blocks just inserted ("/draw") start in drawing mode once their
// editor has loaded (#311): no tap on the new block first. Kept outside the
// lazily loaded block editor, so the slash menu can queue a block before
// its view exists.
const queued = new Set<string>();
export const queueDrawingStart = (id: string) => void queued.add(id);
// Whether the block was queued; it is taken off the queue.
export const takeDrawingStart = (id: string) => queued.delete(id);
