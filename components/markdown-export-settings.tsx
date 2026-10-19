"use client";
// Admin → Versions and backup: the readable copy outside Flowplan. Chosen
// pages and databases go as Markdown ZIPs next to the backups and, when
// configured on the server, into a Git repository.
import { useEffect, useMemo, useState } from "react";
import { serverMessage } from "@/lib/i18n-errors";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useT } from "./i18n";
import { api } from "./ui";

export type MarkdownExportStatus = {
  pages: { id: string; title: string | null }[];
  owner: string | null;
  runs: { pageId: string; name: string; at: number; bytes: number; error: string | null }[];
  git: {
    configured: boolean;
    url: string | null;
    branch: string | null;
    importChanges: boolean;
    problem: string | null;
    last: { at: number; commit: string | null; pushed: boolean; imported: number; error: string | null } | null;
  };
};
type Choice = { id: string; title: string; kind: string; workspace: string; parent: string };

export function MarkdownExportSettings({
  status,
  onChange,
  onError,
}: {
  status: MarkdownExportStatus;
  onChange: () => void;
  onError: (message: string) => void;
}) {
  const t = useT();
  const [choices, setChoices] = useState<Choice[] | null>(null);
  const [chosen, setChosen] = useState<string[]>(status.pages.map((p) => p.id));
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setChosen(status.pages.map((p) => p.id)), [status.pages]);
  const open = () =>
    api<{ pages: Choice[] }>("/api/admin/export-pages")
      .then((r) => setChoices(r.pages))
      .catch((e) => onError((e as Error).message));
  const shown = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase(LOCALE_TAG);
    return (choices || []).filter((c) => !needle || `${c.title} ${c.workspace} ${c.parent}`.toLocaleLowerCase(LOCALE_TAG).includes(needle)).slice(0, 200);
  }, [choices, query]);
  const when = (at: number) => new Date(at).toLocaleString(LOCALE_TAG);
  const git = status.git;
  return (
    <section className="settings-section markdown-export-settings">
      <h2>{t("Markdown-Export", "Markdown export")}</h2>
      <p>
        {t(
          "Eine lesbare Kopie außerhalb von Flowplan: Die gewählten Seiten und Datenbanken (mit Unterseiten, Kommentaren und Versionen) kommen bei jeder Sicherung als Markdown-ZIP in den Ordner",
          "A readable copy outside Flowplan: the chosen pages and databases (with sub-pages, comments and versions) go as a Markdown ZIP into the folder",
        )}{" "}
        <code>exports/</code> {t("– so viele wie Sicherungen. Exportiert wird mit den Leserechten von", "with every backup – as many as backups. They are exported with the read access of")}{" "}
        <strong>{status.owner || t("dir (beim Speichern)", "you (when saving)")}</strong>.
      </p>
      {status.pages.length > 0 && (
        <ul className="markdown-export-pages">
          {status.pages.map((p) => {
            const last = status.runs.find((r) => r.pageId === p.id);
            return (
              <li key={p.id}>
                <strong>{p.title ?? t("(gelöscht)", "(deleted)")}</strong>
                {last && (
                  <small className={last.error ? "error" : "muted"}>
                    {" "}
                    · {when(last.at)}: {last.error ? serverMessage(last.error) : `${last.name} (${last.bytes < 1048576 ? `${Math.max(1, Math.round(last.bytes / 1024))} KB` : `${(last.bytes / 1048576).toFixed(1)} MB`})`}
                  </small>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {!choices ? (
        <button type="button" className="button" onClick={() => void open()}>
          {status.pages.length ? t("Auswahl ändern", "Change selection") : t("Seiten wählen", "Choose pages")}
        </button>
      ) : (
        <form
          className="markdown-export-picker"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await api("/api/admin/markdown-export", { pageIds: chosen });
              setChoices(null);
              onChange();
            } catch (error) {
              onError((error as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <input type="search" placeholder={t("Seite suchen …", "Search page …")} aria-label={t("Seite suchen", "Search page")} value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="markdown-export-choices">
            {shown.map((c) => (
              <label key={c.id} className="checkbox-label">
                <input
                  type="checkbox"
                  checked={chosen.includes(c.id)}
                  onChange={(e) => setChosen((list) => (e.target.checked ? [...list, c.id] : list.filter((x) => x !== c.id)))}
                />
                <span>
                  {c.title || t("Ohne Titel", "Untitled")}
                  <small>
                    {c.workspace}
                    {c.parent ? ` · ${c.parent}` : ""} · {c.kind === "database" ? t("Datenbank", "Database") : c.kind === "journal" ? "Journal" : t("Seite", "Page")}
                  </small>
                </span>
              </label>
            ))}
          </div>
          <div className="modal-actions">
            <button type="button" className="button" onClick={() => setChoices(null)}>
              {t("Abbrechen", "Cancel")}
            </button>
            <button className="button primary" disabled={busy || chosen.length > 50}>
              {t(`${chosen.length} speichern`, `Save ${chosen.length}`)}
            </button>
          </div>
        </form>
      )}
      <h3>{t("Git-Repository", "Git repository")}</h3>
      {git.configured ? (
        <>
          <p>
            {t("Jeder Export wird nach", "Every export is pushed to")} <code>{git.url}</code> ({git.branch}) {t("übertragen – jede Seite in einem eigenen Ordner.", "– every page in a folder of its own.")}{" "}
            {git.importChanges
              ? t("Änderungen, die im Repository gemacht wurden, übernimmt Flowplan vorher (Einträge über ihre flowplan.id, Dokumente über die Kennung im Dateinamen; der vorige Stand bleibt als Version).", "Changes made in the repository are taken over first (records by their flowplan.id, documents by the id in their file name; the previous state stays as a version).")
              : t("Änderungen im Repository werden nicht übernommen (EXPORT_GIT_IMPORT=true schaltet das ein).", "Changes made in the repository are not taken over (EXPORT_GIT_IMPORT=true turns this on).")}
          </p>
          {git.problem && <p className="error">{serverMessage(git.problem)}</p>}
          {git.last && (
            <p className={git.last.error ? "error" : "muted"}>
              {t("Zuletzt", "Last")} {when(git.last.at)}:{" "}
              {git.last.error
                ? serverMessage(git.last.error)
                : `${git.last.pushed ? t("übertragen", "pushed") : t("keine Änderungen", "no changes")}${git.last.commit ? ` (${git.last.commit.slice(0, 7)})` : ""}${git.last.imported ? t(` · ${git.last.imported} aus Git übernommen`, ` · ${git.last.imported} taken over from Git`) : ""}`}
            </p>
          )}
        </>
      ) : (
        <p className="muted">
          {git.problem ? <span className="error">{serverMessage(git.problem)} </span> : null}
          {t("Nicht eingerichtet. Mit", "Not set up. With")} <code>EXPORT_GIT_URL</code> {t("und", "and")} <code>EXPORT_GIT_TOKEN</code>{" "}
          {t("überträgt Flowplan jeden Export in ein Git-Repository (Forgejo, Gitea, GitHub, GitLab).", "Flowplan pushes every export into a Git repository (Forgejo, Gitea, GitHub, GitLab).")}
        </p>
      )}
    </section>
  );
}
