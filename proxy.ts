import { NextResponse, type NextRequest } from "next/server";

// Content Security Policy for every page. Scripts run only with the nonce
// of this request (Next.js adds it to its own scripts), so an injected
// script tag does nothing even if it slips past the HTML cleaning. Styles
// stay 'unsafe-inline' (the editor, KaTeX and Mermaid set inline styles);
// images may come from any HTTPS address (pasted pictures, link cards);
// frames only from the supported embed players.
const players = [
  "https://www.youtube-nocookie.com",
  "https://player.vimeo.com",
  "https://www.loom.com",
  "https://open.spotify.com",
  "https://www.figma.com",
  "https://codepen.io",
];

export function contentSecurityPolicy(nonce: string | null, dev: boolean) {
  const scripts = nonce
    ? `'self' 'nonce-${nonce}' 'strict-dynamic'`
    : // Static pages without user content (documentation) have no nonce.
      "'self' 'unsafe-inline'";
  return [
    "default-src 'self'",
    `script-src ${scripts}${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    "font-src 'self' data:",
    `connect-src 'self'${dev ? " ws: wss:" : ""}`,
    `frame-src 'self' ${players.join(" ")}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    ...(dev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

export function proxy(request: NextRequest) {
  const dev = process.env.NODE_ENV === "development";
  const staticPage = request.nextUrl.pathname.startsWith("/docs");
  const nonce = staticPage ? null : Buffer.from(crypto.randomUUID()).toString("base64");
  const policy = contentSecurityPolicy(nonce, dev);
  const headers = new Headers(request.headers);
  if (nonce) headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  matcher: [
    {
      // Pages only: API answers, build files, icons and fonts need no policy.
      source:
        "/((?!api/|_next/static|_next/image|fonts/|icons/|sw\\.js|fonts\\.css|manifest\\.webmanifest|icon\\.svg|favicon\\.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
