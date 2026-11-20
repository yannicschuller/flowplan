// Sign-in for the desktop and mobile apps through the system browser:
// passkeys and identity providers that ask for one only work there (the
// mobile apps use ASWebAuthenticationSession or a Custom Tab, whose user
// agent does not name the app – the pages say "Flowplan app"). The app keeps a
// random verifier and opens /api/auth/desktop with its SHA-256 challenge;
// the browser signs in as usual, confirms and hands a one-time code back to
// the app (flowplan://sign-in). Only the app holding the verifier can redeem
// it – within a minute, once.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { hash } from "./auth";
import { one, run } from "./db";
import type { Locale } from "./i18n";

const LIFETIME_MS = 60_000;
const challengePattern = /^[A-Za-z0-9_-]{43}$/;

export const isDesktopChallenge = (value: unknown): value is string =>
  typeof value === "string" && challengePattern.test(value);

// Where the browser goes after signing in (also kept through SSO).
export const desktopReturnPath = (challenge: string) =>
  `/api/auth/desktop?challenge=${challenge}`;

export async function createDesktopCode(userId: string, groups: string[], challenge: string, authenticatedAt: number | null = null) {
  if (!isDesktopChallenge(challenge)) throw new Error("invalid challenge");
  const code = randomBytes(32).toString("base64url");
  await run("DELETE FROM auth_challenges WHERE expires<?", Date.now());
  await run(
    "INSERT INTO auth_challenges(id,challenge,user_id,kind,expires) VALUES(?,?,?,?,?)",
    hash(code),
    JSON.stringify({ challenge, groups, authenticatedAt }),
    userId,
    "desktop",
    Date.now() + LIFETIME_MS,
  );
  return code;
}

export async function redeemDesktopCode(code: unknown, verifier: unknown) {
  if (typeof code !== "string" || typeof verifier !== "string" || code.length > 100 || verifier.length > 200) return null;
  const row = await one<{ challenge: string; user_id: string; expires: number }>(
    "SELECT challenge,user_id,expires FROM auth_challenges WHERE id=? AND kind='desktop'",
    hash(code),
  );
  if (!row) return null;
  // Single use, whatever the outcome.
  await run("DELETE FROM auth_challenges WHERE id=?", hash(code));
  if (row.expires < Date.now()) return null;
  const { challenge, groups, authenticatedAt } = JSON.parse(row.challenge) as { challenge: string; groups: string[]; authenticatedAt?: number | null };
  const expected = Buffer.from(challenge);
  const actual = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return { userId: row.user_id, groups, authenticatedAt: authenticatedAt ?? null };
}

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// A small page of its own: API answers carry no app shell.
export function desktopPage(
  locale: Locale,
  { title, text, body = "", refresh, copyScript = false }: { title: string; text: string; body?: string; refresh?: string; copyScript?: boolean },
) {
  // The copy button (data-copy) needs a few lines of script: allowed by a
  // nonce of this response only, nothing else may run.
  const nonce = copyScript ? randomBytes(16).toString("base64") : "";
  const script = copyScript
    ? `<script nonce="${nonce}">document.querySelectorAll("[data-copy]").forEach(function(b){b.addEventListener("click",function(){var t=document.getElementById(b.getAttribute("data-copy"));if(!t)return;var done=function(){b.textContent=b.getAttribute("data-done");setTimeout(function(){b.textContent=b.getAttribute("data-label")},2000)};var pick=function(){var r=document.createRange();r.selectNodeContents(t);var s=getSelection();s.removeAllRanges();s.addRange(r)};if(navigator.clipboard){navigator.clipboard.writeText(t.textContent).then(done,pick)}else{pick()}})})</script>`
    : "";
  return new Response(
    `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh ? `<meta http-equiv="refresh" content="0;url=${escape(refresh)}">` : ""}<title>${escape(title)}</title><style>
:root{color-scheme:light dark;--bg:#f7f6f3;--card:#fff;--text:#1f1e1c;--muted:#6b6862;--line:#e4e1db;--accent:#2f6fec}
@media (prefers-color-scheme:dark){:root{--bg:#191918;--card:#232321;--text:#ecebe8;--muted:#a3a09a;--line:#363532;--accent:#5b8ff5}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{width:100%;max-width:420px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px}
h1{font-size:20px;margin:0 0 8px}p{margin:0 0 20px;color:var(--muted)}form{margin:0}
.button{display:block;width:100%;text-align:center;border:0;border-radius:9px;padding:11px 14px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none;background:var(--accent);color:#fff}
small{display:block;margin-top:14px;color:var(--muted)}
.code-hint{margin:20px 0 0}.code-row{display:flex;gap:8px;align-items:stretch;margin-top:8px}
code{flex:1;min-width:0;display:block;padding:9px 11px;border:1px solid var(--line);border-radius:9px;font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--text);overflow-wrap:anywhere;word-break:break-all;user-select:all}
.copy{flex:none;border:1px solid var(--line);border-radius:9px;padding:0 12px;background:transparent;color:var(--text);font:inherit;font-size:13.5px;font-weight:600;cursor:pointer}
.copy:hover{border-color:var(--accent)}
</style></head><body><main><h1>${escape(title)}</h1><p>${escape(text)}</p>${body}</main>${script}</body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline';${copyScript ? ` script-src 'nonce-${nonce}';` : ""} form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
        "Referrer-Policy": "no-referrer",
      },
    },
  );
}
export { escape as escapeHtml };
