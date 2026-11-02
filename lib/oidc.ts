import * as oidc from "openid-client";
import { HttpError } from "./auth";
export async function oidcConfig() {
  if (!process.env.OIDC_ISSUER || !process.env.OIDC_CLIENT_ID)
    throw new HttpError(503, "OIDC ist noch nicht konfiguriert.");
  const issuer = new URL(process.env.OIDC_ISSUER);
  const localHttp =
    process.env.NODE_ENV !== "production" &&
    process.env.OIDC_ALLOW_LOCAL_HTTP === "true" &&
    issuer.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(issuer.hostname);
  const config = await oidc.discovery(
    issuer,
    process.env.OIDC_CLIENT_ID,
    process.env.OIDC_CLIENT_SECRET,
    undefined,
    localHttp ? { execute: [oidc.allowInsecureRequests] } : undefined,
  );
  // The ID token's signature is checked against the provider's published
  // keys (JWKS). A provider that signs only with the client secret (HS256 –
  // e.g. Authentik without a signing key) publishes none: its ID token comes
  // straight from the token endpoint over TLS, authenticated with the
  // secret, which OpenID Connect Core 3.1.3.7 accepts in place of the
  // signature check.
  if (!symmetricOnly(config.serverMetadata().id_token_signing_alg_values_supported))
    oidc.enableNonRepudiationChecks(config);
  return config;
}
export const symmetricOnly = (algs: unknown) =>
  Array.isArray(algs) && algs.length > 0 && algs.every((alg) => typeof alg === "string" && alg.startsWith("HS"));

// Why a sign-in failed, for the server log: the error's kind and code and,
// from the provider, its error and description – never tokens or secrets.
export function oidcFailure(e: unknown) {
  if (!(e instanceof Error)) return "Error";
  const extra = e as Error & { code?: unknown; error?: unknown; error_description?: unknown };
  // openid-client wraps the reason (e.g. an unexpected "alg") in its cause.
  const cause = extra.cause instanceof Error ? (extra.cause as Error & { code?: unknown }) : undefined;
  return [e.name, extra.code, e.message, extra.error, extra.error_description, cause?.code, cause?.message]
    .filter((part, i, all) => typeof part === "string" && part && all.indexOf(part) === i)
    .join(" – ")
    .slice(0, 500);
}
