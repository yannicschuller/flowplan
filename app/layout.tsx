import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./mobile-ux.css";
import "./whiteboard-board.css";
import "katex/dist/katex.min.css";
import { requestLocale } from "@/lib/i18n-server";
import { localeTag, translate } from "@/lib/i18n";
import { siteUrl } from "@/lib/seo";
import { LocaleProvider } from "@/components/i18n";
import { PdfViewerHost } from "@/components/pdf-viewer";
import { headers } from "next/headers";
import { THEME_SCRIPT } from "@/lib/theme";
export async function generateMetadata(): Promise<Metadata> {
  const locale = await requestLocale();
  const say = translate(locale);
  const title = say("Flowplan — Dein Raum für Ideen", "Flowplan — Room for your ideas");
  const description = say("Flowplan: Dokumente, Datenbanken, Whiteboards und Journal in einem Arbeitsbereich. Open Source, ohne Tracking.", "Flowplan: documents, databases, whiteboards and a journal in one workspace. Open source, without tracking.");
  return {
  metadataBase: new URL(siteUrl()),
  title,
  description,
  applicationName: "Flowplan",
  // Workspaces are private; the public pages switch indexing on.
  robots: { index: false, follow: false },
  openGraph: {
    type: "website",
    siteName: "Flowplan",
    title,
    description,
    locale: localeTag(locale).replace("-", "_"),
    images: [{ url: "/opengraph-image", width: 1200, height: 630, alt: "Flowplan" }],
  },
  twitter: { card: "summary_large_image", title, description, images: ["/opengraph-image"] },
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Flowplan", statusBarStyle: "default" },
  other: { "apple-mobile-web-app-capable": "yes" },
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icons/icon-192.png", type: "image/png", sizes: "192x192" },
    ],
    apple: "/icons/apple-touch-icon.png",
  },
};
}
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Edge to edge on phones: the page keeps clear of the system bars itself
  // (safe areas in globals.css), the iOS app shows it full screen.
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fcfbf8" },
    { media: "(prefers-color-scheme: dark)", color: "#16151b" },
  ],
};
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale = await requestLocale();
  // The page's own scripts carry the nonce of the Content Security Policy (proxy.ts).
  const nonce = (await headers()).get("x-nonce") || undefined;
  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        {/* Light or dark before the first paint (lib/theme.ts). */}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <link
          rel="preload"
          href="/fonts/instrument-sans-latin-standard-normal.woff2"
          as="font"
          type="font/woff2"
          crossOrigin=""
        />
        <link rel="stylesheet" href="/fonts.css" />
      </head>
      <body>
        <LocaleProvider locale={locale}>
          {children}
          <PdfViewerHost />
        </LocaleProvider>
      </body>
    </html>
  );
}
