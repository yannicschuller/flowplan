"use client";
import { useEffect, useState } from "react";
import { ChatCircleText, Copy, GitBranch } from "@phosphor-icons/react";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { serverMessage } from "@/lib/i18n-errors";
import { useT } from "./i18n";
import { ISSUE_PROVIDER_NAMES, type IssueProvider as Provider } from "./issue-provider";
import { Select } from "./select";
import { CONTROL, StatusBadge } from "./settings-ui";
import { api } from "./ui";

type Access = { provider: Provider; web: string; setAt: string } | null;
type BackLink = { url: string; at: number; status: number | null; error: string | null } | null;
type Config = { token: string; secret: string; createdAt: string; access?: Access; backLink?: BackLink; allowedHosts?: string[] } | null;

// Setting up the Git webhook of a database: address, secret and the steps
// for GitHub, GitLab and Gitea/Forgejo.
export function GitSettings({
  pageId,
  hasIds,
  editable,
  act,
}: {
  pageId: string;
  hasIds: boolean;
  editable: boolean;
  act: (b: Record<string, unknown>) => Promise<unknown>;
}) {
  const t = useT();
  const [config, setConfig] = useState<Config | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState("");
  const load = () =>
    api<Config>(`/api/git-config?page=${pageId}`)
      .then(setConfig)
      .catch(() => setConfig(null));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId]);
  const url = config ? `${location.origin}/api/git/${config.token}` : "";
  const copy = async (text: string, what: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(what);
    setTimeout(() => setCopied(""), 1500);
  };
  if (config === undefined) return <p className="muted">{t("Wird geladen …", "Loading …")}</p>;
  return (
    <div className="git-settings">
      <p className="muted">
        {t(
          "Commits und Pull Requests, die eine Ticketnummer wie WEB-123 nennen, erscheinen am Eintrag. „closes WEB-123“ (auch fixes, resolves, schließt, behebt) setzt ihn auf erledigt, sobald der Commit im Hauptbranch ist oder der Pull Request zusammengeführt wurde.",
          "Commits and pull requests that mention a ticket number like WEB-123 appear on the record. “closes WEB-123” (also fixes, resolves) marks it done once the commit is on the default branch or the pull request is merged.",
        )}
      </p>
      {!hasIds && (
        <p className="callout-inline">
          {t("Lege dafür eine Eigenschaft vom Typ „ID (Ticketnummer)“ an.", "For this, add a property of the type “ID (ticket number)”.")}
        </p>
      )}
      {!config ? (
        editable && (
          <button
            className="button primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                if (await act({ action: "git.setup" })) await load();
              } finally {
                setBusy(false);
              }
            }}
          >
            <GitBranch /> {t("Git-Anbindung einrichten", "Set up Git connection")}
          </button>
        )
      ) : (
        <>
          <label>
            {t("Webhook-Adresse (Payload URL)", "Webhook address (payload URL)")}
            <div className="copy-field">
              <input readOnly value={url} onFocus={(e) => e.target.select()} />
              <button type="button" className="button compact" onClick={() => void copy(url, "url")}>
                <Copy /> {copied === "url" ? t("Kopiert", "Copied") : t("Kopieren", "Copy")}
              </button>
            </div>
          </label>
          <label>
            {t("Secret (bei GitLab: Secret token)", "Secret (GitLab: secret token)")}
            <div className="copy-field">
              <input readOnly value={config.secret} onFocus={(e) => e.target.select()} />
              <button type="button" className="button compact" onClick={() => void copy(config.secret, "secret")}>
                <Copy /> {copied === "secret" ? t("Kopiert", "Copied") : t("Kopieren", "Copy")}
              </button>
            </div>
          </label>
          <details>
            <summary>GitHub</summary>
            <p>
              {t(
                "Repository → Settings → Webhooks → Add webhook: Adresse und Secret einfügen, Content type „application/json“, Ereignisse „Pushes“ und „Pull requests“.",
                "Repository → Settings → Webhooks → Add webhook: paste address and secret, content type “application/json”, events “Pushes” and “Pull requests”.",
              )}
            </p>
          </details>
          <details>
            <summary>GitLab</summary>
            <p>
              {t(
                "Projekt → Settings → Webhooks: Adresse, Secret token, Trigger „Push events“ und „Merge request events“.",
                "Project → Settings → Webhooks: address, secret token, triggers “Push events” and “Merge request events”.",
              )}
            </p>
          </details>
          <details>
            <summary>Gitea / Forgejo</summary>
            <p>
              {t(
                "Repository → Einstellungen → Webhooks → Gitea: Adresse, Secret, Content type JSON, Ereignisse „Push“ und „Pull Request“.",
                "Repository → Settings → Webhooks → Gitea: address, secret, content type JSON, events “Push” and “Pull request”.",
              )}
            </p>
          </details>
          <BackLinkSettings config={config} editable={editable} act={act} reload={load} />
          {editable && (
            <div className="modal-actions">
              <button
                className="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    if (await act({ action: "git.setup" })) await load();
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {t("Neue Adresse und neues Secret", "New address and secret")}
              </button>
              <button
                className="button danger"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    if (await act({ action: "git.disable" })) setConfig(null);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {t("Ausschalten", "Switch off")}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// The access token for the back-link comment on pull/merge requests (#184):
// optional; without it nothing is written to the Git server.
function BackLinkSettings({
  config,
  editable,
  act,
  reload,
}: {
  config: NonNullable<Config>;
  editable: boolean;
  act: (b: Record<string, unknown>) => Promise<unknown>;
  reload: () => Promise<void>;
}) {
  const t = useT();
  const [draft, setDraft] = useState<{ provider: Provider; baseUrl: string; token: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const access = config.access || null;
  const last = config.backLink || null;
  const scopes = (provider: Provider) =>
    provider === "github"
      ? t(
          "GitHub: Fine-grained Token mit Zugriff auf das Repository und „Pull requests: Read and write“ (oder „Issues: Read and write“).",
          "GitHub: fine-grained token with access to the repository and “Pull requests: Read and write” (or “Issues: Read and write”).",
        )
      : provider === "gitlab"
        ? t("GitLab: Projekt- oder persönliches Zugangstoken mit dem Bereich „api“ (Rolle mindestens Reporter).", "GitLab: project or personal access token with the scope “api” (role at least Reporter).")
        : t("Gitea / Forgejo: Zugangstoken mit „write:issue“ (und „read:repository“ für private Repositories).", "Gitea / Forgejo: access token with “write:issue” (and “read:repository” for private repositories).");
  const run = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      if (await act({ action: "git.token", ...body })) {
        setDraft(null);
        await reload();
      }
    } finally {
      setBusy(false);
    }
  };
  const forgejo = draft?.provider === "forgejo";
  return (
    <section className="git-backlink" aria-label={t("Rückverweis im Pull Request", "Back-link on the pull request")}>
      <h3>
        <ChatCircleText aria-hidden /> {t("Rückverweis im Pull Request", "Back-link on the pull request")}
      </h3>
      <p className="muted">
        {t(
          "Mit einem Zugangstoken schreibt Flowplan in jeden Pull/Merge Request, der eine Ticketnummer dieser Datenbank nennt, einen Kommentar mit dem Link zum Eintrag – und aktualisiert ihn später, statt neue zu schreiben. Er zeigt Ticketnummer und Titel; bei privaten Einträgen nur die Ticketnummer.",
          "With an access token, Flowplan comments on every pull/merge request that names a ticket number of this database with the link to the record – and later updates that comment instead of writing new ones. It shows the ticket number and title; for private records only the ticket number.",
        )}
      </p>
      {access ? (
        <p className="git-backlink-state">
          <StatusBadge tone={last?.error ? "error" : "ok"}>{last?.error ? t("Fehler", "Error") : t("Eingerichtet", "Set up||state")}</StatusBadge>{" "}
          {`${ISSUE_PROVIDER_NAMES[access.provider]} · ${access.web.replace(/^https:\/\//, "")}`}
        </p>
      ) : (
        <p className="muted">{t("Kein Zugangstoken – es wird nichts zurückgeschrieben.", "No access token – nothing is written back.")}</p>
      )}
      {access && last && (
        <p className={last.error ? "error small" : "muted small"} role={last.error ? "alert" : undefined}>
          {last.error
            ? `${t("Letzter Rückverweis fehlgeschlagen", "Last back-link failed")} (${new Date(last.at).toLocaleString(LOCALE_TAG)}): ${last.status ? `${last.status} ` : ""}${serverMessage(last.error)}`
            : `${t("Letzter Rückverweis", "Last back-link")}: ${new Date(last.at).toLocaleString(LOCALE_TAG)}`}
        </p>
      )}
      {editable && !draft && (
        <div className="modal-actions">
          <button type="button" className="button" disabled={busy} onClick={() => setDraft({ provider: access?.provider || "github", baseUrl: access && !/^https:\/\/(github|gitlab)\.com$/.test(access.web) ? access.web : "", token: "" })}>
            {access ? t("Token ersetzen", "Replace token") : t("Zugangstoken hinterlegen", "Add access token")}
          </button>
          {access && (
            <button type="button" className="button danger" disabled={busy} onClick={() => void run({ remove: true })}>
              {t("Token entfernen", "Remove token")}
            </button>
          )}
        </div>
      )}
      {editable && draft && (
        <div className="git-backlink-form" role="group" aria-label={t("Zugangstoken", "Access token")}>
          <label>
            {t("Anbieter", "Provider")}
            <Select className={CONTROL.md} value={draft.provider} onChange={(e) => setDraft({ ...draft, provider: e.target.value as Provider })} disabled={busy}>
              <option value="github">GitHub</option>
              <option value="gitlab">GitLab</option>
              <option value="forgejo">{ISSUE_PROVIDER_NAMES.forgejo}</option>
            </Select>
          </label>
          <label>
            {forgejo ? t("Server (z. B. https://codeberg.org)", "Server (e.g. https://codeberg.org)") : t("Server (leer für github.com bzw. gitlab.com)", "Server (empty for github.com or gitlab.com)")}
            <input
              className={CONTROL.lg}
              type="url"
              value={draft.baseUrl}
              onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
              placeholder={forgejo ? "https://codeberg.org" : "https://gitlab.example.org"}
              maxLength={500}
              disabled={busy}
              autoComplete="off"
            />
            <small className="muted">
              {config.allowedHosts?.length
                ? `${t("Erlaubte eigene Server:", "Allowed own servers:")} ${config.allowedHosts.join(", ")}`
                : t("Eigene Server gibt die Administration mit ISSUE_SYNC_ALLOWED_HOSTS frei.", "The administrators allow own servers with ISSUE_SYNC_ALLOWED_HOSTS.")}
            </small>
          </label>
          <label>
            {t("Zugangstoken", "Access token")}
            <input
              className={CONTROL.lg}
              type="password"
              value={draft.token}
              onChange={(e) => setDraft({ ...draft, token: e.target.value })}
              maxLength={1000}
              disabled={busy}
              autoComplete="new-password"
            />
            <small className="muted">{scopes(draft.provider)}</small>
          </label>
          <div className="modal-actions">
            <button
              type="button"
              className="button primary"
              disabled={busy || !draft.token.trim() || (forgejo && !draft.baseUrl.trim())}
              onClick={() => void run({ provider: draft.provider, baseUrl: draft.baseUrl.trim(), token: draft.token.trim() })}
            >
              {t("Speichern", "Save")}
            </button>
            <button type="button" className="button" disabled={busy} onClick={() => setDraft(null)}>
              {t("Abbrechen", "Cancel")}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
