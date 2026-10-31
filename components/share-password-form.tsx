"use client";
import { serverMessage } from "@/lib/i18n-errors";
// The password of a protected share link (lib/share-access.ts). The right
// one sets a cookie for this link; the page then loads with its content.
import { useState, type FormEvent } from "react";
import { LockKey, SpinnerGap } from "@phosphor-icons/react";
import { useT } from "./i18n";

export function SharePasswordForm({ token }: { token: string }) {
  const t = useT();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get("password") || "");
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/share/${encodeURIComponent(token)}/unlock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(serverMessage(data.error) || response.statusText);
      location.reload();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <form method="post" action="/api/auth/no-script" className="share-password-form" onSubmit={submit}>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <label>
        {t("Passwort", "Password")}
        <input name="password" type="password" autoComplete="off" required maxLength={200} autoFocus />
      </label>
      <button className="button primary" disabled={busy}>
        {busy ? <SpinnerGap className="spin" /> : <LockKey size={17} />}
        {t("Öffnen", "Open")}
      </button>
    </form>
  );
}
