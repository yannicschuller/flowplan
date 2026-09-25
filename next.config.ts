import type { NextConfig } from "next";
const config: NextConfig = {
  output: "standalone",
  // A second development server (e.g. for isolated browser tests) needs its
  // own build directory.
  ...(process.env.FLOWPLAN_DIST_DIR
    ? { distDir: process.env.FLOWPLAN_DIST_DIR }
    : {}),
  turbopack: { root: process.cwd() },
  serverExternalPackages: ["node:sqlite", "pdfjs-dist", "tesseract.js"],
  // The PDF text worker loads pdf.js and its worker module at runtime.
  outputFileTracingIncludes: {
    "/*": [
      "./node_modules/pdfjs-dist/legacy/build/*.mjs",
      // OCR: worker script, WebAssembly core and bundled language data.
      "./node_modules/tesseract.js/src/**/*",
      "./node_modules/tesseract.js-core/*.js",
      "./node_modules/tesseract.js-core/*.wasm",
      "./node_modules/@tesseract.js-data/deu/**/*",
      "./node_modules/@tesseract.js-data/eng/**/*",
      "./node_modules/bmp-js/**/*",
      "./node_modules/wasm-feature-detect/**/*",
      "./node_modules/zlibjs/**/*",
      "./node_modules/idb-keyval/**/*",
    ],
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
