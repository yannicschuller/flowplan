"use client";
// Settings → Konto & Sicherheit: where this person is signed in, with
// "Sign out" per device and for all other devices – a wide row of the
// "Anmeldung & Sicherheit" card.
import { useCallback, useEffect, useState } from "react";
import { Desktop, DeviceMobile, Globe } from "@phosphor-icons/react";
import { serverMessage } from "@/lib/i18n-errors";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useT } from "./i18n";
import { StatusBadge } from "./settings-ui";
import { api } from "./ui";

type Session = {
  id: string;
  current: boolean;
  app: string;
  browser: string;
  system: string;
  createdAt: number | null;
  lastSeen: number | null;
  expires: number;
  remember: boolean;
};

async function end(body: { id?: string; others?: boolean }) {
  const response = await fetch("/api/sessions/end", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(serverMessage(result.error) || "Error");
  return result as { ended: number; current: boolean };
}

export function MySessions({ onError }: { onError: (message: string) => void }) {
  const t = useT();
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const load = useCallback(
    () =>
      api<{ sessions: Session[] }>("/api/sessions")
        .then((r) => setSessions(r.sessions))
        .catch((e) => onError((e as Error).message)),
    [onError],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const when = (ms: number | null) =>
    ms ? new Date(ms).toLocaleString(LOCALE_TAG, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "–";
  const others = sessions ? sessions.filter((s) => !s.current).length : 0;
  const signOut = async (body: { id?: string; others?: boolean }) => {
    try {
      const result = await end(body);
      if (result.current) location.reload();
      else void load();
    } catch (e) {
      onError((e as Error).message);
    }
  };
  return (
    <div className="setting-row wide" id="sessions">
      <div className="my-sessions-head">
        <div className="setting-text">
          <span className="setting-label">{t("Angemeldete Geräte", "Signed-in devices")}</span>
          <small>{t("Wo du gerade angemeldet bist. Abmelden beendet die Sitzung auf dem Gerät sofort.", "Where you are signed in right now. Signing out ends the session on that device at once.")}</small>
        </div>
        {others > 0 && (
          <button type="button" className="button" onClick={() => void signOut({ others: true })}>
            {t("Alle anderen Geräte abmelden", "Sign out all other devices")}
          </button>
        )}
      </div>
      {!sessions ? (
        <p className="settings-loading" role="status">
          {t("Wird geladen …", "Loading …")}
        </p>
      ) : (
        <ul className="my-sessions">
          {sessions.map((s) => {
            const Icon = s.app === "Flowplan desktop" ? Desktop : ["iPhone", "Android"].includes(s.system) || s.app ? DeviceMobile : Globe;
            // Sessions from before this list have no device details.
            const name = s.app || s.browser || s.system ? [s.app || s.browser, s.system].filter(Boolean).join(t(" auf ", " on ")) : t("Unbekanntes Gerät", "Unknown device");
            return (
              <li key={s.id}>
                <Icon size={20} aria-hidden />
                <span>
                  <strong>{name}</strong>
                  <small>
                    {t("Zuletzt aktiv", "Last active")}: {when(s.lastSeen || s.createdAt)} · {s.remember ? t("bleibt angemeldet bis spätestens", "stays signed in until at most") : t("endet", "ends")} {when(s.expires)}
                  </small>
                </span>
                {s.current && <StatusBadge tone="ok">{t("Dieses Gerät", "This device")}</StatusBadge>}
                <button type="button" className="button compact" aria-label={s.current ? t("Auf diesem Gerät abmelden", "Sign out on this device") : t(`${name} abmelden`, `Sign out ${name}`)} onClick={() => void signOut({ id: s.id })}>
                  {t("Abmelden", "Sign out")}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
