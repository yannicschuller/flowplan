import { z } from "zod";
import { withRequestLocale } from "@/lib/content-locale";
import { DEMO_MAX_MS, demoSessionExpiry, endDemo, startDemo } from "@/lib/demo";
import { syncAvatar } from "@/lib/avatars";
import { loginReturnPath } from "@/lib/page-location";
import { after, NextResponse } from "next/server";
import { dispatchPush } from "@/lib/push";
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
  acceptPendingInvites,
  adminGroup,
  currentUser,
  endOtherSessions,
  HttpError,
} from "@/lib/auth";
import { one, run, transaction } from "@/lib/db";
import { ensureWorkspace } from "@/lib/seed";
import { syncSsoMemberships } from "@/lib/sso-mappings";
import { command } from "@/lib/api";
import { confirmsWithPassword, deleteOwnAccount } from "@/lib/account-deletion";
import { sweepSpaceGitCopies } from "@/lib/space-git-export";
import { directoryPasswordLogin } from "@/lib/ldap-auth";
import type { User } from "@/lib/types";
import {
  PENDING_LINK_SECONDS,
  cancelPending,
  completePendingLink,
  linkFlowOwner,
  linkFromSettings,
  provePendingCode,
  provePendingPasskey,
  provePendingPassword,
  requirePending,
  resolveOidcSignIn,
  separateFromPending,
  startPendingLink,
  type OidcProfile,
} from "@/lib/oidc-link";
import { appSignInReportLine } from "@/lib/app-sign-in-report";
import { readJsonLimited, readTextLimited } from "@/lib/request-body";
import { provesApp } from "@/lib/app-devices";
import { refuseSsoOnly, removeIdentity, removePassword, signInOverview, ssoOnlyAccount } from "@/lib/identities";
import { confirmStep, sessionStartedAt, stepUpMethods } from "@/lib/step-up";
export const runtime = "nodejs";
import { oidcConfig as config, oidcFailure } from "@/lib/oidc";
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
  isLocalAccount,
  passkeyConfirmOptions,
  setNewPassword,
} from "@/lib/local-auth";
import {
  PENDING_MAX_AGE,
  afterPasskey,
  afterPassword,
  completeSignIn,
  confirmTotpSetup,
  disableTotp,
  setCodeAfterPasskey,
  regenerateRecoveryCodes,
  startTotpSetup,
  twoFactorStatus,
} from "@/lib/two-factor";
import { totpEnabled } from "@/lib/two-factor-policy";
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
// A sign-in waiting for its second step (lib/two-factor.ts): a signed
// token, not a session, for five minutes and only for /api/auth.
const PENDING_COOKIE = "flowplan_2fa";
async function rememberPending(token: string) {
  (await cookies()).set(PENDING_COOKIE, token, {
    httpOnly: true,
    secure: appUrl().startsWith("https:"),
    sameSite: "strict",
    path: "/api/auth",
    maxAge: PENDING_MAX_AGE,
  });
}
// app: the desktop or mobile app proved this sign-in its own
// (lib/app-devices.ts) – it then lasts as long as the app's.
async function signIn(userId: string, groups: string[], remember = false, app = false, authenticatedAt?: number | null) {
  const user = await one<{ disabled: number }>("SELECT disabled FROM users WHERE id=?", userId);
  if (!user || user.disabled) throw new HttpError(403, "Dieses Konto ist deaktiviert.");
  await acceptPendingInvites(userId);
  // SSO accounts (e.g. through the desktop app): workspaces from SSO groups.
  if (!(await isLocalAccount(userId))) await syncSsoMemberships(userId, groups);
  await ensureWorkspace(userId);
  // Groups from an SSO provider (e.g. the desktop app of an SSO account) are
  // checked again after SESSION_GROUPS_HOURS.
  await issueSession(userId, groups, undefined, { remember, sso: !(await isLocalAccount(userId)), app, authenticatedAt });
}
// The end of every SSO sign-in (also after connecting an existing account).
async function finishSsoSignIn(userId: string, sso: OidcProfile, remember: boolean) {
  const local = await isLocalAccount(userId);
  const user = await one<User & { email_verified: number }>("SELECT * FROM users WHERE id=?", userId);
  if (!user || user.disabled) throw new HttpError(403, "Dieses Konto ist deaktiviert.");
  // An account with e-mail and password keeps its picture and its own
  // confirmation of the address.
  if (!local) {
    await syncAvatar(userId, sso.picture);
    // Whether the provider vouches for the address: decides whether
    // invitations and shared pages for it reach this account.
    await run("UPDATE users SET email_verified=? WHERE id=?", sso.emailVerified ? 1 : 0, userId);
  }
  await acceptInvites(user, local ? !!user.email_verified : sso.emailVerified);
  // Workspaces and groups mapped to the person's SSO groups, before a
  // personal workspace would be created for someone without one.
  await syncSsoMemberships(userId, sso.groups);
  await ensureWorkspace(userId);
  // A linked account with e-mail and password keeps its admin flag.
  const groups = [...new Set([...sso.groups, ...await localGroups(userId)])];
  await issueSession(userId, groups, undefined, { remember, sso: true });
}
// A first SSO sign-in waiting to be connected to an existing account.
const LINK_COOKIE = "flowplan_link";
// "Stay signed in on this device" from the sign-in form.
const wantsRemember = (input: unknown) => !!input && typeof input === "object" && (input as { remember?: unknown }).remember === true;
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
      await run("DELETE FROM oidc_flows WHERE expires<?", Date.now());
      await run(
        "INSERT INTO oidc_flows(id,state,verifier,nonce,expires,return_to,remember) VALUES(?,?,?,?,?,?,?)",
        hash(flow),
        state,
        verifier,
        nonce,
        Date.now() + 600000,
        returnTo,
        params.get("remember") === "1" ? 1 : 0,
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
      // The sheet of the app reached the instance (#109: tells a sign-in the
      // app never opened from one that failed later).
      console.info(`App sign-in: the browser opened the hand-off${params.get("via") === "sso" ? " (SSO)" : ""}.`);
      const user = await currentUser();
      // An API token is no browser sign-in: the person signs in first.
      if (!user || user.demo || user.apiScope) {
        // "Mit SSO anmelden" in the app goes straight to the provider.
        if (params.get("via") === "sso" && await config().then(() => true, () => false))
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
      const userId = await verifyEmail(token);
      // Confirmed: signed in right away in the browser that signed up;
      // elsewhere the person signs in themselves.
      const jar = await cookies();
      // An account with an authenticator app always signs in with its code,
      // and one that signs in through SSO only (OIDC_LINKED_SSO_ONLY) there.
      const here = !!userId && jar.get("flowplan_verify")?.value === userId && !(await totpEnabled(userId)) && !(await ssoOnlyAccount(userId));
      if (userId && here) {
        jar.delete("flowplan_verify");
        await signIn(userId, await localGroups(userId));
      }
      return NextResponse.redirect(
        new URL(userId ? (here ? "/?verified=1" : "/?confirmed=1") : `/?authError=${encodeURIComponent(translate(await requestLocale())("Der Bestätigungslink ist abgelaufen. Melde dich an, um einen neuen zu bekommen.", "The confirmation link has expired. Sign in to get a new one."))}`, appUrl()),
      );
    }
    if (action === "callback") {
      const jar = await cookies(),
        flow = jar.get("flowplan_oidc")?.value;
      jar.delete("flowplan_oidc");
      if (!flow) throw new HttpError(400, "Anmeldung abgelaufen.");
      const f = await one<{
        state: string;
        verifier: string;
        nonce: string;
        expires: number;
        return_to: string | null;
        remember: number;
        link_user_id: string | null;
        link_session: string | null;
      }>("SELECT * FROM oidc_flows WHERE id=?", hash(flow));
      await run("DELETE FROM oidc_flows WHERE id=?", hash(flow));
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
      const sso: OidcProfile = {
        issuer: String(claims.iss),
        subject: claims.sub,
        email: String(profile.email || ""),
        emailVerified: profile.email_verified === true,
        name: String(profile.name || profile.preferred_username || "Mitglied"),
        picture: profile.picture,
        groups,
      };
      const locale = await requestLocale();
      // "Connect SSO" from the account settings (#101): only for the account
      // and the session that started it.
      if (f.link_user_id) {
        const back = (result: string) => NextResponse.redirect(new URL(`/?ssoLink=${encodeURIComponent(result)}#settings/account/sign-in-methods`, appUrl()));
        const me = await linkFlowOwner(f, jar.get(cookieName)?.value);
        if (!me) return back(translate(locale)("Die Verbindung ist abgelaufen. Bitte noch einmal „SSO verbinden“ wählen.", "The connection has expired. Please choose “Connect SSO” again."));
        // An identity that may not sign in here is not connected either.
        if (process.env.OIDC_ALLOWED_GROUP && !groups.includes(process.env.OIDC_ALLOWED_GROUP)) return back(translate(locale)("Zugriff für diese Gruppe nicht erlaubt.", "Access not allowed for this group."));
        try {
          await linkFromSettings(me, sso, locale);
        } catch (e) {
          if (e instanceof HttpError) return back(e.message);
          throw e;
        }
        return back("ok");
      }
      if (
        process.env.OIDC_ALLOWED_GROUP &&
        !groups.includes(process.env.OIDC_ALLOWED_GROUP)
      )
        throw new HttpError(403, translate(locale)("Zugriff für diese Gruppe nicht erlaubt.", "Access not allowed for this group."));
      const found = await resolveOidcSignIn(sso, locale);
      // The address belongs to an existing account: it is connected only
      // after the person proves it (app/link-account).
      if (found.kind === "link") {
        const token = await startPendingLink(found.candidateId, sso, { remember: !!f.remember, returnTo });
        jar.set(LINK_COOKIE, token, { httpOnly: true, secure: appUrl().startsWith("https:"), sameSite: "lax", path: "/", maxAge: PENDING_LINK_SECONDS });
        return NextResponse.redirect(new URL("/link-account", appUrl()));
      }
      await finishSsoSignIn(found.userId, sso, !!f.remember);
      return NextResponse.redirect(new URL(returnTo, appUrl()));
    }
    return NextResponse.json({ error: "Nicht gefunden" }, { status: 404 });
  } catch (e) {
    console.error("OIDC sign-in failed:", oidcFailure(e));
    return NextResponse.redirect(
      new URL(
        `/?authError=${encodeURIComponent(e instanceof HttpError ? e.message : translate(await requestLocale().catch(() => "de" as const))("Anmeldung fehlgeschlagen. Bitte erneut versuchen.", "Sign-in failed. Please try again."))}${new URL(returnTo, appUrl()).hash}`,
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
    const { action } = await params;
    // Where credential forms post when their script did not run (#62):
    // method="post" keeps the password out of the address, and this answer
    // never reads the body – it only says why nothing happened.
    if (action === "no-script") {
      const locale = await requestLocale(),
        say = translate(locale);
      const response = desktopPage(locale, {
        title: say("Die Seite wurde nicht vollständig geladen", "The page did not load completely"),
        text: say(
          "Für dieses Formular braucht Flowplan JavaScript, und das ist nicht angekommen. Lade die Seite neu und versuche es noch einmal. Passiert das wieder, prüfe, ob JavaScript erlaubt ist und ob die Adresse der Instanz (APP_URL) zu der passt, unter der du sie aufrufst – http oder https.",
          "Flowplan needs JavaScript for this form, and it did not arrive. Reload the page and try again. If it happens again, check that JavaScript is allowed and that the instance's address (APP_URL) matches the one you open it with – http or https.",
        ),
        body: `<a class="button" href="/">${escapeHtml(say("Zurück zu Flowplan", "Back to Flowplan"))}</a>`,
      });
      return new Response(response.body, { status: 400, headers: response.headers });
    }
    await checkOrigin(req);
    // The app's sign-in page: a hand-off to the app that failed or went
    // unanswered (lib/app-sign-in.ts, #109) – a line for whoever runs it.
    if (action === "app-sign-in-report") {
      const line = appSignInReportLine(await readJsonLimited(req, 16_000).catch(() => null));
      if (line) console.warn(line);
      return new Response(null, { status: 204 });
    }
    if (action === "demo") {
      if (process.env.NODE_ENV === "production")
        throw new HttpError(
          403,
          "Demo-Anmeldung ist in Produktion deaktiviert.",
        );
      const user = await upsertUser(
        "local-development",
        "Alex Morgan",
        "alex@flowplan.local",
      );
      await ensureWorkspace(user.id);
      // In development the demo account administers the instance.
      await issueSession(user.id, [adminGroup()]);
      return NextResponse.json({ ok: true });
    }
    // "Demo ausprobieren" on the start page.
    if (action === "trial") {
      const address = clientAddress(req.headers);
      const uid = await startDemo(address);
      // Signed in already: that session ends rather than lingering behind
      // the demo's cookie (a previous demo ends with its data, as at sign-out).
      const jar = await cookies(),
        previous = jar.get(cookieName)?.value;
      if (previous) {
        const before = await currentUser();
        if (before?.demo) await endDemo(before.id);
        await run("DELETE FROM sessions WHERE token=?", hash(previous));
      }
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
      if (user?.demo) await endDemo(user.id);
      (await cookies()).delete(cookieName);
      return NextResponse.json({ ok: true });
    }
    const locale = await requestLocale();
    // Confirmed in the browser: a one-time code for the app.
    if (action === "desktop") {
      const say = translate(locale),
        user = await currentUser(),
        // A small form (the challenge only): read with a limit before anything else.
        challenge = new URLSearchParams(await readTextLimited(req, 4_000).catch(() => "")).get("challenge");
      // Only a browser session hands a sign-in to the app – never an API
      // token (it would mint a full session that outlives the token).
      if (!user || user.demo || user.apiScope || user.twoFactorSetup || !isDesktopChallenge(challenge))
        return desktopPage(locale, {
          title: say("Anmeldung abgelaufen", "Sign-in expired"),
          text: say("Starte die Anmeldung noch einmal in der Flowplan-App.", "Start signing in again from the Flowplan app."),
        });
      const code = await createDesktopCode(user.id, user.groups, challenge, await sessionStartedAt((await cookies()).get(cookieName)?.value));
      const link = `flowplan://sign-in?${new URLSearchParams({ server: new URL(appUrl()).origin, challenge, code })}`;
      return desktopPage(locale, {
        title: say("Zurück zur App", "Back to the app"),
        text: say(
          "Die Flowplan-App übernimmt die Anmeldung. Falls dein Browser fragt, erlaube das Öffnen der App.",
          "The Flowplan app takes over the sign-in. If your browser asks, allow it to open the app.",
        ),
        // The code is also shown as text: on Linux without a flowplan://
        // handler (bare AppImage) the app offers a field to paste it into.
        body: `<a class="button" href="${escapeHtml(link)}">${say("Flowplan-App öffnen", "Open the Flowplan app")}</a><small>${say("Danach kannst du dieses Fenster schließen. Der Link gilt eine Minute.", "You can close this window afterwards. The link is valid for one minute.")}</small><p class="code-hint"><small>${say("Öffnet sich die App nicht, kopiere diesen Code in das Feld „Code einfügen“ der App:", "If the app does not open, copy this code into the app's “Paste code” field:")}</small><br><code>${escapeHtml(code)}</code></p>`,
        refresh: link,
      });
    }
    if (action === "desktop-redeem") {
      const { code, verifier } = (await readJsonLimited(req, 16_000).catch(() => null) ?? {}) as { code?: unknown; verifier?: unknown };
      const handoff = await redeemDesktopCode(code, verifier);
      if (!handoff)
        throw new HttpError(400, translate(locale)("Der Anmeldecode ist ungültig oder abgelaufen. Bitte erneut anmelden.", "The sign-in code is invalid or has expired. Please sign in again."));
      // The desktop and mobile apps are a device of their own: they stay
      // signed in unless the instance says otherwise. Only the app holding
      // the verifier gets here – the hand-off is its proof
      // (lib/app-devices.ts), for every app version.
      await signIn(handoff.userId, handoff.groups, true, await provesApp({ via: "handoff" }), handoff.authenticatedAt);
      return NextResponse.json({ ok: true });
    }
    // Read with a limit (lib/request-body.ts): an oversized body is a 413,
    // anything unreadable an empty input as before.
    const body = () =>
      readJsonLimited(req, 64_000).catch((e) => {
        if (e instanceof HttpError) throw e;
        return {};
      });
    const agent = req.headers.get("user-agent");
    // ---- E-mail and password ----
    if (action === "register") {
      let registered: Awaited<ReturnType<typeof register>>;
      const input = await body();
      try {
        registered = await register(input, locale, clientAddress(req.headers));
      } catch (e) {
        if (e instanceof AccountExists && e.noted) return NextResponse.json({ ok: true, pending: true, email: e.email });
        throw e;
      }
      const { user, groups, pending } = registered;
      // With e-mail confirmation the account waits for the link. This
      // browser is remembered: the link signs in only here, so a link sent
      // to someone else cannot sign them into a stranger's account.
      if (pending) {
        (await cookies()).set("flowplan_verify", user.id, { httpOnly: true, secure: appUrl().startsWith("https:"), sameSite: "lax", path: "/api/auth", maxAge: 7 * 86400 });
        return NextResponse.json({ ok: true, pending: true, email: user.email });
      }
      await signIn(user.id, groups, false, await provesApp({ via: "form", userId: user.id, input, agent }));
      return NextResponse.json({ ok: true });
    }
    if (action === "verify-resend") {
      await resendVerification(await body(), locale);
      return NextResponse.json({ ok: true });
    }
    if (action === "password") {
      const input = await body();
      // Accounts with e-mail and password, or the LDAP directory (LDAP_URL).
      const { userId, groups } = await directoryPasswordLogin(input, clientAddress(req.headers), locale);
      // OIDC_LINKED_SSO_ONLY: an account connected to SSO signs in there.
      await refuseSsoOnly(userId, locale);
      // With an authenticator app, a code follows (action "totp-login").
      const next = await afterPassword(userId, wantsRemember(input), locale);
      if ("pending" in next) {
        await rememberPending(next.pending);
        return NextResponse.json({ ok: true, twoFactor: true });
      }
      // In the app with its device key: as long as the app's (lib/app-devices.ts).
      await signIn(userId, groups, wantsRemember(input), await provesApp({ via: "form", userId, input, agent }));
      return NextResponse.json({ ok: true });
    }
    if (action === "totp-login") {
      const jar = await cookies();
      const input = await body();
      const result = await completeSignIn(jar.get(PENDING_COOKIE)?.value, input, clientAddress(req.headers), locale);
      jar.delete(PENDING_COOKIE);
      await refuseSsoOnly(result.userId, locale);
      // The device key is checked (and registered) only now, after the code.
      await signIn(result.userId, result.groups, result.remember, await provesApp({ via: "form", userId: result.userId, input, agent }));
      return NextResponse.json({ ok: true });
    }
    if (action === "reset-request") {
      await requestPasswordReset(await body(), locale, clientAddress(req.headers));
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
      const input = await body();
      const { userId, groups } = await passkeyLogin(await takeChallengeCookie(), input, clientAddress(req.headers), locale);
      await refuseSsoOnly(userId, locale);
      // A code from the app follows only if the person asked for it.
      const next = await afterPasskey(userId, wantsRemember(input));
      if ("pending" in next) {
        await rememberPending(next.pending);
        return NextResponse.json({ ok: true, twoFactor: true });
      }
      await signIn(userId, groups, wantsRemember(input), await provesApp({ via: "form", userId, input, agent }));
      return NextResponse.json({ ok: true });
    }
    // ---- A first SSO sign-in that waits to be connected (#101,
    // app/link-account): the person proves the existing account ----
    if (["link-password", "link-code", "link-passkey", "link-separate", "link-cancel"].includes(action)) {
      const jar = await cookies();
      const token = jar.get(LINK_COOKIE)?.value;
      if (action === "link-cancel") {
        await cancelPending(token);
        jar.delete(LINK_COOKIE);
        return NextResponse.json({ ok: true });
      }
      const row = await requirePending(token, locale);
      const address = clientAddress(req.headers);
      const done = async (provenUserId: string) => {
        const linked = await completePendingLink(row, provenUserId, locale);
        jar.delete(LINK_COOKIE);
        await finishSsoSignIn(linked.userId, linked.profile, linked.remember);
        return NextResponse.json({ ok: true, returnTo: loginReturnPath(linked.returnTo) });
      };
      if (action === "link-separate") {
        const separate = await separateFromPending(row, locale);
        jar.delete(LINK_COOKIE);
        await finishSsoSignIn(separate.userId, separate.profile, separate.remember);
        return NextResponse.json({ ok: true, returnTo: loginReturnPath(separate.returnTo) });
      }
      // The account's password (plus a code if its app is on) or its passkey.
      const proof =
        action === "link-code"
          ? (await provePendingCode(row, await body(), address, locale))
          : action === "link-password"
            ? await provePendingPassword(row, await body(), address, locale)
            : await provePendingPasskey(row, await takeChallengeCookie(), await body(), address, locale);
      if ("twoFactor" in proof) return NextResponse.json({ ok: true, twoFactor: true });
      return done(proof.userId);
    }
    // ---- Sign-in methods of the signed-in person (#101): SSO identities,
    // removing or setting the password; sensitive steps are confirmed
    // again (lib/step-up.ts) ----
    if (["sign-in-methods", "confirm-passkey-options", "sso-link-start", "sso-unlink", "password-remove", "password-set", "journal-pin-reset"].includes(action)) {
      const user = await currentUser();
      if (!user || user.demo || user.twoFactorSetup) throw new HttpError(401, translate(locale)("Bitte melde dich an.", "Please sign in."));
      if (user.apiScope) throw new HttpError(403, translate(locale)("Mit einem API-Token nicht möglich.", "Not possible with an API token."));
      const jar = await cookies();
      const sessionStart = await sessionStartedAt(jar.get(cookieName)?.value);
      const overview = async () => ({ ...(await signInOverview(user.id)), confirm: await stepUpMethods(user.id, sessionStart) });
      if (action === "sign-in-methods") return NextResponse.json(await overview(), { headers: { "Cache-Control": "no-store" } });
      if (action === "confirm-passkey-options") {
        const { options, token } = await passkeyConfirmOptions(user.id, locale);
        await rememberChallenge(token);
        return NextResponse.json(options);
      }
      const input = await body();
      const confirm = async () =>
        confirmStep(user.id, input, { address: clientAddress(req.headers), locale, sessionStart, passkeyToken: (input as { confirm?: { passkey?: unknown } }).confirm?.passkey ? await takeChallengeCookie() : undefined });
      if (action === "sso-link-start") {
        const c = await config();
        await confirm();
        const verifier = oidc.randomPKCECodeVerifier(),
          state = oidc.randomState(),
          nonce = oidc.randomNonce(),
          flow = randomBytes(32).toString("base64url");
        await run("DELETE FROM oidc_flows WHERE expires<?", Date.now());
        // Bound to this account and this session: the callback checks both.
        await run(
          "INSERT INTO oidc_flows(id,state,verifier,nonce,expires,return_to,remember,link_user_id,link_session) VALUES(?,?,?,?,?,?,0,?,?)",
          hash(flow),
          state,
          verifier,
          nonce,
          Date.now() + 600000,
          "/",
          user.id,
          hash(jar.get(cookieName)!.value),
        );
        jar.set("flowplan_oidc", flow, { httpOnly: true, secure: appUrl().startsWith("https:"), sameSite: "lax", path: "/", maxAge: 600 });
        const url = oidc.buildAuthorizationUrl(c, {
          redirect_uri: `${appUrl()}/api/auth/callback`,
          scope: process.env.OIDC_SCOPES || "openid profile email groups",
          code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
          code_challenge_method: "S256",
          state,
          nonce,
          // The provider asks who signs in, rather than reusing its session.
          prompt: "login",
        });
        return NextResponse.json({ ok: true, url: url.href });
      }
      // A workspace owner removes a journal PIN nobody knows any more
      // (lib/journal-extras.ts): only after confirming once more.
      if (action === "journal-pin-reset") {
        const { pageId } = z.object({ pageId: z.uuid() }).passthrough().parse(input);
        await confirm();
        const result = await command({ ...user, stepUp: true }, { action: "journal.lock", pageId, pin: null });
        after(dispatchPush);
        return NextResponse.json({ ok: true, ...(result && typeof result === "object" ? result : {}) });
      }
      if (action === "sso-unlink") {
        const { identityId } = z.object({ identityId: z.string().max(80) }).passthrough().parse(input);
        await confirm();
        await removeIdentity(user.id, identityId, locale);
      } else if (action === "password-remove") {
        await confirm();
        await removePassword(user.id, locale);
      } else if (action === "password-set") {
        await confirm();
        await setNewPassword(user.id, (input as { next?: unknown }).next, locale);
      }
      return NextResponse.json({ ok: true, ...(await overview()) });
    }
    // ---- The signed-in person's authenticator app (also while the
    // instance waits for it to be set up) ----
    if (["two-factor", "totp-setup", "totp-confirm", "totp-disable", "totp-recovery", "totp-after-passkey"].includes(action)) {
      const user = await currentUser();
      if (!user || user.demo) throw new HttpError(401, translate(locale)("Bitte melde dich an.", "Please sign in."));
      if (user.apiScope) throw new HttpError(403, translate(locale)("Mit einem API-Token nicht möglich.", "Not possible with an API token."));
      const address = clientAddress(req.headers);
      if (action === "totp-setup") return NextResponse.json(await startTotpSetup(user, locale), { headers: { "Cache-Control": "no-store" } });
      if (action === "totp-confirm") {
        const result = await confirmTotpSetup(user.id, await body(), locale);
        // Turned on: sessions elsewhere (perhaps from a known password) end.
        await endOtherSessions(user.id);
        return NextResponse.json({ ...result, status: await twoFactorStatus(user.id) }, { headers: { "Cache-Control": "no-store" } });
      }
      if (action === "totp-recovery")
        return NextResponse.json({ ...(await regenerateRecoveryCodes(user.id, await body(), address, locale)), status: await twoFactorStatus(user.id) }, { headers: { "Cache-Control": "no-store" } });
      if (action === "totp-after-passkey")
        return NextResponse.json({ status: await setCodeAfterPasskey(user.id, await body(), address, locale) });
      if (action === "totp-disable") return NextResponse.json({ status: await disableTotp(user.id, await body(), address, locale) });
      return NextResponse.json({ status: await twoFactorStatus(user.id) });
    }
    // ---- The signed-in person's password and passkeys ----
    if (["profile", "password-change", "passkey-register-options", "passkey-register", "passkey-delete", "passkeys"].includes(action)) {
      const user = await currentUser();
      if (!user || user.demo) throw new HttpError(401, translate(locale)("Bitte melde dich an.", "Please sign in."));
      // API tokens act for scripts: they never change how the person signs in.
      if (user.apiScope) throw new HttpError(403, translate(locale)("Mit einem API-Token nicht möglich.", "Not possible with an API token."));
      if (action === "profile") await updateLocalProfile(user.id, await body(), locale);
      else if (action === "password-change") {
        await changePassword(user.id, await body(), locale);
        await endOtherSessions(user.id);
      }
      else if (action === "passkey-register-options") {
        const { options, token } = await passkeyRegistrationOptions(user, locale);
        await rememberChallenge(token);
        return NextResponse.json(options);
      } else if (action === "passkey-register")
        await finishPasskeyRegistration(user, await takeChallengeCookie(), await body(), locale);
      else if (action === "passkey-delete") {
        const { id } = (await body()) as { id?: unknown };
        // A removed passkey (perhaps on a lost device) signs nobody in any more.
        if (typeof id === "string" && await deletePasskey(user.id, id)) await endOtherSessions(user.id);
      }
      return NextResponse.json({ ok: true, passkeys: await listPasskeys(user.id) });
    }
    // Deleting one's own account: accounts with a password confirm with it,
    // SSO accounts by typing their e-mail address. The session ends with it.
    if (action === "account-delete") {
      const user = await currentUser();
      if (!user) throw new HttpError(401, translate(locale)("Bitte melde dich an.", "Please sign in."));
      const input = (await body()) as { password?: unknown; confirm?: unknown; successors?: unknown };
      const local = await one<{ email: string }>("SELECT email FROM local_accounts WHERE user_id=?", user.id);
      let confirm = input.confirm;
      if (local && !user.demo && await confirmsWithPassword(user.id)) {
        const { userId } = await passwordLogin({ email: local.email, password: input.password }, clientAddress(req.headers), locale);
        if (userId !== user.id) throw new HttpError(403, translate(locale)("E-Mail-Adresse oder Passwort stimmt nicht.", "E-mail address or password is wrong."));
        confirm = (await one<{ email: string }>("SELECT email FROM users WHERE id=?", user.id))?.email;
      }
      const result = await transaction(async () => await deleteOwnAccount(user, { confirm, successors: input.successors }, !!local && !user.demo && await confirmsWithPassword(user.id)));
      // The Git exports of their spaces ended with the account: their
      // working copies go with them (lib/space-git-export.ts).
      await sweepSpaceGitCopies();
      (await cookies()).delete(cookieName);
      return NextResponse.json(result);
    }
    if (action === "logout") {
      const demoUser = await currentUser();
      if (demoUser?.demo) await endDemo(demoUser.id);
      const jar = await cookies(),
        token = jar.get(cookieName)?.value;
      if (token) await run("DELETE FROM sessions WHERE token=?", hash(token));
      jar.delete(cookieName);
      return NextResponse.json({ ok: true });
    }
    throw new HttpError(404, "Nicht gefunden");
  } catch (e) {
    // Messages of our own go out; anything else stays in the log.
    if (!(e instanceof HttpError) && !(e instanceof z.ZodError)) console.error(e);
    return NextResponse.json(
      { error: e instanceof HttpError ? e.message : e instanceof z.ZodError ? "Ungültige Eingabe." : "Anmeldung fehlgeschlagen. Bitte erneut versuchen." },
      { status: e instanceof HttpError ? e.status : e instanceof z.ZodError ? 400 : 500 },
    );
  }
}
