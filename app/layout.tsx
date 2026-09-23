import type { Metadata, Viewport } from "next";
import "./globals.css";
import "katex/dist/katex.min.css";
export const metadata: Metadata = {
  title: "Flowplan — Dein Raum für Ideen",
  description: "Wissen, Notizen und Projekte. Gemeinsam an einem Ort.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Flowplan", statusBarStyle: "default" },
  other: { "apple-mobile-web-app-capable": "yes" },
  icons: { apple: "/icons/apple-touch-icon.png" },
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#ffffff",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="de" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
