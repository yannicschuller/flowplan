"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, SpinnerGap } from "@phosphor-icons/react";
import { BrandMark } from "./brand-mark";
import { useT } from "./i18n";
import { serverMessage } from "@/lib/i18n-errors";

// Starts a throwaway demo account right away and opens it; the button is
// there if starting fails.
export function DemoStart() {
  const t = useT();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const started = useRef(false);
  async function start() {
    setBusy(true);
    setError("");
    const response = await fetch("/api/auth/trial", { method: "POST" }).catch(() => null);
    if (response?.ok) {
      location.assign("/");
      return;
    }
    const data = ((await response?.json().catch(() => ({}))) || {}) as { error?: string };
    setError(serverMessage(data.error) || t("Die Demo konnte nicht starten.", "The demo could not start."));
    setBusy(false);
  }
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <main className="login">
      <section className="login-card">
        <div className="login-mark">
          <BrandMark size={48} />
        </div>
        <h1>
          {t("Deine Demo", "Your demo")}
          <br />
          {t("wird vorbereitet.", "is being prepared.")}
        </h1>
        <p>
          {t(
            "Ein eigener Arbeitsbereich mit Beispielen, ohne Konto. Er wird gelöscht, sobald du die Demo beendest.",
            "A workspace of your own with examples, without an account. It is deleted as soon as you end the demo.",
          )}
        </p>
        {error && (
          <div role="alert" className="error">
            {error}
          </div>
        )}
        <button className="button primary wide" onClick={() => void start()} disabled={busy}>
          {busy ? <SpinnerGap className="spin" /> : <ArrowRight />}
          {busy ? t("Demo wird vorbereitet …", "Preparing the demo …") : t("Demo starten", "Start the demo")}
        </button>
      </section>
    </main>
  );
}
