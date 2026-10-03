import type { NextConfig } from "next";

const renamedDocs = [
  ["anmeldung-oidc", "sign-in"],
  ["ansichten", "views"],
  ["api-und-webhooks", "api-and-webhooks"],
  ["arbeitsbereiche-und-rechte", "workspaces-and-permissions"],
  ["betrieb", "operations"],
  ["coolify-und-proxy", "coolify-and-proxy"],
  ["datenbanken", "databases"],
  ["dokumente", "documents"],
  ["eigenschaften-und-formeln", "properties-and-formulas"],
  ["erste-schritte", "first-steps"],
  ["formulare", "forms"],
  ["import-export-versionen", "import-export-versions"],
  ["konfiguration", "configuration"],
  ["offline-und-apps", "offline-and-apps"],
  ["seiten-und-bereiche", "pages-and-spaces"],
  ["speicher-und-sicherung", "storage-and-backups"],
  ["suche-und-benachrichtigungen", "search-and-notifications"],
  ["tastenkuerzel", "keyboard-shortcuts"],
  ["teilen", "sharing"],
  ["vorlagen", "templates"],
  ["zusammenarbeit", "collaboration"],
];
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
      // Documentation pages (/docs) are read from Markdown files.
      "./content/docs/**/*.md",
      // PDF viewer in the browser: fonts, character maps and decoders.
      "./node_modules/pdfjs-dist/cmaps/*",
      "./node_modules/pdfjs-dist/standard_fonts/*",
      "./node_modules/pdfjs-dist/wasm/*",
    ],
  },
  // The docs moved to English addresses; old links keep working.
  async redirects() {
    return renamedDocs.map(([from, to]) => ({
      source: `/docs/${from}`,
      destination: `/docs/${to}`,
      permanent: true,
    }));
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
