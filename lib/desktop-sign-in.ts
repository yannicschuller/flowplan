// Sign-in for the desktop app through the system browser: passkeys and
// identity providers that ask for one only work there. The app keeps a
// random verifier and opens /api/auth/desktop with its SHA-256 challenge;
// the browser signs in as usual, confirms and hands a one-time code back to
// the app (flowplan://sign-in). Only the app holding the verifier can redeem
// it – within a minute, once.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { hash } from "./auth";
import { one, run } from "./db";

const LIFETIME_MS = 60_000;
const challengePattern = /^[A-Za-z0-9_-]{43}$/;

export const isDesktopChallenge = (value: unknown): value is string =>
  typeof value === "string" && challengePattern.test(value);

// Where the browser goes after signing in (also kept through SSO).
export const desktopReturnPath = (challenge: string) =>
  `/api/auth/desktop?challenge=${challenge}`;

export function createDesktopCode(userId: string, groups: string[], challenge: string) {
  if (!isDesktopChallenge(challenge)) throw new Error("invalid challenge");
  const code = randomBytes(32).toString("base64url");
  run("DELETE FROM auth_challenges WHERE expires<?", Date.now());
  run(
    "INSERT INTO auth_challenges(id,challenge,user_id,kind,expires) VALUES(?,?,?,?,?)",
    hash(code),
    JSON.stringify({ challenge, groups }),
    userId,
    "desktop",
    Date.now() + LIFETIME_MS,
  );
  return code;
}

export function redeemDesktopCode(code: unknown, verifier: unknown) {
  if (typeof code !== "string" || typeof verifier !== "string" || code.length > 100 || verifier.length > 200) return null;
  const row = one<{ challenge: string; user_id: string; expires: number }>(
    "SELECT challenge,user_id,expires FROM auth_challenges WHERE id=? AND kind='desktop'",
    hash(code),
  );
  if (!row) return null;
  // Single use, whatever the outcome.
  run("DELETE FROM auth_challenges WHERE id=?", hash(code));
  if (row.expires < Date.now()) return null;
  const { challenge, groups } = JSON.parse(row.challenge) as { challenge: string; groups: string[] };
  const expected = Buffer.from(challenge);
  const actual = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return { userId: row.user_id, groups };
}

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// A small page of its own: API answers carry no app shell.
export function desktopPage(
  de: boolean,
  { title, text, body = "", refresh }: { title: string; text: string; body?: string; refresh?: string },
) {
  return new Response(
    `<!doctype html><html lang="${de ? "de" : "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh ? `<meta http-equiv="refresh" content="0;url=${escape(refresh)}">` : ""}<title>${escape(title)}</title><style>
:root{color-scheme:light dark;--bg:#f7f6f3;--card:#fff;--text:#1f1e1c;--muted:#6b6862;--line:#e4e1db;--accent:#2f6fec}
@media (prefers-color-scheme:dark){:root{--bg:#191918;--card:#232321;--text:#ecebe8;--muted:#a3a09a;--line:#363532;--accent:#5b8ff5}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{width:100%;max-width:420px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px}
h1{font-size:20px;margin:0 0 8px}p{margin:0 0 20px;color:var(--muted)}form{margin:0}
.button{display:block;width:100%;text-align:center;border:0;border-radius:9px;padding:11px 14px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none;background:var(--accent);color:#fff}
small{display:block;margin-top:14px;color:var(--muted)}
</style></head><body><main><h1>${escape(title)}</h1><p>${escape(text)}</p>${body}</main></body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        "Referrer-Policy": "no-referrer",
      },
    },
  );
}
export { escape as escapeHtml };
