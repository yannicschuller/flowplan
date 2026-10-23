// What an instance tells people without a session about itself (issue #41):
// the API description only to signed-in people and API tokens unless
// FLOWPLAN_PUBLIC_API_DOCS=true, never the exact version to visitors, and
// the health check without internal details.
import type { Identity } from "./types";

export const publicApiDocs = () => process.env.FLOWPLAN_PUBLIC_API_DOCS === "true";

// Who may read /api/openapi.json and /api/docs: everyone on instances that
// opted in, otherwise a signed-in person (session or API token) who does not
// still have to set up the second factor.
export function apiDocsAllowed(identity: Identity | null) {
  return publicApiDocs() || (!!identity && !identity.twoFactorSetup);
}

// The version for the API description: exact for signed-in people, only the
// major version ("0.x") for visitors, so an anonymous reader cannot tell
// which release (and which fixes) runs here.
export function disclosedVersion(version: string, signedIn: boolean) {
  if (!version) return "dev";
  if (signedIn) return version;
  const major = /^(\d+)\./.exec(version)?.[1];
  return major ? `${major}.x` : "unknown";
}
