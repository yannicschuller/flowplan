// Integration secrets kept at rest sealed (lib/secret-box.ts): the signing
// secret and address of a webhook (chat webhook addresses of Slack, Discord
// or Teams are the credential themselves), and the token and secret of a
// database's Git connection. Values stored before they were sealed are read
// as they are until the one-time data step sealed-secrets-92 (schema 92,
// lib/data-steps.ts) or
// the next change seals them. No database access here.
import { createHash } from "node:crypto";
import { openSecret, sealSecret } from "./secret-box";

const PREFIX = "fps1:";
export const isSealed = (value: unknown): value is string => typeof value === "string" && value.startsWith(PREFIX);
// The plain value; an unsealed value from before is returned unchanged.
// Throws when a sealed value does not open here (another key, another row).
export const openStored = (value: string, aad: string) => (isSealed(value) ? openSecret(value, aad) : value);

export const webhookUrlAad = (hookId: string) => `webhook-url:${hookId}`;
export const webhookSecretAad = (hookId: string) => `webhook-secret:${hookId}`;
const gitAad = (pageId: string) => `database-git:${pageId}`;

export const sealWebhookUrl = (hookId: string, url: string) => sealSecret(url, webhookUrlAad(hookId));
export const sealWebhookSecret = (hookId: string, secret: string) => sealSecret(secret, webhookSecretAad(hookId));
export const openWebhookUrl = (hook: { id: string; url: string }) => openStored(hook.url, webhookUrlAad(hook.id));
export const openWebhookSecret = (hook: { id: string; secret: string }) => openStored(hook.secret, webhookSecretAad(hook.id));

// Git connection of a database (databases.settings.git). Sealed: token and
// secret empty, both in `sealed`; `tokenHash` finds the database for the
// address /api/git/<token> without the token being stored.
export type StoredGit = { token: string; secret: string; createdAt: string; sealed?: string; tokenHash?: string };
export const gitTokenHash = (token: string) => createHash("sha256").update(`flowplan-git\0${token}`).digest("hex");
export function sealGit(pageId: string, git: { token: string; secret: string; createdAt: string }): StoredGit {
  return {
    token: "",
    secret: "",
    createdAt: git.createdAt,
    sealed: sealSecret(JSON.stringify({ token: git.token, secret: git.secret }), gitAad(pageId)),
    tokenHash: gitTokenHash(git.token),
  };
}
// Token and secret of a stored connection; null when it does not open here.
export function openGit(pageId: string, git: StoredGit | undefined) {
  if (!git) return null;
  if (!git.sealed) return git.token && git.secret ? { token: git.token, secret: git.secret, createdAt: git.createdAt } : null;
  try {
    const plain = JSON.parse(openSecret(git.sealed, gitAad(pageId))) as { token?: unknown; secret?: unknown };
    if (typeof plain.token !== "string" || typeof plain.secret !== "string") return null;
    return { token: plain.token, secret: plain.secret, createdAt: git.createdAt };
  } catch {
    return null;
  }
}

// Schema 92: seals the values stored in plain text before, once
// (data_migrations). A value that cannot be sealed now (no key can be
// written) stays readable and is sealed at the next start. The step
// itself: lib/data-steps.ts.
export const SEALED_SECRETS_MIGRATION = "sealed-secrets-92";

// Workflows (#168, docs/specs/workflows.md §9.5): the credentials of HTTP
// nodes and the token and signing secret of inbound workflow webhooks,
// each sealed to its own row. A webhook's token is found by its hash.
export const workflowCredentialAad = (credentialId: string) => `workflow-credential:${credentialId}`;
export const workflowHookAad = (hookId: string) => `workflow-hook:${hookId}`;
export const workflowHookTokenHash = (token: string) => createHash("sha256").update(`flowplan-workflow-hook\0${token}`).digest("hex");
export const sealWorkflowCredential = (credentialId: string, secret: Record<string, string>) => sealSecret(JSON.stringify(secret), workflowCredentialAad(credentialId));
export function openWorkflowCredential(row: { id: string; sealed: string }): Record<string, string> | null {
  try {
    return JSON.parse(openSecret(row.sealed, workflowCredentialAad(row.id))) as Record<string, string>;
  } catch {
    return null;
  }
}
export const sealWorkflowHook = (hookId: string, value: { token: string; secret: string }) => sealSecret(JSON.stringify(value), workflowHookAad(hookId));
export function openWorkflowHook(row: { id: string; sealed: string }): { token: string; secret: string } | null {
  try {
    const v = JSON.parse(openSecret(row.sealed, workflowHookAad(row.id))) as { token?: unknown; secret?: unknown };
    return typeof v.token === "string" && typeof v.secret === "string" ? { token: v.token, secret: v.secret } : null;
  } catch {
    return null;
  }
}
