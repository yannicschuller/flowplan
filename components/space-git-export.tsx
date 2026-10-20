"use client";
// Space settings → Git export (#35): the owner of the space pushes its
// Markdown export into a Git repository, daily or weekly. Only shown when
// the administrator switched it on and the person owns the space; the
// access token is never sent back, only whether one is stored.
import { useEffect, useState } from "react";
import { serverMessage } from "@/lib/i18n-errors";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useT } from "./i18n";
import { Select } from "./select";
import { api } from "./ui";

type Run = { at: number; commit: string | null; files: number; pushed: boolean; error: string | null };
type Status =
  | { available: false }
  | {
      available: true;
      configured: boolean;
      url: string;
      branch: string;
      username: string;
      tokenSet: boolean;
      frequency: "daily" | "weekly";
      history: boolean;
      last: Run | null;
      next: number | null;
      running: boolean;
      allowedHosts: string[];
    };

export function SpaceGitExport({ spaceId, onError }: { spaceId: string; onError: (message: string) => void }) {
  const t = useT();
  const [status, setStatus] = useState<Status | null>(null),
    [url, setUrl] = useState(""),
    [branch, setBranch] = useState("main"),
    [username, setUsername] = useState(""),
    [token, setToken] = useState(""),
    [frequency, setFrequency] = useState<"daily" | "weekly">("daily"),
    [history, setHistory] = useState(false),
    [busy, setBusy] = useState(false);
  const take = (next: Status) => {
    setStatus(next);
    if (!next.available) return;
    setUrl(next.url);
    setBranch(next.branch);
    setUsername(next.username);
    setFrequency(next.frequency);
    setHistory(next.history);
    setToken("");
  };
  useEffect(() => {
    let alive = true;
    api<Status>(`/api/spaces/${spaceId}/git-export`)
      .then((next) => alive && take(next))
      .catch(() => alive && setStatus(null));
    return () => {
      alive = false;
    };
  }, [spaceId]);
  if (!status?.available) return null;
  const act = async (work: () => Promise<Status>) => {
    setBusy(true);
    try {
      take(await work());
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    act(() =>
      api<Status>("/api/command", { action: "space.gitExport", spaceId, enabled: true, url: url.trim(), branch: branch.trim(), username: username.trim(), ...(token.trim() ? { token: token.trim() } : {}), frequency, history }),
    );
  const when = (at: number) => new Date(at).toLocaleString(LOCALE_TAG);
  const last = status.last;
  return (
    <details className="space-git-export" open={status.configured || undefined}>
      <summary>{t("Git-Export", "Git export")}</summary>
      <p className="muted">
        {t(
          "Flowplan überträgt den Markdown-Export dieses Bereichs in ein Git-Repository – mit deinen Leserechten, ein Commit je Lauf und nur, wenn sich etwas geändert hat. Änderungen im Repository werden nicht zurück übernommen.",
          "Flowplan pushes the Markdown export of this space into a Git repository – with your read access, one commit per run and only when something changed. Changes made in the repository are not taken back.",
        )}
      </p>
      {/* Enter saves the Git export, not the space settings around it. */}
      <div
        className="space-git-fields"
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.target as HTMLElement).tagName === "INPUT") {
            event.preventDefault();
            if (!busy) void save();
          }
        }}
      >
        <label>
          {t("Repository-Adresse (https)", "Repository address (https)")}
          <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://git.example.org/team/notes.git" maxLength={500} disabled={busy} autoComplete="off" />
          {status.allowedHosts.length > 0 && (
            <small className="muted">
              {t("Erlaubte Git-Server:", "Allowed Git servers:")} {status.allowedHosts.join(", ")}
            </small>
          )}
        </label>
        <label>
          {t("Branch", "Branch")}
          <input value={branch} onChange={(e) => setBranch(e.target.value)} maxLength={100} disabled={busy} autoComplete="off" />
        </label>
        <label>
          {t("Benutzername", "User name")}
          <input value={username} onChange={(e) => setUsername(e.target.value)} maxLength={100} disabled={busy} autoComplete="off" />
        </label>
        <label>
          {t("Zugangstoken mit Schreibrechten", "Access token with write access")}
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={status.tokenSet ? t("Gespeichert – leer lassen, um es zu behalten", "Stored – leave empty to keep it") : ""}
            maxLength={1000}
            disabled={busy}
            autoComplete="new-password"
          />
          <small className="muted">{status.tokenSet ? t("Ein Token ist gespeichert (verschlüsselt).", "A token is stored (encrypted).") : t("Noch kein Token gespeichert.", "No token stored yet.")}</small>
        </label>
        <label>
          {t("Häufigkeit", "Frequency")}
          <Select value={frequency} onChange={(e) => setFrequency(e.target.value as "daily" | "weekly")} disabled={busy}>
            <option value="daily">{t("Täglich", "Daily")}</option>
            <option value="weekly">{t("Wöchentlich", "Weekly")}</option>
          </Select>
        </label>
        <label className="checkbox-label">
          <input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} disabled={busy} />
          <span>{t("Kommentare und frühere Versionen mitnehmen", "Include comments and earlier versions")}</span>
        </label>
      </div>
      {status.configured && (
        <p className={last?.error ? "error" : "muted"} role="status">
          {status.running
            ? t("Läuft gerade …", "Running …")
            : last
              ? `${t("Zuletzt", "Last")} ${when(last.at)}: ${
                  last.error
                    ? serverMessage(last.error)
                    : last.pushed
                      ? t(`übertragen (${last.commit?.slice(0, 7)}, ${last.files} Dateien geändert)`, `pushed (${last.commit?.slice(0, 7)}, ${last.files} files changed)`)
                      : t("keine Änderungen", "no changes")
                }`
              : t("Noch nicht gelaufen.", "Not run yet.")}
          {!status.running && status.next ? ` · ${t("Nächster Lauf ab", "Next run from")} ${when(status.next)}` : ""}
        </p>
      )}
      <div className="lifecycle-buttons">
        <button type="button" className="button primary" disabled={busy || !url.trim() || !username.trim()} onClick={() => void save()}>
          {status.configured ? t("Git-Export speichern", "Save Git export") : t("Git-Export einschalten", "Turn on Git export")}
        </button>
        {status.configured && (
          <>
            <button type="button" className="button" disabled={busy || status.running} onClick={() => void act(() => api<Status>(`/api/spaces/${spaceId}/git-export/run`, {}))}>
              {busy ? t("Läuft …", "Running …") : t("Jetzt ausführen", "Run now")}
            </button>
            <button
              type="button"
              className="button danger"
              disabled={busy}
              onClick={() => void act(() => api<Status>("/api/command", { action: "space.gitExport", spaceId, enabled: false }))}
            >
              {t("Ausschalten", "Turn off")}
            </button>
          </>
        )}
      </div>
    </details>
  );
}
