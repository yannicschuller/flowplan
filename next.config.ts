import type { NextConfig } from "next";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

// What is running, shown in the administration: the version from
// package.json and the commit – from the build (GIT_COMMIT in our Docker
// workflow, SOURCE_COMMIT in Coolify) or from the checkout.
function gitCommit() {
  const given = process.env.GIT_COMMIT || process.env.SOURCE_COMMIT;
  if (given) return given;
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}
const pkg = JSON.parse(readFileSync("./package.json", "utf8")) as { version: string };

// Next.js's skew protection (deploymentId): during a rolling update a page
// of one version may reach an instance of another. With an id, Next.js
// adds ?dpl=<id> to the app's file addresses (past caches on the way),
// sends it with client-side navigations and reloads the page instead of
// navigating when the server's id differs. It must be the same for every
// instance of one image, so it is fixed at build time:
// FLOWPLAN_DEPLOYMENT_ID (build argument of the Dockerfile; "off": none),
// else NEXT_DEPLOYMENT_ID, else v<version>-<commit> when the commit is
// known (GIT_COMMIT/SOURCE_COMMIT or the checkout), else none. Not for the
// development server. Next.js does not route by it: a file an instance does
// not have is still a 404 – Flowplan's own check of the build (X-Flowplan-
// Build, lib/stale-copy.ts) heals such a page.
function deploymentId(): string | undefined {
  if (process.env.NODE_ENV === "development") return undefined;
  const given = (process.env.FLOWPLAN_DEPLOYMENT_ID || process.env.NEXT_DEPLOYMENT_ID || "").trim();
  if (given.toLowerCase() === "off") return undefined;
  const commit = gitCommit().trim().slice(0, 12);
  const id = given || (commit ? `v${pkg.version}-${commit}` : "");
  return id ? id.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64) : undefined;
}
const deployment = deploymentId();

// The browser specs' build (lib/e2e-build.ts, scripts/build-e2e.mjs) takes
// the demo sign-in. Never in an image: every image build sets
// FLOWPLAN_CHANNEL (docker.yml), and the two together stop the build.
const e2eBuild = process.env.FLOWPLAN_E2E_BUILD === "1";
if (e2eBuild && process.env.FLOWPLAN_CHANNEL)
  throw new Error("FLOWPLAN_E2E_BUILD=1 is for the browser specs' build only, not for an image (FLOWPLAN_CHANNEL is set).");

