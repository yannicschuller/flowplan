// A failing endpoint for the browser specs of the error details
// (tests/browser/error-details.spec.ts): GET /api/e2e/fail?kind=caught
// answers 500 from a route handler's `catch`, ?kind=uncaught throws past it
// (Next.js answers 500 and reports it to onRequestError). Only in the specs'
// build (lib/e2e-build.ts): the catch-all route calls this under
// `if (e2eBuild)`, a constant `false` in every other build, so the code is
// not in an image; and at runtime only with FLOWPLAN_E2E_DEMO=1.
import { demoSignInAllowed } from "./e2e-build";

export class E2eTestFailure extends Error {
  name = "E2eTestFailure";
}
// The message holds an e-mail and a token on purpose: the spec checks that
// neither is kept.
export function e2eFailure(path: string[], url: URL): "caught" | "uncaught" | null {
  if (path.length !== 2 || path[0] !== "e2e" || path[1] !== "fail" || !demoSignInAllowed()) return null;
  return url.searchParams.get("kind") === "uncaught" ? "uncaught" : "caught";
}
export function failForE2e(): never {
  throw new E2eTestFailure("E2E test failure for e2e-person@example.com with token=e2eSecretValue123");
}
