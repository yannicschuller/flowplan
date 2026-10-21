"use client";
import { useEffect, useState } from "react";
import { Copy, GithubLogo, GitlabLogo, Plus, Trash } from "@phosphor-icons/react";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { serverMessage } from "@/lib/i18n-errors";
import { useT } from "./i18n";
import { Select } from "./select";
import { api } from "./ui";

type Provider = "github" | "gitlab";
type MapState = { lastPull?: number; lastPush?: number; error?: string | null; pulled?: number; pushed?: number; conflicts?: number };
type Connection = {
  id: string;
  provider: Provider;
  baseUrl: string;
  repo: string;
  tokenSet: boolean;
  people: { login: string; email: string }[];
  hookUrl: string;
  hookSecret: string;
  connectedBy: string;
  active: boolean;
  checkedAt: number | null;
  error: string | null;
  backoffUntil: number | null;
  databases: { pageId: string; title: string; repo: string; state: MapState }[];
};
type Overview = { available: false } | { available: true; allowedHosts: string[]; connections: Connection[] };
type Draft = { id?: string; provider: Provider; baseUrl: string; repo: string; token: string; people: string };

const emptyDraft: Draft = { provider: "github", baseUrl: "", repo: "", token: "", people: "" };
// "login = e-mail" per line.
const parsePeople = (text: string) =>
  text
    .split("\n")
    .map((line) => line.split(/[=,;\s]+/).filter(Boolean))
    .filter((parts) => parts.length >= 2)
    .map(([login, email]) => ({ login, email }));
const when = (at?: number | null) => (at ? new Date(at).toLocaleString(LOCALE_TAG) : "");

