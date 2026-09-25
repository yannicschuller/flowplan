"use client";
import { loginReturnPath } from "@/lib/page-location";
import { useEffect, useState } from "react";
import {
  ArrowRight,
  Stack,
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
        <span className="logo">
          <Stack weight="bold" size={24} />
        </span>
        flowplan
        {instanceName && <span className="muted"> · {instanceName}</span>}
      </div>
      <section className="login-card">
        <div className="login-mark">
          <Stack size={44} weight="duotone" />
        </div>
        <h1>
          Raum für deine
          <br />
          nächste große Idee.
        </h1>
        <p>
          Deine Notizen, Projekte und dein Team.
          <br />
          Alles an einem Ort.
        </p>
        {message && (
          <div role="alert" className="error">
            {message}
          </div>
        )}
        {configured ? (
          <a className="button primary wide" href={loginUrl}>
            <ShieldCheck size={19} />
            Mit SSO anmelden
            <ArrowRight size={18} />
          </a>
        ) : (
          <div className="callout">
            Die Anmeldung wird über deinen OIDC-Anbieter eingerichtet. Hinweise
            dazu findest du in der README.
          </div>
        )}
        {demo && (
          <button className="button wide" onClick={enter} disabled={busy}>
            {busy ? <SpinnerGap className="spin" /> : <ArrowRight />}Lokalen
            Arbeitsbereich öffnen
          </button>
        )}
        <small>Dein Wissen. Dein Workflow. Dein Flowplan.</small>
      </section>
      <footer>
        FLOWPLAN <span>Ein Zuhause für gute Zusammenarbeit.</span>
      </footer>
    </main>
  );
}
