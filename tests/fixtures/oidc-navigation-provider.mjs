// Local integration fixture only. Never use this provider outside automated tests.
import { createServer } from "node:http";
import { generateKeyPairSync, randomUUID, createHash, sign } from "node:crypto";
import { writeFileSync } from "node:fs";
const output = process.argv[2];
if (!output?.startsWith("/tmp/flowplan-oidc-navigation."))
  throw new Error(
    "Use an isolated /tmp/flowplan-oidc-navigation.* output file.",
  );
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const jwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: "navigation-test",
  use: "sig",
  alg: "RS256",
};
const codes = new Map();
let issuer = "";
const server = createServer(async (req, res) => {
  const url = new URL(req.url, issuer);
  res.setHeader("Content-Type", "application/json");
  if (url.pathname === "/.well-known/openid-configuration")
    return res.end(
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
  if (url.pathname === "/jwks") return res.end(JSON.stringify({ keys: [jwk] }));
  if (url.pathname === "/authorize") {
    const redirect = url.searchParams.get("redirect_uri");
    if (
      redirect !== "http://127.0.0.1:3000/api/auth/callback" ||
      url.searchParams.get("client_id") !== "navigation-test" ||
      url.searchParams.get("code_challenge_method") !== "S256"
    ) {
      res.statusCode = 400;
      return res.end("{}");
    }
    const code = randomUUID();
    codes.set(code, {
      nonce: url.searchParams.get("nonce"),
      challenge: url.searchParams.get("code_challenge"),
      expires: Date.now() + 60000,
    });
    const dest = new URL(redirect);
    dest.searchParams.set("code", code);
    dest.searchParams.set("state", url.searchParams.get("state") || "");
    res.writeHead(302, { Location: dest.href });
    return res.end();
  }
  if (url.pathname === "/token" && req.method === "POST") {
    let raw = "";
    for await (const part of req) raw += part;
    const form = new URLSearchParams(raw),
      data = codes.get(form.get("code"));
    codes.delete(form.get("code"));
    if (
      !data ||
      data.expires < Date.now() ||
      form.get("client_id") !== "navigation-test" ||
      form.get("client_secret") !== "fixture-only-secret" ||
      createHash("sha256")
        .update(form.get("code_verifier") || "")
        .digest("base64url") !== data.challenge
    ) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "invalid_grant" }));
    }
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: issuer,
      sub: "navigation-user",
      aud: "navigation-test",
      iat: now,
      exp: now + 300,
      nonce: data.nonce,
      name: "OIDC Navigation",
      email: "navigation@example.test",
      email_verified: true,
      groups: ["flowplan-admins"],
    };
    const jwt =
      Buffer.from(JSON.stringify({ alg: "RS256", kid: jwk.kid })).toString(
        "base64url",
      ) +
      "." +
      Buffer.from(JSON.stringify(claims)).toString("base64url");
    return res.end(
      JSON.stringify({
        access_token: randomUUID(),
        token_type: "Bearer",
        id_token:
          jwt +
          "." +
          sign("RSA-SHA256", Buffer.from(jwt), privateKey).toString(
            "base64url",
          ),
      }),
    );
  }
  res.statusCode = 404;
  res.end("{}");
});
server.listen(0, "127.0.0.1", () => {
  issuer = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(output, issuer);
  console.log(issuer);
});
process.on("SIGINT", () => server.close(() => process.exit(0)));
