// The build for the browser specs (tests/browser, scripts/build-e2e.mjs,
// .github/workflows/browser.yml): a production build whose server still
// takes the development demo sign-in (POST /api/auth/demo), which every spec
// signs in with. Production refuses it (403, asserted by check:standalone).
//
// Two keys, both needed:
//
// 1. A build-time constant. next.config.ts always defines
//    FLOWPLAN_E2E_BUILD in its `env`, so Next.js replaces
//    `process.env.FLOWPLAN_E2E_BUILD` below with a string literal while
//    bundling: "1" only when the build itself ran with FLOWPLAN_E2E_BUILD=1
//    (scripts/build-e2e.mjs), "" in every other build. In a normal build
//    `e2eBuild` is the constant `false` – there is no lookup of the variable
//    left in the server's code, so setting it on a running server (a Docker
//    image's environment, an .env file) changes nothing. The Dockerfile
//    builds with the variable emptied (`FLOWPLAN_E2E_BUILD= npm run build`)
//    and next.config.ts refuses the switch together with FLOWPLAN_CHANNEL
//    (set by every image build in docker.yml); tests/e2e-build.test.ts
//    holds both in place.
// 2. A runtime opt-in, FLOWPLAN_E2E_DEMO=1, which only the specs' servers
//    get (playwright.config.ts). The specs' build is uploaded as a workflow
//    artifact; started by hand without it, it refuses the demo sign-in like
//    any production server.
//
// Outside production (`next dev`, the unit tests) the demo sign-in stays as
// it was.
export const e2eBuild = process.env.FLOWPLAN_E2E_BUILD === "1";

export function demoSignInAllowed() {
  if (process.env.NODE_ENV !== "production") return true;
  return e2eBuild && process.env.FLOWPLAN_E2E_DEMO === "1";
}
