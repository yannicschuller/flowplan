"use client";
import { BrandMark } from "./brand-mark";
import { loginReturnPath } from "@/lib/page-location";
import { useEffect, useState } from "react";
import { LanguageSwitch, useT } from "./i18n";
import {
  ArrowRight,
  ShieldCheck,
  SpinnerGap,
} from "@phosphor-icons/react";
export default function Login({
  demo,
  configured,
  error,
  instanceName = "",
}: {
  demo: boolean;
  configured: boolean;
  error?: string;
  instanceName?: string;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(error || "");
  const [loginUrl, setLoginUrl] = useState("/api/auth/login");
  useEffect(() => {
    const update = () =>
      setLoginUrl(
        `/api/auth/login?returnTo=${encodeURIComponent(loginReturnPath(`/${location.hash}`))}`,
      );
    update();
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  async function enter() {
    setBusy(true);
    const r = await fetch("/api/auth/demo", { method: "POST" });
    if (r.ok) {
      history.replaceState(null, "", loginReturnPath(`/${location.hash}`));
      location.reload();
    } else {
      setMessage((await r.json()).error);
      setBusy(false);
    }
  }
  return (
    <main className="login">
      <div className="login-brand">
        <BrandMark size={32} />
        flowplan
        {instanceName && <span className="muted"> · {instanceName}</span>}
      </div>
      <section className="login-card">
        <div className="login-mark">
          <BrandMark size={48} />
        </div>
        <h1>
          {t("Raum für deine", "Room for your")}
          <br />
          {t("nächste große Idee.", "next big idea.")}
        </h1>
        <p>
          {t("Deine Notizen, Projekte und dein Team.", "Your notes, projects and team.")}
          <br />
          {t("Alles an einem Ort.", "All in one place.")}
        </p>
        {message && (
          <div role="alert" className="error">
            {message}
          </div>
        )}
        {configured ? (
          <a className="button primary wide" href={loginUrl}>
            <ShieldCheck size={19} />
            {t("Mit SSO anmelden", "Sign in with SSO")}
            <ArrowRight size={18} />
          </a>
        ) : (
          <div className="callout">
            {t(
              "Die Anmeldung wird über deinen OIDC-Anbieter eingerichtet. Wie das geht, steht in der Dokumentation unter „Anmeldung mit OIDC“.",
              "Sign-in is set up with your OIDC provider. The documentation explains how under “Sign-in with OIDC”.",
            )}{" "}
            <a href="/docs/anmeldung-oidc">/docs/anmeldung-oidc</a>
          </div>
        )}
        {demo && (
          <button className="button wide" onClick={enter} disabled={busy}>
            {busy ? <SpinnerGap className="spin" /> : <ArrowRight />}
            {t("Lokalen Arbeitsbereich öffnen", "Open local workspace")}
          </button>
        )}
        <small>{t("Dein Wissen. Dein Workflow. Dein Flowplan.", "Your knowledge. Your workflow. Your Flowplan.")}</small>
      </section>
      <footer>
        FLOWPLAN <span>{t("Ein Zuhause für gute Zusammenarbeit.", "A home for good collaboration.")}</span>
        <LanguageSwitch className="language-switch" />
      </footer>
    </main>
  );
}
