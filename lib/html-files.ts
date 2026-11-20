// HTML files (#398): an uploaded .html/.htm file opens in a sandboxed
// preview (components/html-viewer.tsx) – no scripts (unless run on
// request, isolated), no forms, nothing loaded from elsewhere. Shared by the browser and the server
// (lib/html-preview.ts); nothing here reads a file.

// Larger files are only downloaded. The default; FLOWPLAN_HTML_PREVIEW_MB
// changes it on the server (lib/html-preview.ts htmlPreviewLimit()).
export const HTML_PREVIEW_LIMIT = 5 * 1024 * 1024;

// By the name only: HTML uploads are stored as plain downloads
// (lib/upload-safety.ts never keeps a type a browser would render).
export const isHtmlName = (name: string) => /\.html?$/i.test(name.trim());

// The preview's address next to a file's own (/api/files/<id> and the
// published /api/share/<token>/files/<id>).
export const htmlPreviewUrl = (src: string) => `${src}/html`;
