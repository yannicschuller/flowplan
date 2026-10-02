import { DEMO_MAX_MS, demoSessionExpiry, endDemo, startDemo } from "@/lib/demo";
import { syncAvatar } from "@/lib/avatars";
import { loginReturnPath } from "@/lib/page-location";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import * as oidc from "openid-client";
import { randomBytes } from "node:crypto";
import {
  appUrl,
  checkOrigin,
  cookieName,
  hash,
  issueSession,
  upsertUser,
  extractGroups,
  acceptInvites,
  adminGroup,
  currentUser,
  HttpError,
} from "@/lib/auth";
import { one, run } from "@/lib/db";
import { ensureWorkspace } from "@/lib/seed";
export const runtime = "nodejs";
import { oidcConfig as config } from "@/lib/oidc";
import {
  changePassword,
  updateLocalProfile,
  deletePasskey,
  finishPasskeyRegistration,
  listPasskeys,
  passkeyLogin,
  passkeyLoginOptions,
  passkeyRegistrationOptions,
  passwordLogin,
  register,
  requestPasswordReset,
  resetPassword,
  verifyEmail,
} from "@/lib/local-auth";
import { requestLocale } from "@/lib/i18n-server";

// The pending passkey ceremony of this browser (5 minutes).
const WEBAUTHN_COOKIE = "flowplan_webauthn";
async function rememberChallenge(token: string) {
  (await cookies()).set(WEBAUTHN_COOKIE, token, {
    httpOnly: true,
    secure: appUrl().startsWith("https:"),
    sameSite: "strict",
    path: "/api/auth",
    maxAge: 300,
  });
}
async function takeChallengeCookie() {
  const jar = await cookies();
  const token = jar.get(WEBAUTHN_COOKIE)?.value;
  jar.delete(WEBAUTHN_COOKIE);
  return token;
}
async function signIn(userId: string, groups: string[]) {
  const user = one<{ disabled: number }>("SELECT disabled FROM users WHERE id=?", userId);
  if (!user || user.disabled) throw new HttpError(403, "Dieses Konto ist deaktiviert.");
  ensureWorkspace(userId);
  await issueSession(userId, groups);
}
import { clientAddress } from "@/lib/client-address";
export async function GET(
  req: Request,
  { params }: { params: Promise<{ action: string }> },
) {
  const { action } = await params;
  let returnTo = "/";
  try {
    if (action === "login") {
      const params = new URL(req.url).searchParams;
      returnTo = loginReturnPath(params.get("returnTo"));
      // "Registrieren": providers that support it open their sign-up page
      // (OpenID Connect prompt=create); others show their normal login,
      // where the first sign-in creates the account.
      const register =
        params.get("register") === "1" &&
        process.env.OIDC_PROMPT_CREATE === "true";
      const c = await config(),
        verifier = oidc.randomPKCECodeVerifier(),
        state = oidc.randomState(),
        nonce = oidc.randomNonce(),
        flow = randomBytes(32).toString("base64url");
      run("DELETE FROM oidc_flows WHERE expires<?", Date.now());
      run(
        "INSERT INTO oidc_flows(id,state,verifier,nonce,expires,return_to) VALUES(?,?,?,?,?,?)",
        hash(flow),
        state,
        verifier,
        nonce,
        Date.now() + 600000,
        returnTo,
      );
      (await cookies()).set("flowplan_oidc", flow, {
        httpOnly: true,
        secure: appUrl().startsWith("https:"),
        sameSite: "lax",
        path: "/",
        maxAge: 600,
      });
      return NextResponse.redirect(
        oidc.buildAuthorizationUrl(c, {
          redirect_uri: `${appUrl()}/api/auth/callback`,
          scope: process.env.OIDC_SCOPES || "openid profile email groups",
          code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
          code_challenge_method: "S256",
          state,
          nonce,
          ...(register ? { prompt: "create" } : {}),
        }),
      );
    }
    // Link from the confirmation e-mail.
    if (action === "verify") {
      const token = new URL(req.url).searchParams.get("token") || "";
      const ok = verifyEmail(token);
      return NextResponse.redirect(
        new URL(ok ? "/?verified=1" : `/?authError=${encodeURIComponent((await requestLocale()) === "de" ? "Der Bestätigungslink ist abgelaufen." : "The confirmation link has expired.")}`, appUrl()),
      );
    }
    if (action === "callback") {
      const jar = await cookies(),
        flow = jar.get("flowplan_oidc")?.value;
      jar.delete("flowplan_oidc");
      if (!flow) throw new HttpError(400, "Anmeldung abgelaufen.");
      const f = one<{
        state: string;
        verifier: string;
        nonce: string;
        expires: number;
        return_to: string | null;
      }>("SELECT * FROM oidc_flows WHERE id=?", hash(flow));
      run("DELETE FROM oidc_flows WHERE id=?", hash(flow));
      if (!f || f.expires < Date.now())
        throw new HttpError(400, "Anmeldung abgelaufen.");
      returnTo = loginReturnPath(f.return_to);
      const c = await config();
      const callback = new URL(`${appUrl()}/api/auth/callback`);
      callback.search = new URL(req.url).search;
      const tokens = await oidc.authorizationCodeGrant(c, callback, {
        pkceCodeVerifier: f.verifier,
        expectedState: f.state,
        expectedNonce: f.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims) throw new HttpError(400, "ID-Token fehlt.");
      let profile: Record<string, unknown> = { ...claims };
      if (c.serverMetadata().userinfo_endpoint) {
        const info = await oidc.fetchUserInfo(
          c,
          tokens.access_token,
          claims.sub,
        );
        profile = { ...profile, ...info };
      }
      const groups = extractGroups(profile);
      if (
        process.env.OIDC_ALLOWED_GROUP &&
        !groups.includes(process.env.OIDC_ALLOWED_GROUP)
      )
        throw new HttpError(403, "Zugriff für diese Gruppe nicht erlaubt.");
      const user = upsertUser(
        `${claims.iss}|${claims.sub}`,
        String(profile.name || profile.preferred_username || "Mitglied"),
        String(profile.email || ""),
      );
      await syncAvatar(user.id, profile.picture);
      acceptInvites(user, profile.email_verified === true);
      ensureWorkspace(user.id);
      await issueSession(user.id, groups);
      return NextResponse.redirect(new URL(returnTo, appUrl()));
    }
    return NextResponse.json({ error: "Nicht gefunden" }, { status: 404 });
  } catch (e) {
    console.error("OIDC sign-in failed", e instanceof Error ? e.name : "Error");
    return NextResponse.redirect(
      new URL(
        `/?authError=${encodeURIComponent(e instanceof HttpError ? e.message : "Anmeldung fehlgeschlagen. Bitte erneut versuchen.")}${new URL(returnTo, appUrl()).hash}`,
        appUrl(),
      ),
    );
  }
}
export async function POST(
  req: Request,
  { params }: { params: Promise<{ action: string }> },
) {
  try {
    checkOrigin(req);
    const { action } = await params;
    if (action === "demo") {
      if (process.env.NODE_ENV === "production")
        throw new HttpError(
          403,
          "Demo-Anmeldung ist in Produktion deaktiviert.",
        );
      const user = upsertUser(
        "local-development",
        "Alex Morgan",
        "alex@flowplan.local",
      );
      ensureWorkspace(user.id);
      // In development the demo account administers the instance.
      await issueSession(user.id, [adminGroup()]);
      return NextResponse.json({ ok: true });
    }
    // "Demo ausprobieren" on the start page.
    if (action === "trial") {
      const address = clientAddress(req.headers);
      const uid = startDemo(address);
      const until = Date.now() + DEMO_MAX_MS;
      await issueSession(uid, [], {
        expires: demoSessionExpiry(until),
        until,
      });
      return NextResponse.json({ ok: true });
    }
    // Ends a demo right away: account, workspace and files are deleted.
    if (action === "trial-end") {
      const user = await currentUser();
      if (user?.demo) endDemo(user.id);
      (await cookies()).delete(cookieName);
      return NextResponse.json({ ok: true });
    }
    const locale = await requestLocale();
    const body = () => req.json().catch(() => ({}));
    // ---- E-mail and password ----
    if (action === "register") {
      const { user, groups } = await register(await body(), locale);
      await signIn(user.id, groups);
      return NextResponse.json({ ok: true });
    }
    if (action === "password") {
      const { userId, groups } = await passwordLogin(await body(), clientAddress(req.headers), locale);
      await signIn(userId, groups);
      return NextResponse.json({ ok: true });
    }
    if (action === "reset-request") {
      requestPasswordReset(await body(), locale);
      return NextResponse.json({ ok: true });
    }
    if (action === "reset") {
      await resetPassword(await body(), locale);
      return NextResponse.json({ ok: true });
    }
    // ---- Passkeys: sign in ----
    if (action === "passkey-options") {
      const { options, token } = await passkeyLoginOptions();
      await rememberChallenge(token);
      return NextResponse.json(options);
    }
    if (action === "passkey") {
      const { userId, groups } = await passkeyLogin(await takeChallengeCookie(), await body(), clientAddress(req.headers), locale);
      await signIn(userId, groups);
      return NextResponse.json({ ok: true });
    }
    // ---- The signed-in person's password and passkeys ----
    if (["profile", "password-change", "passkey-register-options", "passkey-register", "passkey-delete", "passkeys"].includes(action)) {
      const user = await currentUser();
      if (!user || user.demo) throw new HttpError(401, locale === "de" ? "Bitte melde dich an." : "Please sign in.");
      if (action === "profile") updateLocalProfile(user.id, await body(), locale);
      else if (action === "password-change") await changePassword(user.id, await body(), locale);
      else if (action === "passkey-register-options") {
        const { options, token } = await passkeyRegistrationOptions(user, locale);
        await rememberChallenge(token);
        return NextResponse.json(options);
      } else if (action === "passkey-register")
        await finishPasskeyRegistration(user, await takeChallengeCookie(), await body(), locale);
      else if (action === "passkey-delete") {
        const { id } = (await body()) as { id?: unknown };
        if (typeof id === "string") deletePasskey(user.id, id);
      }
      return NextResponse.json({ ok: true, passkeys: listPasskeys(user.id) });
    }
    if (action === "logout") {
      const demoUser = await currentUser();
      if (demoUser?.demo) endDemo(demoUser.id);
      const jar = await cookies(),
        token = jar.get(cookieName)?.value;
      if (token) run("DELETE FROM sessions WHERE token=?", hash(token));
      jar.delete(cookieName);
      return NextResponse.json({ ok: true });
    }
    throw new HttpError(404, "Nicht gefunden");
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Fehler" },
      { status: e instanceof HttpError ? e.status : 500 },
    );
  }
}
