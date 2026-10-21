// What visitors without an account may add per day: through a public form,
// through an editing share link (uploads and live edits). Workspace quotas
// are unlimited by default and personal storage limits need an account, so
// these budgets stand on their own – per form or link and for the whole
// instance. Counted in SQLite, so a restart does not reset them; counting
// happens inside the caller's transaction, so a refused write counts nothing.
import { HttpError } from "./auth";
import { one, run } from "./db";

const DAY = 86_400_000;
const MB = 1024 * 1024;
// Per form or link and day: files of anonymous form answers and guest
// uploads, and the live changes guests send.
export const ANONYMOUS_UPLOAD_MB = 200;
export const GUEST_LIVE_MB = 100;
// For the whole instance and day; FLOWPLAN_ANONYMOUS_UPLOAD_MB changes it
// (0 = unlimited).
export function anonymousInstanceMb() {
  const raw = process.env.FLOWPLAN_ANONYMOUS_UPLOAD_MB;
  if (raw === undefined || raw === "") return 1024;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 1024;
}
const INSTANCE_SCOPE = "*";

export function anonymousBytesToday(scope: string, now = Date.now()) {
  return Number(
    one<{ n: number | null }>("SELECT SUM(bytes) n FROM anonymous_uploads WHERE scope=? AND at>?", scope, now - DAY)?.n || 0,
  );
}
// Refuses the write when `bytes` more would exceed the day's budget of the
// scope (`limitMb`) or of the instance; otherwise counts them.
export function takeAnonymousBudget(scope: string, bytes: number, limitMb = ANONYMOUS_UPLOAD_MB, now = Date.now()) {
  if (bytes <= 0) return;
  run("DELETE FROM anonymous_uploads WHERE at<?", now - DAY);
  if (anonymousBytesToday(scope, now) + bytes > limitMb * MB)
    throw new HttpError(413, "Das Tageslimit für diesen Link ist erreicht. Bitte morgen erneut versuchen.");
  const instance = anonymousInstanceMb();
  if (instance && anonymousBytesToday(INSTANCE_SCOPE, now) + bytes > instance * MB)
    throw new HttpError(413, "Diese Instanz nimmt heute keine weiteren anonymen Uploads an.");
  run("INSERT INTO anonymous_uploads(scope,bytes,at) VALUES(?,?,?)", scope, bytes, now);
  run("INSERT INTO anonymous_uploads(scope,bytes,at) VALUES(?,?,?)", INSTANCE_SCOPE, bytes, now);
}
