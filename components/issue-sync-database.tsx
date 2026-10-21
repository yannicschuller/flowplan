"use client";
import { useEffect, useState } from "react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { ArrowsClockwise, GithubLogo, GitlabLogo } from "@phosphor-icons/react";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useT } from "./i18n";
import { Select } from "./select";
import { api, Modal } from "./ui";
import type { Database, Field, Page } from "@/lib/types";

// GitHub/GitLab issue sync of a database (lib/issue-sync.ts): the entry in
// the "…" menu, the mapping dialog with the sync status, and the
// "GitHub #123" chip on records.

type Provider = "github" | "gitlab";
type StatusEntry = { value: string; state: "open" | "closed"; label: string };
type Config = {
  direction: "both" | "pull" | "push";
  title: string;
  body: string;
  status: { field: string; map: StatusEntry[] } | null;
  labels: string;
  assignee: string;
  milestone: string;
  number: string;
  url: string;
  comments: { pull: boolean; push: boolean };
  importExisting: boolean;
};
type MapState = { lastPull?: number; lastPush?: number; error?: string | null; pulled?: number; pushed?: number; conflicts?: number; skipped?: number };
type Status = {
  manage: boolean;
  connections: { id: string; provider: Provider; baseUrl: string; repo: string }[];
  map: { connectionId: string; provider: Provider; repo: string; config: Config; state: MapState; links: number } | null;
};
const OPEN_EVENT = "flowplan:issue-sync";

// One line in the "…" menu of a database.
export function IssueSyncMenuItem({ pageId }: { pageId: string }) {
  const t = useT();
  return (
    <Dropdown.Item className="dropdown-item" onSelect={() => window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: pageId }))}>
      <GithubLogo />
      <span>{t("Issues synchronisieren", "Sync issues")}</span>
    </Dropdown.Item>
  );
}

function defaults(fields: Field[]): Config {
  const of = (type: string) => fields.find((f) => f.type === type)?.id || "";
  const status = fields.find((f) => f.type === "select");
  return {
    direction: "both",
    title: fields[0]?.id || "",
    body: "@document",
    status: status
      ? {
          field: status.id,
          map: (status.options || []).map((value, index, all) => ({ value, state: index === all.length - 1 ? "closed" : "open", label: "" })),
        }
      : null,
    labels: of("multiselect"),
    assignee: of("person"),
    milestone: "",
    number: "",
    url: "",
    comments: { pull: true, push: false },
    importExisting: false,
  };
}

