"use client";
// Replaces the root layout when it fails itself (#47): its own document,
// without the app's styles and language provider, so the text follows the
// browser's language and the look stays plain.
import { useEffect } from "react";
import { LOCALES, translate, type Locale } from "@/lib/i18n";

function browserLocale(): Locale {
  if (typeof navigator === "undefined") return "en";
  const tag = (navigator.language || "en").slice(0, 2).toLowerCase();
  return (LOCALES as string[]).includes(tag) ? (tag as Locale) : "en";
}

export default function GlobalError({ error, retry, reset }: { error: unknown; retry: () => void; reset: () => void }) {
  const t = translate(browserLocale());
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <html lang={browserLocale()}>
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "Canvas", color: "CanvasText", colorScheme: "light dark" }}>
        <title>Flowplan</title>
        <main role="alert" style={{ maxWidth: 420, margin: "18vh auto 0", padding: "0 20px", textAlign: "center", lineHeight: 1.5 }}>
          <h1 style={{ fontSize: 20, fontWeight: 600 }}>
            {offline
              ? t("Nicht offline verfügbar – versuche es wieder, wenn du online bist.", "Not available offline – try again when you're online.")
              : t("Etwas ist schiefgelaufen.", "Something went wrong.")}
          </h1>
          <button type="button" style={{ font: "inherit", padding: "8px 16px", borderRadius: 8, cursor: "pointer" }} onClick={() => (navigator.onLine ? retry() : reset())}>
            {t("Erneut versuchen", "Try again")}
          </button>
        </main>
      </body>
    </html>
  );
}
