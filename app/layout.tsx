import type { Metadata, Viewport } from "next";
import "./globals.css";
import "katex/dist/katex.min.css";
import { requestLocale } from "@/lib/i18n-server";
import { LocaleProvider } from "@/components/i18n";
import { PdfViewerHost } from "@/components/pdf-viewer";
export async function generateMetadata(): Promise<Metadata> {
  const de = (await requestLocale()) === "de";
  return {
  title: de ? "Flowplan — Dein Raum für Ideen" : "Flowplan — Room for your ideas",
  description: de
    ? "Wissen, Notizen und Projekte. Gemeinsam an einem Ort."
    : "Knowledge, notes and projects. Together in one place.",
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
  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
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
