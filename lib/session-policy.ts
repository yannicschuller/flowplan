// How long sessions last (#133). Administration → Anmeldung & SSO →
// Sitzungen sets it; without a stored value the environment decides, and
// without that the defaults below.
//
// - A browser session without "Stay signed in" ends sessionHours after
//   signing in (SESSION_HOURS, default 8, 1–24) – used or not.
// - "Stay signed in" (offered when sessionRemember / SESSION_REMEMBER=true):
//   the session lives on while it is used and ends rememberDays without use
//   (SESSION_IDLE_HOURS, default 7 days).
// - The desktop and mobile apps are a personal device of their own: they
//   always stay signed in (appSessions "remember", SESSION_APP_REMEMBER,
//   default on) and end appDays without use (SESSION_APP_DAYS, default 90).
//   "off" treats them like a browser without "Stay signed in".
// - A remembered session never lasts beyond SESSION_MAX_DAYS after signing
//   in (default 30 days in the browser, 365 in the apps, and never less than
//   the inactivity limit). SESSION_GROUPS_HOURS ends SSO sessions earlier, so
//   group changes at the provider take effect at the next sign-in.
import { instanceSettings, type InstanceSettings } from "./instance-settings";

export type SessionKind = "browser" | "app";

const HOUR = 3_600_000;
const bounded = (raw: string | undefined, fallback: number, min: number, max: number) => {
  const value = Number(raw);
  return Math.min(max, Math.max(min, Number.isFinite(value) && value > 0 ? value : fallback));
};

// The apps name themselves in the user agent (FlowplanMobile/…, the iOS and
// Android app's web view; FlowplanDesktop/…, the desktop app). Their sign-in
// sheets (ASWebAuthenticationSession, Custom Tab, the system browser) do not:
// those are browser sessions.
export const isAppAgent = (agent: string | null | undefined) => /\bFlowplan(Mobile|Desktop)\//.test(agent || "");

// The effective values, and where each comes from (for the administration).
export function sessionSettings(settings: InstanceSettings = instanceSettings()) {
  const env = process.env;
  const maxDays = env.SESSION_MAX_DAYS ? bounded(env.SESSION_MAX_DAYS, 30, 1, 365) : null;
  return {
    hours: settings.sessionHours ?? bounded(env.SESSION_HOURS, 8, 1, 24),
    browserRemember: settings.sessionRemember ?? env.SESSION_REMEMBER === "true",
    rememberIdleHours: settings.rememberDays ? settings.rememberDays * 24 : bounded(env.SESSION_IDLE_HOURS, 168, 1, 24 * 365),
    appRemember: (settings.appSessions ?? (env.SESSION_APP_REMEMBER === "false" ? "off" : "remember")) === "remember",
    appIdleHours: (settings.appDays ?? bounded(env.SESSION_APP_DAYS, 90, 1, 365)) * 24,
    browserMaxHours: (maxDays ?? 30) * 24,
    appMaxHours: (maxDays ?? 365) * 24,
    groupsHours: env.SESSION_GROUPS_HOURS ? bounded(env.SESSION_GROUPS_HOURS, 168, 1, 24 * 365) : null,
    // What the environment would give (shown as "Standard" in the form).
    env: {
      hours: bounded(env.SESSION_HOURS, 8, 1, 24),
      browserRemember: env.SESSION_REMEMBER === "true",
      rememberDays: Math.round(bounded(env.SESSION_IDLE_HOURS, 168, 1, 24 * 365) / 24) || 1,
      appRemember: env.SESSION_APP_REMEMBER !== "false",
      appDays: bounded(env.SESSION_APP_DAYS, 90, 1, 365),
    },
  };
}

export const sessionHours = () => sessionSettings().hours;

// How a remembered session of this kind lives: the inactivity limit and its
// latest end after signing in. null: sessions of this kind are not
// remembered on this instance.
export function rememberPolicy(kind: SessionKind = "browser") {
  const s = sessionSettings();
  if (kind === "app" ? !s.appRemember : !s.browserRemember) return null;
  const idleHours = kind === "app" ? s.appIdleHours : s.rememberIdleHours;
  // Never shorter than the inactivity limit the administration chose.
  const maxHours = Math.max(kind === "app" ? s.appMaxHours : s.browserMaxHours, idleHours);
  return { idleHours, maxHours, groupsHours: s.groupsHours ? Math.min(maxHours, s.groupsHours) : null };
}
export type RememberPolicy = NonNullable<ReturnType<typeof rememberPolicy>>;

// The latest end of a remembered session, from when it began.
export function rememberedEnd(created: number, sso: boolean, policy: RememberPolicy) {
  return created + (sso && policy.groupsHours ? policy.groupsHours : policy.maxHours) * HOUR;
}

// A new session: when it ends, whether it slides, whether it is an app's,
// and how long its cookie lasts (a remembered one until its latest possible
// end; the server decides earlier whether it is still alive). The apps stay
// signed in whichever way they signed in – the password form in the app, or
// the browser hand-off with a passkey or SSO; a browser only with "Stay
// signed in", for password, passkey and SSO alike.
export function sessionTerms(input: { agent: string; remember?: boolean; sso?: boolean }, now = Date.now()) {
  const app = isAppAgent(input.agent);
  const policy = app ? rememberPolicy("app") : input.remember ? rememberPolicy("browser") : null;
  if (!policy) {
    const hours = sessionHours();
    return { app, remember: false, expires: now + hours * HOUR, maxAge: hours * 3600 };
  }
  const end = rememberedEnd(now, !!input.sso, policy);
  return { app, remember: true, expires: Math.min(now + policy.idleHours * HOUR, end), maxAge: Math.round((end - now) / 1000) };
}