// The dialog: opened from the menu item, mounted once next to the menu.
export function IssueSyncDialog({ page, database, editable }: { page: Page; database: Database; editable: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [connectionId, setConnectionId] = useState("");
  const [repo, setRepo] = useState("");
  const [config, setConfig] = useState<Config>(() => defaults(database.fields));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    const listener = (event: Event) => {
      if ((event as CustomEvent<string>).detail === page.id) setOpen(true);
    };
    window.addEventListener(OPEN_EVENT, listener);
    return () => window.removeEventListener(OPEN_EVENT, listener);
  }, [page.id]);
  const load = async () => {
    const next = await api<Status>(`/api/issue-sync?page=${page.id}`);
    setStatus(next);
    if (next.map) {
      setConnectionId(next.map.connectionId);
      setRepo(next.map.repo);
      setConfig({ ...defaults(database.fields), ...next.map.config });
    } else if (next.connections[0]) {
      setConnectionId(next.connections[0].id);
      setRepo(next.connections[0].repo);
    }
  };
  useEffect(() => {
    if (open) void load().catch((error) => setMessage((error as Error).message));
  }, [open, page.id]);
  const work = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setMessage("");
    try {
      await fn();
      await load();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const fields = database.fields;
  const choose = (types: string[], value: string, set: (id: string) => void, extra?: { value: string; label: string }) => (
    <Select value={value} onChange={(e) => set(e.target.value)} disabled={busy || !status?.manage}>
      <option value="">{t("– nicht zuordnen –", "– not mapped –")}</option>
      {extra && <option value={extra.value}>{extra.label}</option>}
      {fields
        .filter((f) => types.includes(f.type))
        .map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
    </Select>
  );
  const statusField = fields.find((f) => f.id === config.status?.field);
  const setStatusField = (id: string) => {
    const field = fields.find((f) => f.id === id);
    setConfig({ ...config, status: field ? defaults([field]).status : null });
  };
  const setEntry = (value: string, patch: Partial<StatusEntry>) => {
    if (!config.status || !statusField) return;
    const map = (statusField.options || []).map((option) => {
      const entry = config.status!.map.find((m) => m.value === option) || { value: option, state: "open" as const, label: "" };
      return option === value ? { ...entry, ...patch } : entry;
    });
    setConfig({ ...config, status: { ...config.status, map } });
  };
  const when = (at?: number) => (at ? new Date(at).toLocaleString(LOCALE_TAG) : "–");
  const state = status?.map?.state;
  const connection = status?.connections.find((c) => c.id === connectionId);
  return (
    <Modal open={open} onClose={() => setOpen(false)} title={t(`Issues synchronisieren · ${page.title}`, `Sync issues · ${page.title}`)} wide>
      {!status ? (
        <p className="muted">{message || t("Wird geladen …", "Loading …")}</p>
      ) : (
        <div className="git-settings issue-sync-dialog">
          <p className="muted">
            {t(
              "Einträge dieser Datenbank und die Issues eines GitHub- oder GitLab-Repositorys halten sich gegenseitig aktuell. Ändern sich beide Seiten, gewinnt die spätere Änderung (im Prüfprotokoll vermerkt). Neue Einträge werden zu Issues, sobald die Zuordnung gespeichert ist.",
              "Records of this database and the issues of a GitHub or GitLab repository keep each other up to date. When both sides change, the later change wins (noted in the audit log). New records become issues once the mapping is saved.",
            )}
          </p>
          {status.map && (
            <p className={state?.error ? "error" : "muted"} role="status">
              {status.map.provider === "github" ? <GithubLogo aria-hidden /> : <GitlabLogo aria-hidden />} {status.map.repo} · {status.map.links}{" "}
              {t("verknüpfte Einträge", "linked records")} · {t("Zuletzt abgerufen", "Last pull")} {when(state?.lastPull)} · {t("Zuletzt übertragen", "Last push")}{" "}
              {when(state?.lastPush)}
              {state?.conflicts ? ` · ${t(`${state.conflicts} Konflikte`, `${state.conflicts} conflicts`)}` : ""}
              {state?.skipped ? ` · ${t(`${state.skipped} übersprungen (keine Leserechte)`, `${state.skipped} skipped (no read access)`)}` : ""}
              {state?.error ? ` · ${state.error}` : ""}
            </p>
          )}
          {!status.manage ? (
            !status.map && <p className="muted">{t("Nicht verbunden. Eigentümer des Arbeitsbereichs richten das ein.", "Not connected. Workspace owners set this up.")}</p>
          ) : !status.connections.length ? (
            <p className="callout-inline">
              {t("Verbinde zuerst GitHub oder GitLab in den Einstellungen unter „API & Webhooks“.", "First connect GitHub or GitLab in the settings under “API & webhooks”.")}
            </p>
          ) : (
            <>
              <div className="issue-sync-grid">
                <label>
                  {t("Verbindung", "Connection")}
                  <Select
                    value={connectionId}
                    onChange={(e) => {
                      setConnectionId(e.target.value);
                      setRepo(status.connections.find((c) => c.id === e.target.value)?.repo || "");
                    }}
                    disabled={busy}
                  >
                    {status.connections.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.provider === "github" ? "GitHub" : "GitLab"}
                        {c.baseUrl ? ` · ${c.baseUrl}` : ""}
                        {c.repo ? ` · ${c.repo}` : ""}
                      </option>
                    ))}
                  </Select>
                </label>
                <label>
                  {connection?.provider === "gitlab" ? t("Projekt", "Project") : t("Repository", "Repository")}
                  <input value={repo} onChange={(e) => setRepo(e.target.value)} maxLength={300} disabled={busy} placeholder="owner/name" />
                </label>
                <label>
                  {t("Richtung", "Direction")}
                  <Select value={config.direction} onChange={(e) => setConfig({ ...config, direction: e.target.value as Config["direction"] })} disabled={busy}>
                    <option value="both">{t("In beide Richtungen", "Both ways")}</option>
                    <option value="pull">{t("Nur Issues → Datenbank", "Only issues → database")}</option>
                    <option value="push">{t("Nur Datenbank → Issues", "Only database → issues")}</option>
                  </Select>
                </label>
                <label>
                  {t("Titel", "Title")}
                  {choose(["text", "url", "email", "phone"], config.title, (title) => setConfig({ ...config, title }))}
                </label>
                <label>
                  {t("Beschreibung (Markdown)", "Description (Markdown)")}
                  {choose(["text"], config.body, (body) => setConfig({ ...config, body }), { value: "@document", label: t("Dokument des Eintrags", "The record's document") })}
                </label>
                <label>
                  {t("Status ↔ offen/geschlossen", "Status ↔ open/closed")}
                  {choose(["select"], config.status?.field || "", setStatusField)}
                </label>
                <label>
                  {t("Labels", "Labels")}
                  {choose(["multiselect"], config.labels, (labels) => setConfig({ ...config, labels }))}
                </label>
                <label>
                  {t("Zuständig ↔ Assignee", "Assignee")}
                  {choose(["person"], config.assignee, (assignee) => setConfig({ ...config, assignee }))}
                </label>
                <label>
                  {t("Datum ↔ Fälligkeit des Meilensteins", "Date ↔ milestone due date")}
                  {choose(["date"], config.milestone, (milestone) => setConfig({ ...config, milestone }))}
                </label>
                <label>
                  {t("Issue-Nummer (nur lesen)", "Issue number (read-only)")}
                  {choose(["number", "text"], config.number, (number) => setConfig({ ...config, number }))}
                </label>
                <label>
                  {t("Issue-Adresse (nur lesen)", "Issue address (read-only)")}
                  {choose(["url", "text"], config.url, (url) => setConfig({ ...config, url }))}
                </label>
              </div>
              {config.status && statusField && (
                <table className="issue-sync-status">
                  <thead>
                    <tr>
                      <th>{statusField.name}</th>
                      <th>{t("Issue", "Issue")}</th>
                      <th>{t("Label (optional)", "Label (optional)")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(statusField.options || []).map((option) => {
                      const entry = config.status!.map.find((m) => m.value === option);
                      return (
                        <tr key={option}>
                          <td>{option}</td>
                          <td>
                            <Select value={entry?.state || "open"} onChange={(e) => setEntry(option, { state: e.target.value as "open" | "closed" })} disabled={busy}>
                              <option value="open">{t("offen", "open")}</option>
                              <option value="closed">{t("geschlossen", "closed")}</option>
                            </Select>
                          </td>
                          <td>
                            <input value={entry?.label || ""} onChange={(e) => setEntry(option, { label: e.target.value })} maxLength={100} disabled={busy} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              <label className="checkbox-label">
                <input type="checkbox" checked={config.comments.pull} onChange={(e) => setConfig({ ...config, comments: { ...config.comments, pull: e.target.checked } })} disabled={busy} />
                <span>{t("Issue-Kommentare als Kommentare am Eintrag übernehmen", "Take issue comments over as record comments")}</span>
              </label>
              <label className="checkbox-label">
                <input type="checkbox" checked={config.comments.push} onChange={(e) => setConfig({ ...config, comments: { ...config.comments, push: e.target.checked } })} disabled={busy} />
                <span>{t("Kommentare am Eintrag als Issue-Kommentare senden", "Send record comments as issue comments")}</span>
              </label>
              <label className="checkbox-label">
                <input type="checkbox" checked={config.importExisting} onChange={(e) => setConfig({ ...config, importExisting: e.target.checked })} disabled={busy} />
                <span>{t("Auch bestehende Issues übernehmen", "Also take over existing issues")}</span>
              </label>
            </>
          )}
          {message && (
            <p className="error" role="alert">
              {message}
            </p>
          )}
          <div className="modal-actions">
            {status.map && editable && (
              <button type="button" className="button" disabled={busy} onClick={() => void work(() => api("/api/issue-sync", { op: "run", pageId: page.id }))}>
                <ArrowsClockwise /> {t("Jetzt synchronisieren", "Sync now")}
              </button>
            )}
            {status.manage && status.map && (
              <button type="button" className="button danger" disabled={busy} onClick={() => void work(() => api("/api/command", { action: "issueSync.unmap", pageId: page.id }))}>
                {t("Trennen", "Disconnect")}
              </button>
            )}
            {status.manage && status.connections.length > 0 && (
              <button
                type="button"
                className="button primary"
                disabled={busy || !connectionId || !config.title}
                onClick={() => void work(() => api("/api/command", { action: "issueSync.map", pageId: page.id, connectionId, repo: repo.trim(), config }))}
              >
                {t("Zuordnung speichern", "Save mapping")}
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

// "GitHub #123" on a record with a linked issue.
export function IssueSyncChip({ pageId, rowId }: { pageId: string; rowId: string }) {
  const [link, setLink] = useState<{ provider: Provider; label: string; url: string } | null>(null);
  useEffect(() => {
    let alive = true;
    void api<{ provider: Provider; label: string; url: string } | null>(`/api/issue-sync?page=${pageId}&row=${rowId}`)
      .then((next) => alive && setLink(next))
      .catch(() => alive && setLink(null));
    return () => {
      alive = false;
    };
  }, [pageId, rowId]);
  if (!link) return null;
  return (
    <a className="issue-sync-chip" href={link.url} target="_blank" rel="noreferrer">
      {link.provider === "github" ? <GithubLogo aria-hidden /> : <GitlabLogo aria-hidden />}
      {link.label}
    </a>
  );
}