const config: NextConfig = {
  // The CI checks types; image builds there set FLOWPLAN_SKIP_TYPECHECK=1 so
  // the check does not run again per architecture.
  typescript: { ignoreBuildErrors: process.env.FLOWPLAN_SKIP_TYPECHECK === "1" },
  output: "standalone",
  ...(deployment
    ? {
        deploymentId: deployment,
        // With a deployment id Next.js would name every build alike
        // ("build-…" constant); the stale-copy check (lib/stale-copy.ts,
        // lib/offline-assets-server.ts) tells builds apart by BUILD_ID, so
        // each build keeps a random one of its own (null: Next.js's default).
        generateBuildId: async () => null,
      }
    : {}),
  // No "X-Powered-By: Next.js": visitors learn nothing about the stack (#41).
  poweredByHeader: false,
  env: {
    FLOWPLAN_VERSION: pkg.version,
    FLOWPLAN_COMMIT: gitCommit(),
    // The deployment id above ("" without one): the offline copy's file list
    // names the app's files as the page asks for them (lib/offline-assets-server.ts).
    FLOWPLAN_DEPLOYMENT_ID: deployment || "",
    FLOWPLAN_BUILT_AT: new Date().toISOString(),
    // "beta" or "release" from the image build (Settings → Über Flowplan).
    FLOWPLAN_CHANNEL: process.env.FLOWPLAN_CHANNEL || "",
    // Always defined, also as "" – then the server's code holds the literal,
    // not a lookup of the variable at runtime (lib/e2e-build.ts).
    FLOWPLAN_E2E_BUILD: e2eBuild ? "1" : "",
  },
  // A second development server (e.g. for isolated browser tests) needs its
  // own build directory.
  ...(process.env.FLOWPLAN_DIST_DIR
    ? { distDir: process.env.FLOWPLAN_DIST_DIR }
    : {}),
  turbopack: {
    root: process.cwd(),
    rules: {
      // Icons only in the weights the app draws (scripts/icon-weights-loader.cjs):
      // thin and light are never used, about a third of every icon's paths.
      "*.es.js": {
        condition: { path: /node_modules\/@phosphor-icons\/react\/dist\/defs\// },
        loaders: ["./scripts/icon-weights-loader.cjs"],
      },
    },
  },
  // Server chunks for dynamic imports (await import(…) in lib/, the
  // workers of instrumentation.ts …) leave out what the importing code has
  // already loaded. Without it, every such import got its own copy of what
  // it shares with the rest – the core (database, permissions, rate limits,
  // about 1.2 MB) was in the image dozens of times (with the one API route,
  // app/api/[...path]/route.ts: 34 copies instead of 77). The browser's
  // chunks do this by default.
  experimental: { turbopackServerSideNestedAsyncChunking: true },
  // next/image is not used: no image optimisation on the server, so sharp
  // (and its native builds for glibc and musl, @img/*) stays out.
  images: { unoptimized: true },
  // CalDAV collections end in "/"; proxy.ts redirects pages itself.
  skipTrailingSlashRedirect: true,
  // ssh2 (SFTP backups, lib/sftp.ts) loads its optional native helpers at
  // runtime and falls back to JavaScript when they are missing.
  // pg (DATABASE_URL=postgres://…, lib/db-driver) loads its optional native
  // binding at runtime and falls back to JavaScript.
  // yjs: bundled, every server layer (instrumentation and its workers, route
  // handlers, server components, server rendering) evaluated its own copy –
  // "Yjs was already imported" in the log, and a Y.Doc of one copy fails the
  // constructor checks of another (#194). External, Node.js loads it once.
  // Large packages that many route handlers share: bundled, each server
  // chunk that reached them held its own copy (pdf-lib 250 KB in 86 chunks,
  // happy-dom 1 MB in 28, the emoji data 900 KB in 86 …) – the build, the
  // image and every process's memory paid for each. External, Node.js
  // loads them once from node_modules (and like yjs they exist only once).
  serverExternalPackages: [
    "node:sqlite",
    "pdfjs-dist",
    "tesseract.js",
    "ssh2",
    "pg",
    "yjs",
    "pdf-lib",
    "happy-dom",
    "@simplewebauthn/server",
    "isomorphic-git",
    "emojibase-data",
  ],
  // The PDF text worker loads pdf.js and its worker module at runtime (not
  // their minified twins or the scripting sandbox; an include here is kept
  // even where an exclude below matches it).
  outputFileTracingIncludes: {
    "/*": [
      "./node_modules/pdfjs-dist/legacy/build/{pdf,pdf.worker}.mjs",
      // Its worker thread (lib/pdf-text.ts), plain JavaScript run as it is.
      "./lib/workers/*.mjs",
      // OCR: worker script, WebAssembly core and bundled language data.
      "./node_modules/tesseract.js/src/**/*",
      // Only the LSTM cores (lib/ocr.ts asks for OEM 1) as .js and .wasm;
      // the *.wasm.js copies are the browser's.
      "./node_modules/tesseract.js-core/index.js",
      "./node_modules/tesseract.js-core/tesseract-core-lstm.{js,wasm}",
      "./node_modules/tesseract.js-core/tesseract-core-simd-lstm.{js,wasm}",
      "./node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.{js,wasm}",
      // The language data lib/ocr.ts copies (4.0.0, not 4.0.0_best_int).
      "./node_modules/@tesseract.js-data/deu/4.0.0/*",
      "./node_modules/@tesseract.js-data/eng/4.0.0/*",
      "./node_modules/@tesseract.js-data/fra/4.0.0/*",
      "./node_modules/@tesseract.js-data/chi_sim/4.0.0/*",
      // zlibjs and idb-keyval are only for tesseract.js's browser worker;
      // in Node.js it unpacks with zlib and caches in files.
      "./node_modules/bmp-js/**/*",
      "./node_modules/wasm-feature-detect/**/*",
      // PDF viewer in the browser: fonts, character maps and decoders.
      "./node_modules/pdfjs-dist/cmaps/*",
      "./node_modules/pdfjs-dist/standard_fonts/*",
      "./node_modules/pdfjs-dist/wasm/*",
      // The 3D viewer's CAD reader for STEP and IGES (app/occt, #384).
      "./node_modules/occt-import-js/dist/occt-import-js.wasm",
      // The drawing viewer's DWG reader (app/libredwg, LibreDWG, GPL-3.0).
      "./node_modules/@mlightcad/libredwg-web/dist/libredwg-web.js",
      "./node_modules/@mlightcad/libredwg-web/wasm/libredwg-web.{js,wasm}",
      // Typst preview of code blocks (app/typst): WebAssembly and fonts.
      "./node_modules/@myriaddreamin/typst-ts-web-compiler/pkg/*.wasm",
      "./node_modules/@myriaddreamin/typst-ts-renderer/pkg/*.wasm",
      "./node_modules/@typst-wasm/fonts/dist/files/LibertinusSerif-*.otf",
      "./node_modules/@typst-wasm/fonts/dist/files/NewCMMath-Regular.otf",
      "./node_modules/@typst-wasm/fonts/dist/files/DejaVuSansMono*.ttf",
      // The PostgreSQL schema, read from its file (lib/db-driver/pg-schema-file.ts).
      "./lib/db-driver/postgres-schema.json",
      // The curated release notes for "Neu in Flowplan" (#223, lib/release-notes.ts).
      "./release-notes/*.json",
    ],
  },
  // What the tracing finds but the server never loads: sharp (see
  // `images`; "next-server" is Next.js's own server), the tesseract cores
  // without LSTM and the browser's copies, pdf.js's modern build and its
  // viewer (the server uses legacy/build), and the sources and the data
  // folder of the checkout (file access with a runtime path makes the
  // tracing take whole folders; the server runs the compiled chunks and its
  // own FLOWPLAN_DATA_DIR).
  outputFileTracingExcludes: {
    "next-server": ["**/node_modules/sharp/**/*", "**/node_modules/@img/**/*"],
    "/*": [
      "./lib/**/*.{ts,tsx}",
      "./components/**/*",
      "./app/**/*.{ts,tsx}",
      "./tests/**/*",
      "./docs/**/*",
      "./data/**/*",
      "./node_modules/sharp/**/*",
      "./node_modules/@img/**/*",
      "./node_modules/tesseract.js-core/tesseract-core.{js,wasm}",
      "./node_modules/tesseract.js-core/tesseract-core-simd.{js,wasm}",
      "./node_modules/tesseract.js-core/tesseract-core-relaxedsimd.{js,wasm}",
      "./node_modules/tesseract.js-core/*.wasm.js",
      "./node_modules/pdfjs-dist/build/**/*",
      "./node_modules/pdfjs-dist/web/**/*",
      "./node_modules/pdfjs-dist/legacy/web/**/*",
      "./node_modules/pdfjs-dist/**/*.map",
      // pdf.js on the server loads legacy/build/pdf.mjs and its worker
      // pdf.worker.mjs only: not the minified twins, the scripting sandbox
      // or the image decoders (the browser's copy comes from the build).
      "./node_modules/pdfjs-dist/legacy/build/*.min.mjs",
      "./node_modules/pdfjs-dist/legacy/build/pdf.sandbox.mjs",
      "./node_modules/pdfjs-dist/legacy/image_decoders/**/*",
      "./node_modules/pdfjs-dist/image_decoders/**/*",
      // Unused OCR files: the other model of the language data (lib/ocr.ts
      // reads 4.0.0) and the browser worker's helpers (see above).
      "./node_modules/@tesseract.js-data/*/4.0.0_best_int/**/*",
      "./node_modules/zlibjs/**/*",
      "./node_modules/idb-keyval/**/*",
    ],
  },
  // The documentation is its own site (github.com/yannicschuller/flowplan-docs).
  async redirects() {
    return [
      { source: "/docs", destination: "https://docs.flowplan.org", permanent: true },
      { source: "/docs/:slug*", destination: "https://docs.flowplan.org/:slug*", permanent: true },
    ];
  },
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "private, no-store" }],
      },
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
        ],
      },
      // The HTML preview (#398, lib/html-preview.ts) sends no referrer at
      // all; a later rule wins over the one above (a route's own header
      // would not).
      ...["/api/files/:id/html", "/api/share/:token/files/:fileId/html"].map((source) => ({
        source,
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      })),
      // Live streams (text/event-stream) stay uncompressed: "no-transform"
      // keeps Next's gzip off them. The rule for /api above replaces the
      // routes' own "no-cache, no-transform"; compressed, every event cost a
      // zlib write and flush per stream, and under load updates queued
      // behind cursor events (#383). Some of these paths also answer as
      // JSON, which is never stored either.
      ...[
        "/api/live",
        "/api/documents/live",
        "/api/whiteboards/:id/cursors",
        "/api/share/:token/live",
        "/api/share/:token/board",
      ].map((source) => ({
        source,
        headers: [{ key: "Cache-Control", value: "private, no-store, no-transform" }],
      })),
    ];
  },
};
export default config;
