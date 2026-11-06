import { test } from "node:test";
import assert from "node:assert/strict";
import { APP_SIGN_IN_WAIT_MS, appSignInAction, appVersionOf, startAppSignIn, watchesAppSignIn, type AppSignInFailure } from "../lib/app-sign-in";
import { appSignInReportLine, resetAppSignInReports } from "../lib/app-sign-in-report";

// #109: "Mit SSO anmelden" in the Android app did nothing at all.
const android = "Mozilla/5.0 (Linux; Android 15; SM-X710 Build/AP3A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0 Safari/537.36 FlowplanMobile/1.0.5";
const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 FlowplanMobile/1.0.5";
const desktop = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Electron/38.0 Safari/537.36 FlowplanDesktop/1.1.0";

function fakeEnv(agent: string, app?: { signIn?: (via: "sso" | null) => void }) {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const timers: { run: () => void; ms: number; cleared: boolean }[] = [];
  const reports: Record<string, string>[] = [];
  let visible = true;
  const env = {
    app,
    agent,
    target: {
      addEventListener: (type: string, fn: (event: Event) => void) => void (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn),
      removeEventListener: (type: string, fn: (event: Event) => void) => void listeners.get(type)?.delete(fn),
    } as unknown as Pick<Window, "addEventListener" | "removeEventListener">,
    visible: () => visible,
    setTimer: (run: () => void, ms: number) => timers.push({ run, ms, cleared: false }) - 1,
    clearTimer: (index: unknown) => void (timers[index as number].cleared = true),
    report: (body: Record<string, string>) => void reports.push(body),
  };
  const fire = (type: string, detail?: unknown) => {
    for (const fn of [...(listeners.get(type) ?? [])]) fn({ type, detail } as unknown as Event);
  };
  return {
    env,
    fire,
    reports,
    listeners,
    elapse: () => timers.filter((t) => !t.cleared).forEach((t) => ((t.cleared = true), t.run())),
    hide: () => {
      visible = false;
      fire("visibilitychange");
    },
  };
}

const quiet = <T>(run: () => T) => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return run();
  } finally {
    console.warn = warn;
  }
};

test("which way the app's sign-in goes", () => {
  assert.equal(appSignInAction({ signIn: () => {} }, android), "bridge");
  assert.equal(appSignInAction({}, android), "link", "app 1.0.5: the link the app catches");
  assert.equal(appSignInAction(undefined, desktop), "link");
  assert.equal(appSignInAction(undefined, "Mozilla/5.0 Chrome/140"), null);
  assert.equal(watchesAppSignIn(android), true);
  assert.equal(watchesAppSignIn(iphone), false, "iOS's sheet does not hide the page");
  assert.equal(watchesAppSignIn(desktop), false);
  assert.equal(appVersionOf(android), "1.0.5");
});

test("bridge: the app is asked directly, and its answer ends the wait", () => {
  const calls: unknown[] = [];
  const { env, fire, reports, listeners } = fakeEnv(android, { signIn: (via) => void calls.push(via) });
  const results: (AppSignInFailure | null)[] = [];
  assert.equal(startAppSignIn("sso", (f) => results.push(f), env), "bridge");
  assert.deepEqual(calls, ["sso"]);
  fire("flowplan:sign-in", { status: "opened" });
  assert.deepEqual(results, [null]);
  assert.equal(reports.length, 0);
  assert.equal([...listeners.values()].reduce((n, set) => n + set.size, 0), 0, "listeners are gone");
});

test("bridge: a failure the app reports is shown and logged", () => {
  const { env, fire, reports } = fakeEnv(android, { signIn: () => {} });
  const results: (AppSignInFailure | null)[] = [];
  startAppSignIn(null, (f) => results.push(f), env);
  quiet(() => fire("flowplan:sign-in", { status: "failed", stage: "bridge/challenge", error: "ExpoCrypto unavailable" }));
  assert.deepEqual(results, [{ reason: "failed", stage: "bridge/challenge", error: "ExpoCrypto unavailable" }]);
  assert.deepEqual(reports, [
    { via: "passkey", how: "bridge", reason: "failed", detail: "bridge/challenge: ExpoCrypto unavailable", app: "1.0.5", platform: "android" },
  ]);
});

test("bridge that throws: the link goes instead", () => {
  const { env } = fakeEnv(android, {
    signIn: () => {
      throw new Error("gone");
    },
  });
  assert.equal(quiet(() => startAppSignIn("sso", () => {}, env)), "link");
});

test("Android app 1.0.5 (link): no answer and the page still showing – said and reported", () => {
  const { env, reports, elapse } = fakeEnv(android, {});
  const results: (AppSignInFailure | null)[] = [];
  assert.equal(startAppSignIn("sso", (f) => results.push(f), env), "link");
  quiet(elapse);
  assert.deepEqual(results, [{ reason: "no-answer" }]);
  assert.equal(reports[0].reason, "no-answer");
  assert.equal(reports[0].how, "link");
});

test("Android: the Custom Tab covering the page counts as opened", () => {
  const { env, reports, hide, elapse } = fakeEnv(android, {});
  const results: (AppSignInFailure | null)[] = [];
  startAppSignIn("sso", (f) => results.push(f), env);
  hide();
  elapse();
  assert.deepEqual(results, [null]);
  assert.equal(reports.length, 0);
});

test("iOS and the desktop app: no false alarm, the spinner just goes", () => {
  for (const agent of [iphone, desktop]) {
    const { env, reports, elapse } = fakeEnv(agent, agent === iphone ? {} : undefined);
    const results: (AppSignInFailure | null)[] = [];
    startAppSignIn("sso", (f) => results.push(f), env);
    elapse();
    assert.deepEqual(results, [null], agent);
    assert.equal(reports.length, 0);
  }
  assert.ok(APP_SIGN_IN_WAIT_MS >= 3000);
});

test("the instance's log line: cleaned, cut and limited", () => {
  resetAppSignInReports();
  const line = appSignInReportLine({ via: "sso", how: "link", reason: "no-answer", app: "1.0.5", platform: "android" }, 1);
  assert.equal(line, "App sign-in (sso, android app 1.0.5, through the link) failed: the app did not answer (nothing opened)");
  const failed = appSignInReportLine({ via: "passkey", how: "bridge", reason: "failed", detail: "open: no tab\n[fake] admin signed in" + "x".repeat(500), platform: "android" }, 2)!;
  assert.ok(!failed.includes("\n"), "no forged log lines");
  assert.ok(failed.length < 420);
  assert.equal(appSignInReportLine({ via: "evil", how: "link", reason: "no-answer" }, 3), null);
  assert.equal(appSignInReportLine("nonsense", 3), null);
  resetAppSignInReports();
  let written = 0;
  for (let i = 0; i < 50; i++) if (appSignInReportLine({ via: "sso", how: "link", reason: "no-answer" }, 10)) written++;
  assert.equal(written, 20);
  assert.ok(appSignInReportLine({ via: "sso", how: "link", reason: "no-answer" }, 10 + 10 * 60_000), "a new window later");
  resetAppSignInReports();
});
