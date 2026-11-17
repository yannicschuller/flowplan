// The record view's surroundings in one request (lib/record-context.ts):
// the backlinks, unlinked mentions, related pages, linked issue and
// customer conversation of a record each take their part of one answer
// instead of asking their own endpoint. A part the answer lacks (it failed,
// or an older server) comes from the part's own endpoint as before.
import type { RecordContext, RecordContextPart } from "./record-context";

// One answer per record for a short while: the parts mount together.
const FRESH_MS = 3_000;
const answers = new Map<string, { at: number; answer: Promise<RecordContext | null> }>();

function contextOf(pageId: string, rowId: string, load: (url: string) => Promise<Response>) {
  const key = `${pageId}:${rowId}`;
  const now = Date.now();
  const hit = answers.get(key);
  if (hit && now - hit.at < FRESH_MS) return hit.answer;
  const answer = load(`/api/pages/${pageId}/rows/${rowId}/context`)
    .then((r) => (r.ok ? (r.json() as Promise<RecordContext>) : null))
    .catch(() => null);
  answers.set(key, { at: now, answer });
  for (const [k, v] of answers) if (now - v.at > FRESH_MS) answers.delete(k);
  return answer;
}

export async function recordPart<T>(
  pageId: string,
  rowId: string,
  part: RecordContextPart,
  own: () => Promise<T>,
  load: (url: string) => Promise<Response> = (url) => fetch(url, { cache: "no-store" }),
): Promise<T> {
  const answer = await contextOf(pageId, rowId, load);
  if (answer && part in answer && !answer.failed?.includes(part)) return answer[part] as T;
  return await own();
}
// After a change the next read asks again (linking a mention, a reply).
export function forgetRecordContext(pageId: string, rowId: string) {
  answers.delete(`${pageId}:${rowId}`);
}
