"use client";
import { useEffect, useState } from "react";
import { Copy, GitBranch } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { api } from "./ui";

type Config = { token: string; secret: string; createdAt: string } | null;

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
  useEffect(() => {
    void api<Config>(`/api/git-config?page=${pageId}`)
      .then(setConfig)
      .catch(() => setConfig(null));
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
                setConfig((await act({ action: "git.setup" })) as Config);
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
          {editable && (
            <div className="modal-actions">
              <button
                className="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    setConfig((await act({ action: "git.setup" })) as Config);
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
