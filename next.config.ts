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
  // No "X-Powered-By: Next.js": visitors learn nothing about the stack (#41).
  poweredByHeader: false,
  env: {
    FLOWPLAN_VERSION: pkg.version,
    FLOWPLAN_COMMIT: gitCommit(),
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
  turbopack: { root: process.cwd() },
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
  serverExternalPackages: ["node:sqlite", "pdfjs-dist", "tesseract.js", "ssh2", "pg", "yjs"],
  // The PDF text worker loads pdf.js and its worker module at runtime.
  outputFileTracingIncludes: {
    "/*": [
      "./node_modules/pdfjs-dist/legacy/build/*.mjs",
      // OCR: worker script, WebAssembly core and bundled language data.
      "./node_modules/tesseract.js/src/**/*",
      // Only the LSTM cores (lib/ocr.ts asks for OEM 1) as .js and .wasm;
      // the *.wasm.js copies are the browser's.
      "./node_modules/tesseract.js-core/index.js",
      "./node_modules/tesseract.js-core/tesseract-core-lstm.{js,wasm}",
      "./node_modules/tesseract.js-core/tesseract-core-simd-lstm.{js,wasm}",
      "./node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.{js,wasm}",
      "./node_modules/@tesseract.js-data/deu/**/*",
      "./node_modules/@tesseract.js-data/eng/**/*",
      "./node_modules/@tesseract.js-data/fra/**/*",
      "./node_modules/@tesseract.js-data/chi_sim/**/*",
      "./node_modules/bmp-js/**/*",
      "./node_modules/wasm-feature-detect/**/*",
      "./node_modules/zlibjs/**/*",
      "./node_modules/idb-keyval/**/*",
      // PDF viewer in the browser: fonts, character maps and decoders.
      "./node_modules/pdfjs-dist/cmaps/*",
      "./node_modules/pdfjs-dist/standard_fonts/*",
      "./node_modules/pdfjs-dist/wasm/*",
      // Typst preview of code blocks (app/typst): WebAssembly and fonts.
      "./node_modules/@myriaddreamin/typst-ts-web-compiler/pkg/*.wasm",
      "./node_modules/@myriaddreamin/typst-ts-renderer/pkg/*.wasm",
      "./node_modules/@typst-wasm/fonts/dist/files/LibertinusSerif-*.otf",
      "./node_modules/@typst-wasm/fonts/dist/files/NewCMMath-Regular.otf",
      "./node_modules/@typst-wasm/fonts/dist/files/DejaVuSansMono*.ttf",
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
    ];
  },
};
export default config;
