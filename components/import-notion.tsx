"use client";
// Import from Notion through its API (lib/importers/notion-api.ts), the
// source "Notion (API)" of components/import-sources.tsx: the person pastes
// the token of an internal integration, loads the pages and databases
// shared with it, picks the top-level ones and imports them as a
// background job (the same job state as the file imports, #163). The token
// stays in this component's state until the import has started and is
// cleared then; the server keeps it only while the job runs.
import { useState } from "react";
import { Database, FileText } from "@phosphor-icons/react";
import { serverMessage } from "@/lib/i18n-errors";
import { useT } from "./i18n";

type Item = { id: string; title: string; kind: "page" | "database"; icon?: string };

export function ImportNotion({
  workspaceId,
  spaceId,
  canWrite,
  busy,
  onJob,
  onError,
}: {
  workspaceId: string;
  spaceId: string;
  canWrite: boolean;
  busy: boolean;
  // Runs the started job to its end (progress, result, refresh).
  onJob: (job: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const t = useT();
  const [token, setToken] = useState("");
  const [items, setItems] = useState<Item[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const post = async (body: Record<string, unknown>) => {
    const response = await fetch("/api/import/notion", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, spaceId, token, ...body }),
    });
    const data = (await response.json().catch(() => null)) as { error?: string; items?: Item[]; job?: string } | null;
    if (!response.ok) throw new Error(serverMessage(data?.error) || String(response.status));
    return data || {};
  };
  const load = async () => {
    setLoading(true);
    try {
      const found = (await post({ action: "list" })).items || [];
      setItems(found);
      setChosen(new Set(found.map((item) => item.id)));
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setLoading(false);
    }
  };
  const start = async () => {
    const picked = (items || []).filter((item) => chosen.has(item.id)).map(({ id, kind }) => ({ id, kind }));
    let job: string | undefined;
    try {
      job = (await post({ action: "import", items: picked })).job;
    } catch (error) {
      onError((error as Error).message);
      return;
    }
    // The server has the token for the job; the page forgets it.
    setToken("");
    setItems(null);
    if (job) await onJob(job);
  };
  const toggle = (id: string) =>
    setChosen((all) => {
      const next = new Set(all);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const disabled = !canWrite || busy || loading;
  return (
    <div className="import-notion">
      <p className="import-sources-hint">
        <span>
          {t(
            "Öffne notion.so/profile/integrations, lege mit „Neue Integration“ eine interne Integration für deinen Arbeitsbereich an (Berechtigung „Inhalte lesen“; „Benutzerinformationen lesen“, damit Personen zu Mitgliedern werden) und kopiere unter „Konfiguration“ das Secret. Teile dann die Seiten und Datenbanken mit ihr: auf der Seite oben rechts „…“ → Verbindungen → die Integration wählen (Unterseiten gehören dazu). Das Token wird nur für diesen Import verwendet und nicht gespeichert.",
            "Open notion.so/profile/integrations, create an internal integration for your workspace with “New integration” (capability “Read content”; “Read user information” so that people become members) and copy the secret under “Configuration”. Then share the pages and databases with it: on the page, “…” at the top right → Connections → choose the integration (sub-pages are included). The token is only used for this import and not stored.",
          )}
        </span>
      </p>
      <div className="ws-form ws-form-inline">
        <div className="ws-field">
          <label htmlFor="import-notion-token">{t("Integrations-Token", "Integration token")}</label>
          <input
            id="import-notion-token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            maxLength={300}
            placeholder="ntn_…"
            onChange={(e) => {
              setToken(e.target.value);
              setItems(null);
            }}
            disabled={disabled}
          />
        </div>
        <div className="ws-form-actions">
          <button type="button" className="button" onClick={() => void load()} disabled={disabled || token.trim().length < 20}>
            {loading ? t("Wird geladen …", "Loading …") : t("Geteilte Seiten laden", "Load shared pages")}
          </button>
        </div>
      </div>
      {items && !busy && (
        <div className="import-sources-preview" role="region" aria-label={t("Seiten aus Notion", "Pages from Notion")}>
          <strong>{t("Was importiert werden soll", "What to import")}</strong>
          {items.length ? (
            <ul className="import-notion-list">
              {items.map((item) => (
                <li key={item.id}>
                  <label>
                    <input type="checkbox" checked={chosen.has(item.id)} onChange={() => toggle(item.id)} />
                    {item.icon ? <span aria-hidden>{item.icon}</span> : item.kind === "database" ? <Database aria-hidden /> : <FileText aria-hidden />}
                    <span className="ws-break">{item.title}</span>
                    {item.kind === "database" && <small>{t("Datenbank", "Database")}</small>}
                  </label>
                </li>
              ))}
            </ul>
          ) : (
            <p className="import-sources-warnings">
              {t(
                "Die Integration sieht keine Seiten. Teile die Seiten in Notion über „…“ → Verbindungen mit ihr und lade erneut.",
                "The integration sees no pages. Share the pages with it in Notion via “…” → Connections and load again.",
              )}
            </p>
          )}
          <p className="import-sources-warnings">
            {t(
              "Unterseiten, Datenbanken mit ihren Einträgen und Dateien kommen mit. Was nicht übernommen werden kann, steht danach im Importbericht.",
              "Sub-pages, databases with their records and files come along. What cannot be carried over is listed in the import report afterwards.",
            )}
          </p>
          <div className="import-sources-actions">
            <button type="button" className="button" onClick={() => setItems(null)}>
              {t("Abbrechen", "Cancel")}
            </button>
            <button type="button" className="button primary" onClick={() => void start()} disabled={!canWrite || !chosen.size}>
              {t(`${chosen.size} importieren`, `Import ${chosen.size}`)}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
