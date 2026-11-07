// Integration secrets kept at rest sealed (lib/secret-box.ts): the signing
// secret and address of a webhook (chat webhook addresses of Slack, Discord
// or Teams are the credential themselves), and the token and secret of a
// database's Git connection. Values stored before they were sealed are read
// as they are until the one-time step migrateSealedSecrets (schema 92) or
// the next change seals them. No database access here: lib/db.ts runs the
// migration with its own connection.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
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
// written) stays readable and is sealed at the next start.
export const SEALED_SECRETS_MIGRATION = "sealed-secrets-92";
export function migrateSealedSecrets(d: DatabaseSync) {
  d.exec("CREATE TABLE IF NOT EXISTS data_migrations(name TEXT PRIMARY KEY,at INTEGER NOT NULL)");
  if (d.prepare("SELECT 1 FROM data_migrations WHERE name=?").get(SEALED_SECRETS_MIGRATION)) return;
  d.exec("SAVEPOINT sealed_secrets");
  try {
    const hooks = d.prepare("SELECT id,url,secret FROM webhooks").all() as { id: string; url: string; secret: string }[];
    const updateHook = d.prepare("UPDATE webhooks SET url=?,secret=? WHERE id=?");
    for (const hook of hooks)
      if (!isSealed(hook.url) || !isSealed(hook.secret))
        updateHook.run(
          isSealed(hook.url) ? hook.url : sealWebhookUrl(hook.id, hook.url),
          isSealed(hook.secret) ? hook.secret : sealWebhookSecret(hook.id, hook.secret),
          hook.id,
        );
    const databases = d.prepare(`SELECT page_id,settings FROM databases WHERE settings LIKE '%"git"%'`).all() as { page_id: string; settings: string }[];
    const updateSettings = d.prepare("UPDATE databases SET settings=? WHERE page_id=?");
    for (const row of databases) {
      let settings: { git?: StoredGit } & Record<string, unknown>;
      try {
        settings = JSON.parse(row.settings || "{}");
      } catch {
        continue;
      }
      const git = settings.git;
      if (!git || git.sealed || !git.token || !git.secret) continue;
      updateSettings.run(JSON.stringify({ ...settings, git: sealGit(row.page_id, git) }), row.page_id);
    }
    d.prepare("INSERT INTO data_migrations(name,at) VALUES(?,?)").run(SEALED_SECRETS_MIGRATION, Date.now());
    d.exec("RELEASE sealed_secrets");
  } catch (error) {
    d.exec("ROLLBACK TO sealed_secrets");
    d.exec("RELEASE sealed_secrets");
    console.error("Gespeicherte Geheimnisse konnten nicht versiegelt werden", error);
  }
}
