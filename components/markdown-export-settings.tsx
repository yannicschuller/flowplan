"use client";
// Administration → Markdown- & Git-Export: the readable copy outside
// Flowplan. Chosen pages and databases go as Markdown ZIPs next to the
// backups; space owners can push their space into a Git repository; the
// instance-wide Git export (EXPORT_GIT_*) is deprecated.
import { useEffect, useMemo, useState } from "react";
import { FileText, MagnifyingGlass } from "@phosphor-icons/react";
import { serverMessage } from "@/lib/i18n-errors";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useT } from "./i18n";
import { api } from "./ui";
import { EmptyState, SettingGroup, SettingRow, StatusBadge } from "./settings-ui";

export type MarkdownExportStatus = {
  pages: { id: string; title: string | null }[];
  owner: string | null;
  runs: {
    pageId: string;
    name: string;
    at: number;
    bytes: number;
    error: string | null;
  }[];
  git: {
    configured: boolean;
    url: string | null;
    branch: string | null;
    importChanges: boolean;
    problem: string | null;
    last: {
      at: number;
      commit: string | null;
      pushed: boolean;
      imported: number;
      error: string | null;
    } | null;
  };
};
// Git export of spaces (lib/space-git-export.ts): without addresses or content.
export type SpaceGitOverview = {
  enabled: boolean;
  allowedHosts: string[];
  allowPrivate: boolean;
  spaces: number;
  failing: { at: number; error: string; workspace: string; owner: string }[];
};
type Choice = {
  id: string;
  title: string;
  kind: string;
  workspace: string;
  parent: string;
};

const when = (at: number) =>
  new Date(at).toLocaleString(LOCALE_TAG, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
const size = (n: number) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);

