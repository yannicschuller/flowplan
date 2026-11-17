// Whether a Yjs document holds exactly what the server sent (its state as
// base64): the same state vector and the same deletions. An editor that
// opens with nothing of its own beyond it (components/editor.tsx) needs no
// save right away.
import * as Y from "yjs";

const from64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export function sameAsServer(doc: Y.Doc, serverState: string | null | undefined) {
  if (!serverState) return false;
  const server = new Y.Doc();
  try {
    Y.applyUpdate(server, from64(serverState));
    return Y.equalSnapshots(Y.snapshot(doc), Y.snapshot(server));
  } catch {
    return false;
  } finally {
    server.destroy();
  }
}
