// Live cursors on whiteboards: positions go through memory and are pushed to
// everyone on the same board (server-sent events), no database round trip.
// Flowplan runs as a single process, so one hub reaches every viewer.
export type BoardView = { x: number; y: number; w: number; h: number };
export type BoardCursor = {
  userId: string;
  name: string;
  x: number;
  y: number;
  at: number;
  // Laser pointer: the others draw a fading red trail.
  laser?: boolean;
  // The visible part of the board (sent while others follow this person).
  view?: BoardView;
};
type Listener = { userId: string; send: (event: string) => void };
type Board = { cursors: Map<string, BoardCursor>; listeners: Set<Listener> };

const STALE_MS = 15_000;
const hub = globalThis as unknown as { flowplanBoards?: Map<string, Board> };
const boards = (hub.flowplanBoards ??= new Map());

function board(pageId: string) {
  let b = boards.get(pageId);
  if (!b) {
    b = { cursors: new Map(), listeners: new Set() };
    boards.set(pageId, b);
  }
  return b;
}
function broadcast(b: Board, payload: unknown, except?: string) {
  const event = `data: ${JSON.stringify(payload)}\n\n`;
  for (const listener of b.listeners)
    if (listener.userId !== except)
      try {
        listener.send(event);
      } catch {
        b.listeners.delete(listener);
      }
}
function sweep(pageId: string, b: Board) {
  const now = Date.now();
  for (const [id, cursor] of b.cursors)
    if (now - cursor.at > STALE_MS) {
      b.cursors.delete(id);
      broadcast(b, { type: "leave", userId: id });
    }
  if (!b.cursors.size && !b.listeners.size) boards.delete(pageId);
}

// A cursor position in board coordinates, or null when the pointer left.
export function moveCursor(
  pageId: string,
  user: { id: string; name: string },
  point: { x: number; y: number; laser?: boolean; view?: BoardView } | null,
) {
  const b = board(pageId);
  if (!point) {
    if (b.cursors.delete(user.id))
      broadcast(b, { type: "leave", userId: user.id }, user.id);
  } else {
    const cursor = {
      userId: user.id,
      name: user.name,
      x: Math.round(point.x),
      y: Math.round(point.y),
      at: Date.now(),
      ...(point.laser ? { laser: true } : {}),
      ...(point.view
        ? {
            view: {
              x: Math.round(point.view.x),
              y: Math.round(point.view.y),
              w: Math.round(point.view.w),
              h: Math.round(point.view.h),
            },
          }
        : {}),
    };
    b.cursors.set(user.id, cursor);
    broadcast(b, { type: "cursor", ...cursor }, user.id);
  }
  sweep(pageId, b);
}

export function boardCursors(pageId: string, exceptUser: string) {
  const b = boards.get(pageId);
  if (!b) return [];
  sweep(pageId, b);
  return [...b.cursors.values()].filter((c) => c.userId !== exceptUser);
}

// Registers a viewer; returns the function that removes it again.
export function watchBoard(
  pageId: string,
  userId: string,
  send: (event: string) => void,
) {
  const b = board(pageId);
  const listener = { userId, send };
  b.listeners.add(listener);
  send(`data: ${JSON.stringify({ type: "snapshot", cursors: boardCursors(pageId, userId) })}\n\n`);
  return () => {
    b.listeners.delete(listener);
    // The last tab of this person closed: their cursor goes too.
    if (![...b.listeners].some((l) => l.userId === userId) && b.cursors.delete(userId))
      broadcast(b, { type: "leave", userId });
    sweep(pageId, b);
  };
}
