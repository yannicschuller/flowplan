// The person's "Whiteboard-Fläche" (#399, lib/whiteboard-canvas-pref.ts),
// kept in users.whiteboard_canvas (NULL: never chosen, the default – the
// canvas follows the colour scheme – applies).
import { one, run } from "./db";
import { whiteboardCanvasOf, whiteboardCanvasSchema } from "./whiteboard-canvas-pref";
import type { Identity } from "./types";

export async function userWhiteboardCanvas(userId: string) {
  return whiteboardCanvasOf((await one<{ whiteboard_canvas: string | null }>("SELECT whiteboard_canvas FROM users WHERE id=?", userId))?.whiteboard_canvas);
}
export async function setUserWhiteboardCanvas(user: Identity, input: unknown) {
  const whiteboardCanvas = whiteboardCanvasSchema.parse(input);
  await run("UPDATE users SET whiteboard_canvas=? WHERE id=?", whiteboardCanvas, user.id);
  return { whiteboardCanvas };
}
