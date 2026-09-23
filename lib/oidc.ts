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
  return oidc.discovery(
    issuer,
    process.env.OIDC_CLIENT_ID,
    process.env.OIDC_CLIENT_SECRET,
    undefined,
    {
      execute: localHttp
        ? [oidc.allowInsecureRequests, oidc.enableNonRepudiationChecks]
        : [oidc.enableNonRepudiationChecks],
    },
  );
}
