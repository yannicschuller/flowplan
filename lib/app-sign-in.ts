// "Mit Passkey anmelden", "Mit SSO anmelden" and "Im Browser anmelden" on the
// sign-in page inside the iPhone, iPad and Android app (#109). The app opens
// the sign-in in the system's sheet (lib/desktop-sign-in.ts):
//
// - "bridge": newer apps offer window.FlowplanApp.signIn and answer with the
//   event "flowplan:sign-in" ({ status: "opened" } or { status: "failed",
//   stage, error }) – no navigation the app has to catch;
// - "link": older apps (and the desktop app) catch the link to
//   /api/auth/desktop, which stays the href of the buttons.
//
// In the Android app a tap the app ignores used to do nothing at all. There,
// when neither an answer comes nor the page leaves the screen (the Custom Tab
// covers it) within a few seconds, the page says so and reports it to the
// instance's log (POST /api/auth/app-sign-in-report). Not on iOS: its sign-in
// sheet does not hide the page, and the app answers only once it closes.
import { nativeApp } from "./native-app";

export type AppSignInVia = "sso" | null;
export type AppSignInFailure = { reason: "no-answer" } | { reason: "failed"; stage: string; error: string };

export const APP_SIGN_IN_WAIT_MS = 6000;

export function appSignInAction(
  app: { signIn?: unknown } | undefined = nativeApp(),
  agent: string = typeof navigator === "undefined" ? "" : navigator.userAgent,
): "bridge" | "link" | null {
  if (app && typeof app.signIn === "function") return "bridge";
  return /Flowplan(Desktop|Mobile)\//.test(agent) ? "link" : null;
}

// Only the Android app's sign-in covers the page (a Custom Tab or the browser).
export const watchesAppSignIn = (agent: string) => /\bFlowplanMobile\//.test(agent) && /\bAndroid\b/.test(agent);

export function appVersionOf(agent: string) {
  return /\bFlowplanMobile\/([\w.-]{1,20})/.exec(agent)?.[1] || "";
}

type Env = {
  app?: { signIn?: (via: AppSignInVia) => void } | undefined;
  agent: string;
  target: Pick<Window, "addEventListener" | "removeEventListener">;
  visible: () => boolean;
  setTimer: (run: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
  report: (body: Record<string, string>) => void;
};

const browserEnv = (): Env => ({
  app: nativeApp() as Env["app"],
  agent: navigator.userAgent,
  target: window,
  visible: () => document.visibilityState === "visible",
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  report: (body) =>
    void fetch("/api/auth/app-sign-in-report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => {}),
});

// Starts the hand-off. "bridge": the caller prevents the link's navigation;
// "link": it lets the link go. done() comes once: true when the sign-in
// opened (or the page left the screen), else with the failure – also
// reported to the instance's log and the console.
export function startAppSignIn(
  via: AppSignInVia,
  done: (failure: AppSignInFailure | null) => void,
  env: Env = browserEnv(),
): "bridge" | "link" {
  let how: "bridge" | "link" = appSignInAction(env.app, env.agent) === "bridge" ? "bridge" : "link";
  let finished = false,
    timer: unknown = null;
  const finish = (failure: AppSignInFailure | null) => {
    if (finished) return;
    finished = true;
    if (timer !== null) env.clearTimer(timer);
    env.target.removeEventListener("flowplan:sign-in", answer);
    env.target.removeEventListener("visibilitychange", left);
    env.target.removeEventListener("pagehide", left);
    if (failure) {
      const detail = failure.reason === "failed" ? `${failure.stage}: ${failure.error}` : "no answer";
      console.warn(`Flowplan app sign-in (${how}${via ? `, ${via}` : ""}) failed: ${detail}`);
      env.report({
        via: via || "passkey",
        how,
        reason: failure.reason,
        detail: failure.reason === "failed" ? detail.slice(0, 300) : "",
        app: appVersionOf(env.agent),
        platform: /\bAndroid\b/.test(env.agent) ? "android" : /iPhone|iPad|Macintosh/.test(env.agent) ? "ios" : "other",
      });
    }
    done(failure);
  };
  const answer = (event: Event) => {
    const detail = (event as CustomEvent).detail as { status?: unknown; stage?: unknown; error?: unknown } | null;
    if (detail?.status === "opened") finish(null);
    else if (detail?.status === "failed")
      finish({ reason: "failed", stage: String(detail.stage || "").slice(0, 60), error: String(detail.error || "").slice(0, 240) });
  };
  const left = () => {
    if (!env.visible()) finish(null);
  };
  env.target.addEventListener("flowplan:sign-in", answer);
  env.target.addEventListener("visibilitychange", left);
  env.target.addEventListener("pagehide", left);
  if (watchesAppSignIn(env.agent)) timer = env.setTimer(() => finish(env.visible() ? { reason: "no-answer" } : null), APP_SIGN_IN_WAIT_MS);
  // Without a watch (iOS, the desktop app) the spinner goes after a while.
  else timer = env.setTimer(() => finish(null), APP_SIGN_IN_WAIT_MS);
  if (how === "bridge") {
    try {
      env.app!.signIn!(via);
    } catch (e) {
      // The link still goes; the watch stays.
      console.warn("Flowplan app sign-in: the bridge failed, the link goes instead", e);
      how = "link";
    }
  }
  return how;
}
