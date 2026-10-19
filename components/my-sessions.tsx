"use client";
// Settings → Account: where this person is signed in, with "Sign out" per
// device and for all other devices.
import { useCallback, useEffect, useState } from "react";
import { Desktop, DeviceMobile, Globe } from "@phosphor-icons/react";
import { serverMessage } from "@/lib/i18n-errors";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useT } from "./i18n";
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
  if (!sessions) return null;
  const others = sessions.filter((s) => !s.current).length;
  return (
    <div className="settings-subsection">
      <h3>{t("Angemeldete Geräte", "Signed-in devices")}</h3>
      <ul className="my-sessions">
        {sessions.map((s) => {
          const Icon = s.app === "Flowplan desktop" ? Desktop : ["iPhone", "Android"].includes(s.system) || s.app ? DeviceMobile : Globe;
          // Sessions from before this list have no device details.
          const name = s.app || s.browser || s.system ? [s.app || s.browser, s.system].filter(Boolean).join(t(" auf ", " on ")) : t("Unbekanntes Gerät", "Unknown device");
          return (
            <li key={s.id}>
              <Icon size={20} />
              <span>
                <strong>
                  {name}
                  {s.current && <span className="session-current"> · {t("dieses Gerät", "this device")}</span>}
                </strong>
                <small>
                  {t("Zuletzt aktiv", "Last active")}: {when(s.lastSeen || s.createdAt)} · {s.remember ? t("bleibt angemeldet bis spätestens", "stays signed in until at most") : t("endet", "ends")} {when(s.expires)}
                </small>
              </span>
              <button
                type="button"
                className="button compact"
                onClick={async () => {
                  try {
                    const result = await end({ id: s.id });
                    if (result.current) location.reload();
                    else void load();
                  } catch (e) {
                    onError((e as Error).message);
                  }
                }}
              >
                {t("Abmelden", "Sign out")}
              </button>
            </li>
          );
        })}
      </ul>
      {others > 0 && (
        <button
          type="button"
          className="text-button"
          onClick={async () => {
            try {
              await end({ others: true });
              void load();
            } catch (e) {
              onError((e as Error).message);
            }
          }}
        >
          {t("Alle anderen Geräte abmelden", "Sign out all other devices")}
        </button>
      )}
    </div>
  );
}
