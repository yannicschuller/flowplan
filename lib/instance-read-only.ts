// The read-only state of an instance that is moving (lib/instance-move.ts):
// after "Quelle schreibschützen und letzten Stand holen" every change is
// refused with a clear message, and after the move the instance points to
// its new address. Reads keep working, and so do signing in and out.
// Read from the database on every check: route handlers and pages run as
// separate module instances, so an in-memory flag would go stale.
import { one } from "./db";

export const MOVE_KEY = "instanceMove";
export const INCOMING_KEY = "instanceMoveIncoming";
export type ReadOnlyState = { readOnly: boolean; movedTo: string | null; redirect: boolean };

export function readOnlyState(): ReadOnlyState {
  try {
    const row = one<{ value: string }>("SELECT value FROM instance_settings WHERE key=?", MOVE_KEY);
    if (!row) return { readOnly: false, movedTo: null, redirect: false };
    const state = JSON.parse(row.value) as { readOnlyAt?: number | null; movedTo?: string | null; redirect?: boolean };
    return { readOnly: !!state.readOnlyAt || !!state.movedTo, movedTo: state.movedTo || null, redirect: !!state.movedTo && !!state.redirect };
  } catch {
    return { readOnly: false, movedTo: null, redirect: false };
  }
}

// Requests that still work while the instance is read-only: signing in and
// out, the move itself, and reads that are sent with a body.
const ALLOWED = [
  /^\/api\/auth\/(login|logout|callback|passkey|passkey-options|password|totp-login|totp-after-passkey|totp-recovery|desktop|desktop-redeem|no-script)$/,
  /^\/api\/admin\/instance-move$/,
  /^\/api\/move\//,
  /^\/api\/(home\/data|presence|activity|capture\/preview|clip)$/,
  /^\/api\/whiteboards\/[^/]+\/cursor$/,
];
export const readOnlyMessage = (movedTo: string | null) =>
  movedTo
    ? `Diese Instanz ist umgezogen nach ${movedTo}. Änderungen sind nur noch dort möglich.`
    : "Diese Instanz ist wegen eines Umzugs schreibgeschützt. Änderungen sind erst auf der neuen Instanz wieder möglich.";
// The refusal for a change at `path`, or null when it may go through.
export function readOnlyRefusal(path: string): string | null {
  const state = readOnlyState();
  if (!state.readOnly) return null;
  if (ALLOWED.some((pattern) => pattern.test(path))) return null;
  return readOnlyMessage(state.movedTo);
}