// Workspace settings: GitHub/GitLab connections for the issue sync
// (lib/issue-sync.ts). Owners and administrators only; others see nothing.
export function IssueSyncSettings({ workspaceId, onError }: { workspaceId: string; onError: (message: string) => void }) {
  const t = useT();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [tested, setTested] = useState("");
  const [copied, setCopied] = useState("");
  const load = () =>
    api<Overview>(`/api/issue-sync?workspace=${workspaceId}`)
      .then(setOverview)
      .catch(() => setOverview(null));
  useEffect(() => {
    void load();
  }, [workspaceId]);
  if (!overview?.available) return null;
  const work = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      return true;
    } catch (error) {
      onError(serverMessage((error as Error).message));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const input = (d: Draft) => ({
    id: d.id,
    provider: d.provider,
    baseUrl: d.baseUrl.trim(),
    repo: d.repo.trim(),
    ...(d.token.trim() ? { token: d.token.trim() } : {}),
    people: parsePeople(d.people),
  });
  const test = (d: Draft) =>
    work(async () => {
      setTested("");
      const result = await api<{ repo: string }>("/api/issue-sync", { op: "test", workspaceId, ...input(d) });
      setTested(t(`Verbunden mit ${result.repo}.`, `Connected to ${result.repo}.`));
    });
  const save = (d: Draft) =>
    work(async () => {
      await api("/api/command", { action: "issueSync.connect", workspaceId, ...input(d) });
      setDraft(null);
      setTested("");
      await load();
    });
  const remove = (c: Connection) => {
    if (!confirm(t("Verbindung entfernen? Die Synchronisierung der verbundenen Datenbanken endet; Einträge und Issues bleiben.", "Remove the connection? The sync of the connected databases ends; records and issues stay."))) return;
    void work(async () => {
      await api("/api/command", { action: "issueSync.disconnect", workspaceId, id: c.id });
      await load();
    });
  };
  const copy = async (text: string, what: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(what);
    setTimeout(() => setCopied(""), 1500);
  };
  const Logo = ({ provider }: { provider: Provider }) => (provider === "github" ? <GithubLogo aria-hidden /> : <GitlabLogo aria-hidden />);
  return (
    <section className="settings-section issue-sync-settings">
      <h2>{t("GitHub- und GitLab-Issues", "GitHub and GitLab issues")}</h2>
      <p className="muted">
        {t(
          "Verbinde einen Anbieter, um Datenbanken mit den Issues eines Repositorys zu synchronisieren – in beide Richtungen oder nur in eine. Die Zuordnung legst du in der Datenbank fest („…“ → Issues synchronisieren). Die Synchronisierung handelt als die Person, die die Verbindung einrichtet.",
          "Connect a provider to sync databases with the issues of a repository – both ways or only one. The mapping is set in the database (“…” → Sync issues). The sync acts as the person who sets up the connection.",
        )}
      </p>
      {overview.connections.map((c) => (
        <div key={c.id} className="issue-sync-connection">
          <h3>
            <Logo provider={c.provider} /> {c.provider === "github" ? "GitHub" : "GitLab"}
            {c.baseUrl ? ` · ${c.baseUrl}` : ""}
            {c.repo ? ` · ${c.repo}` : ""}
          </h3>
          <p className={c.active && !c.error ? "muted" : "error"}>
            {t("Verbunden von", "Connected by")} {c.connectedBy || "?"}
            {!c.active && ` · ${t("pausiert: die Person ist nicht mehr Eigentümer – bitte das Token neu speichern", "paused: the person is no longer an owner – please save the token again")}`}
            {c.error ? ` · ${serverMessage(c.error)}` : ""}
            {c.backoffUntil ? ` · ${t("Ratenlimit bis", "Rate limit until")} ${when(c.backoffUntil)}` : ""}
          </p>
          <label>
            {t("Webhook-Adresse (Ereignisse: Issues, Kommentare)", "Webhook address (events: issues, comments)")}
            <div className="copy-field">
              <input readOnly value={c.hookUrl} onFocus={(e) => e.target.select()} />
              <button type="button" className="button compact" onClick={() => void copy(c.hookUrl, `url-${c.id}`)}>
                <Copy /> {copied === `url-${c.id}` ? t("Kopiert", "Copied") : t("Kopieren", "Copy")}
              </button>
            </div>
          </label>
          {c.hookSecret && (
            <label>
              {c.provider === "github" ? t("Secret", "Secret") : t("Secret token", "Secret token")}
              <div className="copy-field">
                <input readOnly value={c.hookSecret} onFocus={(e) => e.target.select()} />
                <button type="button" className="button compact" onClick={() => void copy(c.hookSecret, `secret-${c.id}`)}>
                  <Copy /> {copied === `secret-${c.id}` ? t("Kopiert", "Copied") : t("Kopieren", "Copy")}
                </button>
              </div>
            </label>
          )}
          {c.databases.length > 0 && (
            <ul className="issue-sync-databases">
              {c.databases.map((d) => (
                <li key={d.pageId}>
                  <strong>{d.title}</strong> ↔ {d.repo}
                  <span className={d.state.error ? "error" : "muted"}>
                    {d.state.lastPull ? ` · ${t("Abgerufen", "Pulled")} ${when(d.state.lastPull)}` : ""}
                    {d.state.lastPush ? ` · ${t("Übertragen", "Pushed")} ${when(d.state.lastPush)}` : ""}
                    {d.state.error ? ` · ${serverMessage(d.state.error)}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="lifecycle-buttons">
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => {
                setTested("");
                setDraft({ id: c.id, provider: c.provider, baseUrl: c.baseUrl, repo: c.repo, token: "", people: c.people.map((p) => `${p.login} = ${p.email}`).join("\n") });
              }}
            >
              {t("Bearbeiten", "Edit")}
            </button>
            <button type="button" className="button danger" disabled={busy} onClick={() => remove(c)}>
              <Trash /> {t("Entfernen", "Remove")}
            </button>
          </div>
        </div>
      ))}
      {draft ? (
        <div className="git-settings issue-sync-form">
          <label>
            {t("Anbieter", "Provider")}
            <Select value={draft.provider} onChange={(e) => setDraft({ ...draft, provider: e.target.value as Provider })} disabled={busy}>
              <option value="github">GitHub</option>
              <option value="gitlab">GitLab</option>
            </Select>
          </label>
          <label>
            {t("Server (leer für github.com bzw. gitlab.com)", "Server (empty for github.com or gitlab.com)")}
            <input type="url" value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} placeholder="https://gitlab.example.org" maxLength={500} disabled={busy} autoComplete="off" />
            <small className="muted">
              {overview.allowedHosts.length
                ? `${t("Erlaubte eigene Server:", "Allowed own servers:")} ${overview.allowedHosts.join(", ")}`
                : t("Eigene Server gibt die Administration mit ISSUE_SYNC_ALLOWED_HOSTS frei.", "The administrators allow own servers with ISSUE_SYNC_ALLOWED_HOSTS.")}
            </small>
          </label>
          <label>
            {draft.provider === "github" ? t("Repository (besitzer/name)", "Repository (owner/name)") : t("Projekt (gruppe/projekt)", "Project (group/project)")}
            <input value={draft.repo} onChange={(e) => setDraft({ ...draft, repo: e.target.value })} placeholder={draft.provider === "github" ? "acme/web" : "team/app"} maxLength={300} disabled={busy} autoComplete="off" />
          </label>
          <label>
            {t("Zugangstoken (Issues lesen und schreiben)", "Access token (read and write issues)")}
            <input
              type="password"
              value={draft.token}
              onChange={(e) => setDraft({ ...draft, token: e.target.value })}
              placeholder={draft.id ? t("Gespeichert – leer lassen, um es zu behalten", "Stored – leave empty to keep it") : ""}
              maxLength={1000}
              disabled={busy}
              autoComplete="new-password"
            />
          </label>
          <label>
            {t("Personen: je Zeile „Login = E-Mail“ eines Mitglieds (für Zuständige)", "People: one “login = e-mail” of a member per line (for assignees)")}
            <textarea value={draft.people} onChange={(e) => setDraft({ ...draft, people: e.target.value })} rows={3} disabled={busy} placeholder="octocat = ada@example.org" />
          </label>
          {tested && <p className="muted" role="status">{tested}</p>}
          <div className="lifecycle-buttons">
            <button type="button" className="button" disabled={busy || !draft.repo.trim() || (!draft.token.trim() && !draft.id)} onClick={() => void test(draft)}>
              {t("Verbindung testen", "Test connection")}
            </button>
            <button type="button" className="button primary" disabled={busy || (!draft.token.trim() && !draft.id)} onClick={() => void save(draft)}>
              {t("Speichern", "Save")}
            </button>
            <button type="button" className="button" disabled={busy} onClick={() => setDraft(null)}>
              {t("Abbrechen", "Cancel")}
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="button" onClick={() => setDraft({ ...emptyDraft })}>
          <Plus /> {t("GitHub oder GitLab verbinden", "Connect GitHub or GitLab")}
        </button>
      )}
    </section>
  );
}
