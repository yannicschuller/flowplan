import { withRequestLocale } from "@/lib/content-locale";
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
import { one, run, transaction } from "@/lib/db";
import { ensureWorkspace } from "@/lib/seed";
import { command } from "@/lib/api";
import { confirmsWithPassword, deleteOwnAccount } from "@/lib/account-deletion";
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
  AccountExists,
  requestPasswordReset,
  resetPassword,
  verifyEmail,
  localGroups,
  resendVerification,
} from "@/lib/local-auth";
import { requestLocale } from "@/lib/i18n-server";
import { translate } from "@/lib/i18n";
import {
  createDesktopCode,
  desktopPage,
  desktopReturnPath,
  escapeHtml,
  isDesktopChallenge,
  redeemDesktopCode,
} from "@/lib/desktop-sign-in";

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
export const GET = withRequestLocale(handleGET);
async function handleGET(
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
    // The desktop and mobile apps sign in through the browser (lib/desktop-sign-in.ts).
    // The browser does not reveal which app asked, so the pages name neither.
    if (action === "desktop") {
      const params = new URL(req.url).searchParams,
        challenge = params.get("challenge"),
        locale = await requestLocale(),
        say = translate(locale);
      if (!isDesktopChallenge(challenge))
        return desktopPage(locale, {
          title: say("Link ungültig", "Invalid link"),
          text: say("Starte die Anmeldung noch einmal in der Flowplan-App.", "Start signing in again from the Flowplan app."),
        });
      const user = await currentUser();
      if (!user || user.demo) {
        // "Mit SSO anmelden" in the app goes straight to the provider.
        if (params.get("via") === "sso" && (await config().then(() => true, () => false)))
          return NextResponse.redirect(new URL(`/api/auth/login?returnTo=${encodeURIComponent(desktopReturnPath(challenge))}`, appUrl()));
        return NextResponse.redirect(new URL(`/?desktop=${challenge}`, appUrl()));
      }
      // Signed in: one click confirms – nothing is handed over unasked.
      return desktopPage(locale, {
        title: say("Bei der Flowplan-App anmelden", "Sign in to the Flowplan app"),
        text: say(
          `Du bist als ${user.name} (${user.email}) angemeldet. Die Flowplan-App wird mit diesem Konto verbunden.`,
          `You are signed in as ${user.name} (${user.email}). The Flowplan app will use this account.`,
        ),
        body: `<form method="post" action="/api/auth/desktop"><input type="hidden" name="challenge" value="${escapeHtml(challenge)}"><button class="button">${say("In der App anmelden", "Sign in to the app")}</button></form><small>${say("Nicht gestartet? Dann schließe dieses Fenster einfach.", "Didn't start this? Just close this window.")}</small>`,
      });
    }
    // Link from the confirmation e-mail.
    if (action === "verify") {
      const token = new URL(req.url).searchParams.get("token") || "";
      const userId = verifyEmail(token);
      // Confirmed: signed in right away.
      if (userId) await signIn(userId, localGroups(userId));
      return NextResponse.redirect(
        new URL(userId ? "/?verified=1" : `/?authError=${encodeURIComponent(translate(await requestLocale())("Der Bestätigungslink ist abgelaufen. Melde dich an, um einen neuen zu bekommen.", "The confirmation link has expired. Sign in to get a new one."))}`, appUrl()),
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
export const POST = withRequestLocale(handlePOST);
async function handlePOST(
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
    // Confirmed in the browser: a one-time code for the app.
    if (action === "desktop") {
      const say = translate(locale),
        user = await currentUser(),
        challenge = (await req.formData().catch(() => null))?.get("challenge");
      if (!user || user.demo || !isDesktopChallenge(challenge))
        return desktopPage(locale, {
          title: say("Anmeldung abgelaufen", "Sign-in expired"),
          text: say("Starte die Anmeldung noch einmal in der Flowplan-App.", "Start signing in again from the Flowplan app."),
        });
      const code = createDesktopCode(user.id, user.groups, challenge);
      const link = `flowplan://sign-in?${new URLSearchParams({ server: new URL(appUrl()).origin, challenge, code })}`;
      return desktopPage(locale, {
        title: say("Zurück zur App", "Back to the app"),
        text: say(
          "Die Flowplan-App übernimmt die Anmeldung. Falls dein Browser fragt, erlaube das Öffnen der App.",
          "The Flowplan app takes over the sign-in. If your browser asks, allow it to open the app.",
        ),
        body: `<a class="button" href="${escapeHtml(link)}">${say("Flowplan-App öffnen", "Open the Flowplan app")}</a><small>${say("Danach kannst du dieses Fenster schließen. Der Link gilt eine Minute.", "You can close this window afterwards. The link is valid for one minute.")}</small>`,
        refresh: link,
      });
    }
    if (action === "desktop-redeem") {
      const { code, verifier } = (await req.json().catch(() => ({}))) as { code?: unknown; verifier?: unknown };
      const handoff = redeemDesktopCode(code, verifier);
      if (!handoff)
        throw new HttpError(400, translate(locale)("Der Anmeldecode ist ungültig oder abgelaufen. Bitte erneut anmelden.", "The sign-in code is invalid or has expired. Please sign in again."));
      await signIn(handoff.userId, handoff.groups);
      return NextResponse.json({ ok: true });
    }
    const body = () => req.json().catch(() => ({}));
    // ---- E-mail and password ----
    if (action === "register") {
      let registered: Awaited<ReturnType<typeof register>>;
      try {
        registered = await register(await body(), locale);
      } catch (e) {
        if (e instanceof AccountExists && e.noted) return NextResponse.json({ ok: true, pending: true, email: e.email });
        throw e;
      }
      const { user, groups, pending } = registered;
      // With e-mail confirmation the account waits for the link.
      if (pending) return NextResponse.json({ ok: true, pending: true, email: user.email });
      await signIn(user.id, groups);
      return NextResponse.json({ ok: true });
    }
    if (action === "verify-resend") {
      resendVerification(await body(), locale);
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
      if (!user || user.demo) throw new HttpError(401, translate(locale)("Bitte melde dich an.", "Please sign in."));
      // API tokens act for scripts: they never change how the person signs in.
      if (user.apiScope) throw new HttpError(403, translate(locale)("Mit einem API-Token nicht möglich.", "Not possible with an API token."));
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
    // Deleting one's own account: accounts with a password confirm with it,
    // SSO accounts by typing their e-mail address. The session ends with it.
    if (action === "account-delete") {
      const user = await currentUser();
      if (!user) throw new HttpError(401, translate(locale)("Bitte melde dich an.", "Please sign in."));
      const input = (await body()) as { password?: unknown; confirm?: unknown; successors?: unknown };
      const local = one<{ email: string }>("SELECT email FROM local_accounts WHERE user_id=?", user.id);
      let confirm = input.confirm;
      if (local && !user.demo && confirmsWithPassword(user.id)) {
        const { userId } = await passwordLogin({ email: local.email, password: input.password }, clientAddress(req.headers), locale);
        if (userId !== user.id) throw new HttpError(403, translate(locale)("E-Mail-Adresse oder Passwort stimmt nicht.", "E-mail address or password is wrong."));
        confirm = one<{ email: string }>("SELECT email FROM users WHERE id=?", user.id)?.email;
      }
      const result = transaction(() => deleteOwnAccount(user, { confirm, successors: input.successors }, !!local && !user.demo && confirmsWithPassword(user.id)));
      (await cookies()).delete(cookieName);
      return NextResponse.json(result);
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
