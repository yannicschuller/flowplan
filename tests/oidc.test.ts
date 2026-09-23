import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import * as oidc from "openid-client";
import { oidcConfig } from "../lib/oidc";
import { extractGroups } from "../lib/auth";
test("OIDC discovery, PKCE, signed ID token and nonce verification", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = {
    ...publicKey.export({ format: "jwk" }),
    kid: "test-key",
    use: "sig",
    alg: "RS256",
  };
  let issuer = "",
    nonce = "",
    challenge = "",
    badSignature = false;
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/.well-known/openid-configuration") {
      res.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: issuer + "/authorize",
          token_endpoint: issuer + "/token",
          jwks_uri: issuer + "/jwks",
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["client_secret_post"],
          code_challenge_methods_supported: ["S256"],
        }),
      );
    } else if (req.url === "/jwks") res.end(JSON.stringify({ keys: [jwk] }));
    else if (req.url === "/token") {
      let text = "";
      for await (const chunk of req) text += chunk;
      const body = new URLSearchParams(text);
      assert.equal(body.get("client_id"), "flowplan-test");
      assert.equal(body.get("client_secret"), "test-only-secret");
      if (
        createHash("sha256")
          .update(body.get("code_verifier") || "")
          .digest("base64url") !== challenge
      ) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      const now = Math.floor(Date.now() / 1000),
        claims = {
          iss: issuer,
          sub: "test-user",
          aud: "flowplan-test",
          iat: now,
          exp: now + 300,
          nonce,
          groups: ["flowplan-admins"],
          name: "Test Admin",
          email: "admin@example.test",
          email_verified: true,
        };
      const data =
        Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key" })).toString(
          "base64url",
        ) +
        "." +
        Buffer.from(JSON.stringify(claims)).toString("base64url");
      const sig = badSignature
        ? Buffer.alloc(256).toString("base64url")
        : sign("RSA-SHA256", Buffer.from(data), privateKey).toString(
            "base64url",
          );
      res.end(
        JSON.stringify({
          access_token: "test-access",
          token_type: "Bearer",
          id_token: data + "." + sig,
        }),
      );
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  issuer = `http://127.0.0.1:${address.port}`;
  process.env.OIDC_ISSUER = issuer;
  process.env.OIDC_CLIENT_ID = "flowplan-test";
  process.env.OIDC_CLIENT_SECRET = "test-only-secret";
  process.env.OIDC_ALLOW_LOCAL_HTTP = "true";
  try {
    const c = await oidcConfig(),
      verifier = oidc.randomPKCECodeVerifier(),
      state = oidc.randomState();
    nonce = oidc.randomNonce();
    challenge = await oidc.calculatePKCECodeChallenge(verifier);
    const url = oidc.buildAuthorizationUrl(c, {
      redirect_uri: "http://localhost/callback",
      scope: "openid groups",
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    assert.equal(url.searchParams.get("code_challenge"), challenge);
    const callback = new URL(
      `http://localhost/callback?code=test&state=${state}`,
    );
    const tokens = await oidc.authorizationCodeGrant(c, callback, {
      pkceCodeVerifier: verifier,
      expectedState: state,
      expectedNonce: nonce,
      idTokenExpected: true,
    });
    assert.deepEqual(extractGroups(tokens.claims()!), ["flowplan-admins"]);
    await assert.rejects(() =>
      oidc.authorizationCodeGrant(c, callback, {
        pkceCodeVerifier: verifier,
        expectedState: "wrong",
        expectedNonce: nonce,
        idTokenExpected: true,
      }),
    );
    await assert.rejects(() =>
      oidc.authorizationCodeGrant(c, callback, {
        pkceCodeVerifier: verifier,
        expectedState: state,
        expectedNonce: "wrong",
        idTokenExpected: true,
      }),
    );
    badSignature = true;
    await assert.rejects(() =>
      oidc.authorizationCodeGrant(c, callback, {
        pkceCodeVerifier: verifier,
        expectedState: state,
        expectedNonce: nonce,
        idTokenExpected: true,
      }),
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
