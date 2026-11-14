// The setup path for administrators in the introduction
// (components/onboarding-admin.tsx): a traffic light per part of the
// instance, from the facts of the administration's summary
// (lib/admin-summary.ts, GET /api/admin/summary). Each item names the
// section of the administration where it is set up. Client-safe: no
// texts here (the component words them), only the verdicts.
import type { AdminSummary } from "./admin-summary";

// green: done; yellow: optional or worth a look; red: missing or failing.
export type Light = "green" | "yellow" | "red";
export type SetupItemId = "https" | "mail" | "backup" | "signin" | "ai";
export type SetupReason =
  | "ok"
  | "https-plain"
  | "https-unset"
  | "https-local"
  | "mail-off"
  | "mail-failed"
  | "backup-off"
  | "backup-failed"
  | "backup-pending"
  | "signin-local"
  | "signin-ldap-error"
  | "ai-off"
  | "ai-no-provider";
export type SetupItem = { id: SetupItemId; light: Light; reason: SetupReason; section: string };

// The facts the verdicts need (a part of AdminSummary).
export type SetupFacts = {
  general: Pick<AdminSummary["general"], "plainHttp" | "appUrlSet" | "https">;
  mail: Pick<AdminSummary["mail"], "configured" | "failed">;
  storage: { backup: Pick<AdminSummary["storage"]["backup"], "enabled" | "lastAt" | "failed"> };
  signin: Pick<AdminSummary["signin"], "oidc" | "ldap" | "ldapError">;
  ai: Pick<AdminSummary["ai"], "enabled" | "provider">;
};

// The order is the one to work through on a fresh instance: the address
// first (links in e-mails, passkeys and apps need it), then mail, backup,
// sign-in, AI.
export function adminSetupStatus(s: SetupFacts): SetupItem[] {
  const https: SetupItem = s.general.plainHttp
    ? { id: "https", light: "red", reason: "https-plain", section: "general" }
    : !s.general.appUrlSet
      ? { id: "https", light: "yellow", reason: "https-unset", section: "general" }
      : s.general.https
        ? { id: "https", light: "green", reason: "ok", section: "general" }
        : // http on this machine only (a local test).
          { id: "https", light: "yellow", reason: "https-local", section: "general" };
  const mail: SetupItem = !s.mail.configured
    ? { id: "mail", light: "red", reason: "mail-off", section: "mail" }
    : s.mail.failed > 0
      ? { id: "mail", light: "yellow", reason: "mail-failed", section: "mail" }
      : { id: "mail", light: "green", reason: "ok", section: "mail" };
  const b = s.storage.backup;
  const backup: SetupItem = !b.enabled
    ? { id: "backup", light: "red", reason: "backup-off", section: "storage" }
    : b.failed
      ? { id: "backup", light: "red", reason: "backup-failed", section: "storage" }
      : !b.lastAt
        ? { id: "backup", light: "yellow", reason: "backup-pending", section: "storage" }
        : { id: "backup", light: "green", reason: "ok", section: "storage" };
  // Single sign-on is optional: without it the instance's own accounts sign in.
  const signin: SetupItem = s.signin.ldapError
    ? { id: "signin", light: "red", reason: "signin-ldap-error", section: "signin" }
    : s.signin.oidc || s.signin.ldap
      ? { id: "signin", light: "green", reason: "ok", section: "signin" }
      : { id: "signin", light: "yellow", reason: "signin-local", section: "signin" };
  // AI is optional too.
  const ai: SetupItem = !s.ai.enabled
    ? { id: "ai", light: "yellow", reason: "ai-off", section: "ai" }
    : !s.ai.provider
      ? { id: "ai", light: "yellow", reason: "ai-no-provider", section: "ai" }
      : { id: "ai", light: "green", reason: "ok", section: "ai" };
  return [https, mail, backup, signin, ai];
}
