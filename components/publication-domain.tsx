"use client";
// The custom domain and look of a publication (lib/custom-domains.ts): the
// owner enters a host name, sets the TXT record shown here (or serves the
// verification file), verifies, and picks logo, accent colour, favicon and
// footer text.
import { useT } from "./i18n";
import { useCallback, useEffect, useState } from "react";
import { Copy } from "@phosphor-icons/react";
import { api } from "./ui";

type Theme = { logo?: string; favicon?: string; accent?: string; footer?: string; hideBranding?: boolean };
type DomainState = {
  enabled: boolean;
  domain: {
    host: string;
    verified: boolean;
    checkedAt: number | null;
    lastError: string | null;
    record: { type: string; name: string; value: string };
    file: { url: string; content: string };
  } | null;
  theme: Theme;
};

export function PublicationDomain({
  pageId,
  editable,
  password,
  onError,
}: {
  pageId: string;
  editable: boolean;
  password: boolean;
  onError: (message: string) => void;
}) {
  const t = useT();
  const [state, setState] = useState<DomainState | null>(null),
    [host, setHost] = useState(""),
    [theme, setTheme] = useState<Theme>({}),
    [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const next = await api<DomainState>(`/api/domains?page=${pageId}`);
      setState(next);
      setTheme(next.theme);
    } catch (e) {
      onError((e as Error).message);
    }
  }, [pageId, onError]);
  useEffect(() => void load(), [load]);
  const run = async (url: string, body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const next = await api<DomainState>(url, body);
      setState(next);
      setTheme(next.theme);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!state) return null;
  const copy = (value: string) => void navigator.clipboard.writeText(value).catch(() => {});
  const field = (key: "logo" | "favicon" | "footer", label: string, placeholder: string) => (
    <label className="publication-theme-field">
      <span>{label}</span>
      <input
        disabled={!editable}
        value={theme[key] || ""}
        placeholder={placeholder}
        maxLength={key === "footer" ? 300 : 500}
        onChange={(e) => setTheme({ ...theme, [key]: e.target.value })}
      />
    </label>
  );
  return (
    <div className="publication-domain">
      <h4>{t("Aussehen", "Appearance")}</h4>
      {field("logo", t("Logo (HTTPS-Adresse oder /api/files/…)", "Logo (HTTPS address or /api/files/…)"), "https://example.org/logo.svg")}
      {field("favicon", t("Favicon", "Favicon"), "https://example.org/favicon.png")}
      <label className="publication-theme-field">
        <span>{t("Akzentfarbe", "Accent colour")}</span>
        <input
          type="color"
          disabled={!editable}
          value={theme.accent || "#3b3fd8"}
          onChange={(e) => setTheme({ ...theme, accent: e.target.value })}
        />
      </label>
      {field("footer", t("Text in der Fußzeile", "Footer text"), t("z. B. © Muster GmbH", "e.g. © Example Ltd"))}
      <label className="checkbox-label">
        <input
          type="checkbox"
          disabled={!editable}
          checked={!!theme.hideBranding}
          onChange={(e) => setTheme({ ...theme, hideBranding: e.target.checked })}
        />
        {t("„Mit Flowplan veröffentlicht“ ausblenden", "Hide “Published with Flowplan”")}
      </label>
      {editable && (
        <button className="button" disabled={busy} onClick={() => void run("/api/command", { action: "publication.theme", pageId, theme })}>
          {t("Aussehen speichern", "Save appearance")}
        </button>
      )}
      {state.enabled && (
        <>
          <h4>{t("Eigene Domain", "Custom domain")}</h4>
          {password ? (
            <p className="muted">{t("Veröffentlichungen mit Passwort lassen sich nicht unter einer eigenen Domain zeigen.", "Publications with a password cannot be shown under a custom domain.")}</p>
          ) : state.domain ? (
            <>
              <p>
                <strong>{state.domain.host}</strong>{" "}
                <span className={state.domain.verified ? "domain-verified" : "muted"}>
                  {state.domain.verified ? t("· bestätigt", "· verified") : t("· noch nicht bestätigt", "· not verified yet")}
                </span>
              </p>
              {!state.domain.verified && (
                <>
                  <p className="muted">
                    {t(
                      "Lege diesen TXT-Eintrag bei deinem DNS-Anbieter an (oder liefere die Prüfdatei unter der Domain aus) und richte die Domain per CNAME oder A-Eintrag auf diese Instanz. Das Zertifikat besorgt der Reverse Proxy.",
                      "Create this TXT record at your DNS provider (or serve the verification file under the domain) and point the domain to this instance with a CNAME or A record. The reverse proxy obtains the certificate.",
                    )}
                  </p>
                  <div className="domain-record">
                    <code>{state.domain.record.type}</code>
                    <code>{state.domain.record.name}</code>
                    <code>{state.domain.record.value}</code>
                    <button className="icon-button" aria-label={t("Wert kopieren", "Copy value")} onClick={() => copy(state.domain!.record.value)}>
                      <Copy size={14} />
                    </button>
                  </div>
                  <p className="muted">
                    {t("Oder als Datei:", "Or as a file:")} <code>{state.domain.file.url}</code>
                  </p>
                  {state.domain.lastError && <p className="form-error">{state.domain.lastError}</p>}
                </>
              )}
              {editable && (
                <div className="domain-actions">
                  {!state.domain.verified && (
                    <button className="button primary" disabled={busy} onClick={() => void run("/api/domains/verify", { pageId })}>
                      {busy ? t("Wird geprüft …", "Checking …") : t("Jetzt prüfen", "Check now")}
                    </button>
                  )}
                  <button className="button" disabled={busy} onClick={() => void run("/api/command", { action: "domain.remove", pageId })}>
                    {t("Domain entfernen", "Remove domain")}
                  </button>
                </div>
              )}
            </>
          ) : (
            editable && (
              <div className="domain-add">
                <input
                  value={host}
                  placeholder="docs.example.org"
                  aria-label={t("Domain", "Domain")}
                  onChange={(e) => setHost(e.target.value)}
                />
                <button
                  className="button"
                  disabled={busy || !host.trim()}
                  onClick={() => void run("/api/command", { action: "domain.add", pageId, host: host.trim() })}
                >
                  {t("Domain hinzufügen", "Add domain")}
                </button>
              </div>
            )
          )}
        </>
      )}
    </div>
  );
}
