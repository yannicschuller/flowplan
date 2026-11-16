// The revision of a page's document as clients that write without an
// editor see it (the MCP server, lib/mcp.ts): it changes with every stored
// change of the text – also one a collaborator saved from the editor – and
// with the title and icon, so a write based on an older read can be refused
// instead of silently replacing newer work.
import { createHash } from "node:crypto";

export type RevisionSource = {
  generation: string;
  state: Uint8Array | null;
  html: string;
  title?: string | null;
  icon?: string | null;
};

export function documentRevision(doc: RevisionSource) {
  const hash = createHash("sha256");
  hash.update(`${doc.generation}\u0000${doc.title ?? ""}\u0000${doc.icon ?? ""}\u0000`);
  // The stored Yjs state holds deletions too (its state vector does not).
  if (doc.state) hash.update(doc.state);
  else hash.update(`html\u0000${doc.html}`);
  return hash.digest("base64url").slice(0, 16);
}
