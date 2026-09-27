// Personal API tokens for scripts, n8n or Home Assistant. A request with
// "Authorization: Bearer fp_…" acts as the person who created the token,
// with their rights; read tokens only answer GET requests. Only a hash is
// stored, the token is shown once.
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { all, id, one, run } from "./db";
import { HttpError } from "./auth";
import type { Identity, User } from "./types";

export type ApiScope = "read" | "write";
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const MAX_TOKENS = 20;

export function createApiToken(user: Identity, input: unknown) {
  if (user.demo) throw new HttpError(403, "In der Demo nicht verfügbar.");
  if (user.apiScope) throw new HttpError(403, "API-Tokens können keine weiteren Tokens anlegen.");
  const b = z
    .object({
      name: z.string().trim().min(1).max(80),
      scope: z.enum(["read", "write"]),
      days: z.number().int().min(1).max(3650).nullable().optional(),
    })
    .parse(input);
  const count = Number(one<{ n: number }>("SELECT COUNT(*) n FROM api_tokens WHERE user_id=?", user.id)?.n || 0);
  if (count >= MAX_TOKENS) throw new HttpError(409, `Höchstens ${MAX_TOKENS} Tokens pro Person.`);
  const token = `fp_${randomBytes(30).toString("base64url")}`;
  const tokenId = id();
  run(
    "INSERT INTO api_tokens(id,user_id,name,scope,token_hash,prefix,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)",
    tokenId,
    user.id,
    b.name,
    b.scope,
    hashToken(token),
    token.slice(0, 10),
    Date.now(),
    b.days ? Date.now() + b.days * 86400_000 : null,
  );
  return { id: tokenId, token };
}

export function listApiTokens(user: Identity) {
  return all<{
    id: string;
    name: string;
    scope: ApiScope;
    prefix: string;
    created_at: number;
    last_used_at: number | null;
    expires_at: number | null;
  }>(
    "SELECT id,name,scope,prefix,created_at,last_used_at,expires_at FROM api_tokens WHERE user_id=? ORDER BY created_at DESC",
    user.id,
  );
}

export function revokeApiToken(user: Identity, tokenId: unknown) {
  if (user.apiScope) throw new HttpError(403, "API-Tokens können keine Tokens widerrufen.");
  run("DELETE FROM api_tokens WHERE id=? AND user_id=?", z.string().parse(tokenId), user.id);
}

// The identity behind a bearer token, or null.
export function identityFromApiToken(header: string | null): Identity | null {
  const match = header?.match(/^Bearer\s+(fp_[A-Za-z0-9_-]{20,80})$/);
  if (!match) return null;
  const row = one<User & { token_id: string; scope: ApiScope; last_used_at: number | null }>(
    `SELECT u.*,t.id token_id,t.scope,t.last_used_at FROM api_tokens t JOIN users u ON u.id=t.user_id
     WHERE t.token_hash=? AND (t.expires_at IS NULL OR t.expires_at>?) AND u.disabled=0 AND u.demo_until IS NULL`,
    hashToken(match[1]),
    Date.now(),
  );
  if (!row) return null;
  // Last use for the overview, at most once a minute.
  if (!row.last_used_at || Date.now() - row.last_used_at > 60_000)
    run("UPDATE api_tokens SET last_used_at=? WHERE id=?", Date.now(), row.token_id);
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    disabled: row.disabled,
    created_at: row.created_at,
    avatar: row.avatar,
    demo_until: null,
    demo: false,
    // Groups come from the identity provider at sign-in; tokens carry none,
    // so they never get administration rights.
    groups: [],
    isAdmin: false,
    apiScope: row.scope,
  };
}