export function MarkdownExportSettings({
  status,
  spaceGit,
  onChange,
  onError,
}: {
  status: MarkdownExportStatus;
  spaceGit: SpaceGitOverview;
  onChange: () => void;
  onError: (message: string) => void;
}) {
  const t = useT();
  const [choices, setChoices] = useState<Choice[] | null>(null);
  // Only pages that still exist can be ticked, so "Save N" matches the list.
  const existing = (pages: typeof status.pages) => pages.filter((p) => p.title !== null && p.title !== undefined).map((p) => p.id);
  const [chosen, setChosen] = useState<string[]>(existing(status.pages));
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setChosen(existing(status.pages)), [status.pages]);
  const open = () =>
    api<{ pages: Choice[] }>("/api/admin/export-pages")
      .then((r) => setChoices(r.pages))
      .catch((e) => onError((e as Error).message));
  const shown = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase(LOCALE_TAG);
    return (choices || []).filter((c) => !needle || `${c.title} ${c.workspace} ${c.parent}`.toLocaleLowerCase(LOCALE_TAG).includes(needle)).slice(0, 200);
  }, [choices, query]);
  const git = status.git;
  return (
    <div className="markdown-export-settings">
      <SettingGroup
        id="markdown"
        title={t("Markdown-Export", "Markdown export")}
        description={
          <>
            {t(
              "Die gewählten Seiten und Datenbanken (mit Unterseiten, Kommentaren und Versionen) kommen bei jeder Sicherung als Markdown-ZIP in den Ordner",
              "The chosen pages and databases (with sub-pages, comments and versions) go as a Markdown ZIP into the folder",
            )}{" "}
            <code>exports/</code> {t("– so viele wie Sicherungen. Exportiert wird mit den Leserechten von", "with every backup – as many as backups. They are exported with the read access of")}{" "}
            <strong>{status.owner || t("dir (beim Speichern)", "you (when saving)")}</strong>.
          </>
        }
        actions={
          !choices && (
            <button type="button" className="button" onClick={() => void open()}>
              {status.pages.length ? t("Auswahl ändern", "Change selection") : t("Seiten wählen", "Choose pages")}
            </button>
          )
        }
      >
        {status.pages.length > 0 ? (
          <ul className="markdown-export-pages">
            {status.pages.map((p) => {
              const last = status.runs.find((r) => r.pageId === p.id);
              return (
                <li key={p.id} className="setting-row">
                  <div className="setting-text">
                    <span className="setting-label">{p.title ?? t("(gelöscht)", "(deleted)")}</span>
                    {last && <small>{`${when(last.at)}: ${last.error ? serverMessage(last.error) : `${last.name} (${size(last.bytes)})`}`}</small>}
                  </div>
                  <div className="setting-control">
                    {p.title === null || p.title === undefined ? (
                      <StatusBadge tone="warn">{t("Gelöscht", "Deleted")}</StatusBadge>
                    ) : last ? (
                      <StatusBadge tone={last.error ? "error" : "ok"}>{last.error ? t("Fehlgeschlagen", "Failed") : t("Exportiert", "Exported")}</StatusBadge>
                    ) : (
                      <StatusBadge tone="off">{t("Noch nicht exportiert", "Not exported yet")}</StatusBadge>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          !choices && (
            <div className="setting-row wide">
              <EmptyState icon={<FileText size={18} />} title={t("Keine Seiten gewählt", "No pages chosen")}>
                {t("Ohne Auswahl entsteht kein Markdown-Export.", "Without a selection there is no Markdown export.")}
              </EmptyState>
            </div>
          )
        )}
        {choices && (
          <form
            className="setting-row wide markdown-export-picker"
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
            <span className="admin-search">
              <MagnifyingGlass size={16} aria-hidden />
              <input type="search" placeholder={t("Seite suchen …", "Search page …")} aria-label={t("Seite suchen", "Search page")} value={query} onChange={(e) => setQuery(e.target.value)} />
            </span>
            <div className="markdown-export-choices">
              {shown.map((c) => (
                <label key={c.id} className="checkbox-label">
                  <input type="checkbox" checked={chosen.includes(c.id)} onChange={(e) => setChosen((list) => (e.target.checked ? [...list, c.id] : list.filter((x) => x !== c.id)))} />
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
              {chosen.length > 50 && <small className="error">{t("Höchstens 50 Seiten.", "At most 50 pages.")}</small>}
              <button type="button" className="button" onClick={() => setChoices(null)}>
                {t("Abbrechen", "Cancel")}
              </button>
              <button className="button primary" disabled={busy || chosen.length > 50}>
                {t(`${chosen.length} speichern`, `Save ${chosen.length}`)}
              </button>
            </div>
          </form>
        )}
      </SettingGroup>

      <SettingGroup
        id="space-git"
        title={t("Git-Export der Bereiche", "Git export of spaces")}
        description={t(
          "Bereichseigentümer übertragen ihren Bereich selbst in ein eigenes Git-Repository (Einstellungen des Bereichs).",
          "Space owners push their space into their own Git repository themselves (the space's settings).",
        )}
        actions={
          spaceGit.enabled ? (
            <StatusBadge tone={spaceGit.failing.length ? "error" : "ok"}>
              {spaceGit.failing.length ? t(`${spaceGit.failing.length} mit Fehler`, `${spaceGit.failing.length} failing`) : t("An", "On")}
            </StatusBadge>
          ) : (
            <StatusBadge tone="off">{t("Aus", "Off")}</StatusBadge>
          )
        }
      >
        {spaceGit.enabled ? (
          <>
            <SettingRow label={t("Bereiche", "Spaces")} description={t("Bereiche mit eigenem Git-Export.", "Spaces with their own Git export.")}>
              <span className="setting-value">{spaceGit.spaces}</span>
            </SettingRow>
            <SettingRow
              label={t("Erlaubte Git-Server", "Allowed Git servers")}
              description={
                (spaceGit.allowedHosts.length
                  ? t("Aus SPACE_GIT_ALLOWED_HOSTS.", "From SPACE_GIT_ALLOWED_HOSTS.")
                  : t("Alle öffentlichen https-Server (SPACE_GIT_ALLOWED_HOSTS schränkt das ein).", "Every public https server (SPACE_GIT_ALLOWED_HOSTS narrows this down).")) +
                (spaceGit.allowPrivate
                  ? ` ${t("Diese Server dürfen auch interne Adressen haben (SPACE_GIT_ALLOW_PRIVATE).", "These servers may also have internal addresses (SPACE_GIT_ALLOW_PRIVATE).")}`
                  : "")
              }
            >
              <span className="setting-value admin-break">{spaceGit.allowedHosts.length ? spaceGit.allowedHosts.join(", ") : t("alle", "all")}</span>
            </SettingRow>
            {spaceGit.failing.length > 0 && (
              <SettingRow wide label={t("Fehler", "Errors")}>
                <ul className="space-git-errors">
                  {spaceGit.failing.map((f, index) => (
                    <li key={index}>
                      <small className="error">
                        {when(f.at)} · {f.workspace} · {f.owner}: {serverMessage(f.error)}
                      </small>
                    </li>
                  ))}
                </ul>
              </SettingRow>
            )}
          </>
        ) : (
          <SettingRow
            label={t("Einschalten", "Turn on")}
            description={t(
              "Mit SPACE_GIT_EXPORT=true in der Umgebung; SPACE_GIT_ALLOWED_HOSTS begrenzt die Git-Server.",
              "With SPACE_GIT_EXPORT=true in the environment; SPACE_GIT_ALLOWED_HOSTS limits the Git servers.",
            )}
          >
            <code>SPACE_GIT_EXPORT=true</code>
          </SettingRow>
        )}
      </SettingGroup>

      <SettingGroup
        id="instance-git"
        title={t("Git-Repository der Instanz (veraltet)", "Instance Git repository (deprecated)")}
        description={
          git.configured
            ? t("Läuft weiter, wird aber durch den Git-Export der Bereiche ersetzt.", "Keeps working but is replaced by the Git export of spaces.")
            : `${t("Nicht eingerichtet. Mit EXPORT_GIT_URL und EXPORT_GIT_TOKEN überträgt Flowplan jeden Export in ein Git-Repository (Forgejo, Gitea, GitHub, GitLab).", "Not set up. With EXPORT_GIT_URL and EXPORT_GIT_TOKEN Flowplan pushes every export into a Git repository (Forgejo, Gitea, GitHub, GitLab).")} ${t("Besser ist der Git-Export der Bereiche.", "The Git export of spaces is the better choice.")}`
        }
        actions={
          git.configured ? <StatusBadge tone={git.problem || git.last?.error ? "error" : "warn"}>{t("Veraltet", "Deprecated")}</StatusBadge> : <StatusBadge tone="off">{t("Aus", "Off")}</StatusBadge>
        }
      >
        {git.problem && (
          <SettingRow label={t("Problem", "Problem")}>
            <span className="error">{serverMessage(git.problem)}</span>
          </SettingRow>
        )}
        {git.configured && (
          <>
            <SettingRow
              label={t("Ziel", "Target")}
              description={
                git.importChanges
                  ? t(
                      "Änderungen im Repository übernimmt Flowplan vorher (Einträge über ihre flowplan.id, Dokumente über die Kennung im Dateinamen; der vorige Stand bleibt als Version).",
                      "Changes made in the repository are taken over first (records by their flowplan.id, documents by the id in their file name; the previous state stays as a version).",
                    )
                  : t(
                      "Änderungen im Repository werden nicht übernommen (EXPORT_GIT_IMPORT=true schaltet das ein).",
                      "Changes made in the repository are not taken over (EXPORT_GIT_IMPORT=true turns this on).",
                    )
              }
            >
              <code className="admin-break">
                {git.url} ({git.branch})
              </code>
            </SettingRow>
            {git.last && (
              <SettingRow
                label={t("Zuletzt", "Last")}
                description={
                  git.last.error
                    ? serverMessage(git.last.error)
                    : `${git.last.pushed ? t("übertragen", "pushed") : t("keine Änderungen", "no changes")}${git.last.commit ? ` (${git.last.commit.slice(0, 7)})` : ""}${git.last.imported ? t(` · ${git.last.imported} aus Git übernommen`, ` · ${git.last.imported} taken over from Git`) : ""}`
                }
              >
                <span className="setting-value">{when(git.last.at)}</span>
              </SettingRow>
            )}
          </>
        )}
      </SettingGroup>
    </div>
  );
}
