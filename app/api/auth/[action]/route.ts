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
  HttpError,
} from "@/lib/auth";
import { one, run } from "@/lib/db";
import { ensureWorkspace } from "@/lib/seed";
export const runtime = "nodejs";
import { oidcConfig as config } from "@/lib/oidc";
export async function GET(
  req: Request,
  { params }: { params: Promise<{ action: string }> },
) {
  const { action } = await params;
  let returnTo = "/";
  try {
    if (action === "login") {
      returnTo = loginReturnPath(new URL(req.url).searchParams.get("returnTo"));
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
        }),
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
    if (action === "logout") {
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
