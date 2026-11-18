// "Passkey hinzufügen" inside the iPhone, iPad and Android app. Its web view
// offers WebAuthn only for domains built into the app, never for a
// self-hosted instance, so the passkey is made in the system's sign-in sheet
// (ASWebAuthenticationSession, a Custom Tab) – like signing in with one
// (lib/desktop-sign-in.ts):
//
// 1. Settings → Konto → Passkeys asks for a link (POST
//    /api/auth/passkey-app-link): a one-time token for the signed-in account,
//    valid five minutes, good for one passkey ceremony and nothing else
//    (lib/local-auth.ts issueAppPasskeyToken).
// 2. The page hands it to the app (FlowplanApp.addPasskey); the app adds its
//    callback (return=flowplan://passkey?state=…) and opens the sheet.
// 3. /passkey-add exchanges the token for the ceremony (passkey-app-options),
//    the browser creates the passkey, passkey-app-register stores it, and the
//    page goes back to the callback with status=added (or cancelled, failed).
// 4. The app tells the page (the event "flowplan:passkey"), which reloads
//    the list.
//
// Client-safe: no database here.

// The only callback the page goes back to: the app's own scheme, its host
// "passkey" and the app's random state – nothing a link from elsewhere could
// turn into a redirect to a site.
const RETURN = /^flowplan:\/\/passkey\?state=([A-Za-z0-9_-]{16,128})$/;
export const isAppPasskeyReturn = (value: unknown): value is string => typeof value === "string" && value.length <= 200 && RETURN.test(value);

export type AppPasskeyStatus = "added" | "cancelled" | "failed";
export function appPasskeyCallback(returnTo: string, status: AppPasskeyStatus) {
  if (!isAppPasskeyReturn(returnTo)) throw new Error("invalid return address");
  return `${returnTo}&status=${status}`;
}

// The shape of the tokens issueToken makes (32 random bytes, base64url).
export const isAppPasskeyToken = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);

// The path the link points to (the app accepts only this one of its instance).
export const APP_PASSKEY_PATH = "/passkey-add";
export const appPasskeyLink = (origin: string, token: string) => `${origin.replace(/\/$/, "")}${APP_PASSKEY_PATH}?token=${encodeURIComponent(token)}`;

// The name a new passkey gets: "Passkey · iPhone". The most telling name
// first (Android's agent names Linux, the iPhone's Mac OS X too); iPadOS'
// Safari names itself a Mac, a touch screen tells it apart.
export function passkeyName(agent: string, touchPoints = 0) {
  let device = ["iPhone", "iPad", "Android", "Mac", "Windows", "Linux"].find((name) => agent.includes(name)) || "";
  if (device === "Mac" && touchPoints > 1) device = "iPad";
  return device ? `Passkey · ${device}` : "Passkey";
}

// What "Passkey hinzufügen" does in the app: "sheet" – the app opens the
// sign-in sheet (FlowplanApp.addPasskey, newer apps); otherwise the way of
// older apps (lib/native-app.ts appPasskeysInBrowser).
export const appAddsPasskey = (app: { addPasskey?: unknown } | undefined) => typeof app?.addPasskey === "function";

// The app's answer (the event "flowplan:passkey"), checked.
export function appPasskeyAnswer(detail: unknown): AppPasskeyStatus | null {
  const status = detail && typeof detail === "object" ? (detail as { status?: unknown }).status : undefined;
  return status === "added" || status === "cancelled" || status === "failed" ? status : null;
}

// How long the page waits for the app's answer: the link's five minutes and
// a little more (an app that never answers frees the button again).
export const APP_PASSKEY_WAIT_MS = 6 * 60_000;
// Starts the app's sheet and waits for its answer (null: none came).
export function waitForAppPasskey(
  target: Pick<Window, "addEventListener" | "removeEventListener">,
  start: () => void,
  ms = APP_PASSKEY_WAIT_MS,
  timers: { set: (run: () => void, ms: number) => unknown; clear: (timer: unknown) => void } = {
    set: (run, ms) => setTimeout(run, ms),
    clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  },
): Promise<AppPasskeyStatus | null> {
  return new Promise((resolve, reject) => {
    let timer: unknown = null;
    const finish = (status: AppPasskeyStatus | null) => {
      target.removeEventListener("flowplan:passkey", answer);
      if (timer !== null) timers.clear(timer);
      resolve(status);
    };
    const answer = (event: Event) => {
      const status = appPasskeyAnswer((event as CustomEvent).detail);
      if (status) finish(status);
    };
    target.addEventListener("flowplan:passkey", answer);
    timer = timers.set(() => finish(null), ms);
    try {
      start();
    } catch (e) {
      target.removeEventListener("flowplan:passkey", answer);
      timers.clear(timer);
      reject(e);
    }
  });
}

// The desktop app (FlowplanDesktop.addPasskeyInBrowser) opens the link in
// the default browser – on a Mac the passkey goes to the iCloud Keychain
// there, usable in Safari and on the iPhone too – and hears nothing back.
// Its window asks the instance every few seconds (passkey-app-status: the
// link waiting, used or gone, and the account's passkeys) until a new
// passkey is there, the link is gone without one, the person cancels, or
// time runs out.
export type DesktopPasskeyPoll = { status: "waiting" | "used" | "gone"; passkeys: { id: string }[] };
export type DesktopPasskeyResult = "added" | "gone" | "cancelled" | "timeout";
export async function waitForDesktopPasskey(
  ask: () => Promise<DesktopPasskeyPoll>,
  known: ReadonlySet<string>,
  {
    intervalMs = 2000,
    limitMs = 11 * 60_000,
    cancelled = () => false,
    sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms)),
    now = () => Date.now(),
  }: { intervalMs?: number; limitMs?: number; cancelled?: () => boolean; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<DesktopPasskeyResult> {
  const start = now();
  for (;;) {
    await sleep(intervalMs);
    if (cancelled()) return "cancelled";
    const answer = await ask().catch(() => null);
    if (answer?.passkeys.some((p) => !known.has(p.id))) return "added";
    if (answer?.status === "gone") return "gone";
    if (now() - start >= limitMs) return "timeout";
  }
}
