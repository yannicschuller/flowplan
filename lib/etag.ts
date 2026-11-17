// Conditional answers for what the app asks again and again (the 10 s
// refresh of bootstrap and the open page, components/workspace-app.tsx):
// the JSON with a weak ETag of its content, and 304 without a body when
// the browser already has exactly that. The answer is built as before –
// presence, visits and badges stay as they were – only the bytes and the
// browser's work on an unchanged answer go away.
//
// Not from version counters: bootstrap alone reads some forty sources
// (pages, grants, members, settings, notifications, due tasks that change
// with the clock), and a counter missing one of them would keep a stale
// sidebar on every instance of a cluster.
import { createHash } from "node:crypto";

export function contentTag(body: string) {
  return `W/"${createHash("sha256").update(body).digest("base64url").slice(0, 32)}"`;
}
// Whether an If-None-Match header names this tag (a list, or "*").
export function tagMatches(header: string | null, tag: string) {
  if (!header) return false;
  return header
    .split(",")
    .map((t) => t.trim())
    .some((t) => t === "*" || t === tag || t.replace(/^W\//, "") === tag.replace(/^W\//, ""));
}
export function jsonWithTag(req: Request, data: unknown, init: { headers?: Record<string, string> } = {}) {
  const body = JSON.stringify(data);
  const tag = contentTag(body);
  const headers = new Headers({ "Cache-Control": "no-store", ...init.headers, ETag: tag });
  if (tagMatches(req.headers.get("if-none-match"), tag)) return new Response(null, { status: 304, headers });
  headers.set("Content-Type", "application/json");
  return new Response(body, { status: 200, headers });
}
