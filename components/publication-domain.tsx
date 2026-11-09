"use client";
// The custom domain and look of a publication (lib/custom-domains.ts): the
// owner enters a host name, sets the TXT record shown here (the only proof
// accepted), verifies, and picks logo, accent colour, favicon and footer
// text. In the share dialog's "Web" tab: the domain as one row that unfolds,
// the look folded away under "Aussehen".
import { useT } from "./i18n";
import { useCallback, useEffect, useId, useState } from "react";
import { CaretRight, Copy } from "@phosphor-icons/react";
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
  } | null;
  theme: Theme;
};
const DEFAULT_ACCENT = "#3b3fd8";

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
  const id = useId();
  const [state, setState] = useState<DomainState | null>(null),
    [host, setHost] = useState(""),
    [theme, setTheme] = useState<Theme>({}),
    [busy, setBusy] = useState(false),
    [open, setOpen] = useState(false);
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
  const domain = state.domain;
  const accent = theme.accent || DEFAULT_ACCENT;
  return (
    <>
      {state.enabled && (
        <div className="sh-opt-block">
          <div className="sh-opt">
            <span className="sh-opt-label" id={`${id}-domain`}>
              {t("Eigene Domain", "Custom domain")}
            </span>
            <button
              type="button"
              className="sh-value"
              aria-expanded={open}
              aria-controls={`${id}-domain-panel`}
              aria-describedby={`${id}-domain`}
              onClick={() => setOpen(!open)}
            >
              {domain ? (
                <>
                  {domain.host}
                  {!domain.verified && <span className="sh-value-note">{t("· noch nicht bestätigt", "· not verified yet")}</span>}
                </>
              ) : (
                t("Keine", "None")
              )}
              <CaretRight className="sh-caret" aria-hidden />
            </button>
          </div>
          <div className="sh-opt-panel publication-domain" id={`${id}-domain-panel`} hidden={!open}>
            {password ? (
              <p className="muted">{t("Veröffentlichungen mit Passwort lassen sich nicht unter einer eigenen Domain zeigen.", "Publications with a password cannot be shown under a custom domain.")}</p>
            ) : domain ? (
              <>
                <p>
                  <strong>{domain.host}</strong>{" "}
                  <span className={domain.verified ? "domain-verified" : "muted"}>
                    {domain.verified ? t("· bestätigt", "· verified") : t("· noch nicht bestätigt", "· not verified yet")}
                  </span>
                </p>
                {!domain.verified && (
                  <>
                    <p className="muted">
                      {t(
                        "Lege diesen TXT-Eintrag bei deinem DNS-Anbieter an und richte die Domain per CNAME oder A-Eintrag auf diese Instanz. Bestätigt wird die Domain nur über den TXT-Eintrag. Das Zertifikat besorgt der Reverse Proxy.",
                        "Create this TXT record at your DNS provider and point the domain to this instance with a CNAME or A record. Only the TXT record verifies the domain. The reverse proxy obtains the certificate.",
                      )}
                    </p>
                    <div className="domain-record">
                      <code>{domain.record.type}</code>
                      <code>{domain.record.name}</code>
                      <code>{domain.record.value}</code>
                      <button className="icon-button" aria-label={t("Wert kopieren", "Copy value")} onClick={() => copy(domain.record.value)}>
                        <Copy size={14} />
                      </button>
                    </div>
                    {domain.lastError && <p className="form-error">{domain.lastError}</p>}
                  </>
                )}
                {editable && (
                  <div className="domain-actions">
                    {!domain.verified && (
                      <button className="button compact primary" disabled={busy} onClick={() => void run("/api/domains/verify", { pageId })}>
                        {busy ? t("Wird geprüft …", "Checking …") : t("Jetzt prüfen", "Check now")}
                      </button>
                    )}
                    <button className="button compact" disabled={busy} onClick={() => void run("/api/command", { action: "domain.remove", pageId })}>
                      {t("Domain entfernen", "Remove domain")}
                    </button>
                  </div>
                )}
              </>
            ) : editable ? (
              <div className="domain-add">
                <input value={host} placeholder="docs.example.org" aria-label={t("Domain", "Domain")} onChange={(e) => setHost(e.target.value)} />
                <button
                  className="button compact"
                  disabled={busy || !host.trim()}
                  onClick={() => void run("/api/command", { action: "domain.add", pageId, host: host.trim() })}
                >
                  {t("Domain hinzufügen", "Add domain")}
                </button>
              </div>
            ) : (
              <p className="muted">{t("Keine eigene Domain.", "No custom domain.")}</p>
            )}
          </div>
        </div>
      )}
      <details className="sh-appearance">
        <summary>
          <CaretRight className="sh-caret" aria-hidden />
          <strong>{t("Aussehen", "Appearance")}</strong>
          <small>{t("Logo, Favicon, Akzentfarbe, Fußzeile", "Logo, favicon, accent colour, footer")}</small>
        </summary>
        <div className="sh-appearance-body">
          {field("logo", t("Logo (HTTPS-Adresse oder /api/files/…)", "Logo (HTTPS address or /api/files/…)"), "https://example.org/logo.svg")}
          {field("favicon", t("Favicon", "Favicon"), "https://example.org/favicon.png")}
          <div className="sh-grid-2">
            <div className="field-group">
              <span id={`${id}-accent`}>{t("Akzentfarbe", "Accent colour")}</span>
              <span className="sh-color">
                <input
                  type="color"
                  aria-labelledby={`${id}-accent`}
                  disabled={!editable}
                  value={accent}
                  onChange={(e) => setTheme({ ...theme, accent: e.target.value })}
                />
                <code>{accent}</code>
              </span>
            </div>
            {field("footer", t("Text in der Fußzeile", "Footer text"), t("z. B. © Muster GmbH", "e.g. © Example Ltd"))}
          </div>
          <div className="sh-opt">
            <span className="sh-opt-label" id={`${id}-branding`}>
              {t("„Mit Flowplan veröffentlicht“ ausblenden", "Hide “Published with Flowplan”")}
            </span>
            <button
              type="button"
              role="switch"
              className="switch"
              aria-checked={!!theme.hideBranding}
              aria-labelledby={`${id}-branding`}
              disabled={!editable}
              onClick={() => setTheme({ ...theme, hideBranding: !theme.hideBranding })}
            >
              <span />
            </button>
          </div>
          {editable && (
            <div className="sh-form-actions">
              <button className="button compact" disabled={busy} onClick={() => void run("/api/command", { action: "publication.theme", pageId, theme })}>
                {t("Aussehen speichern", "Save appearance")}
              </button>
            </div>
          )}
        </div>
      </details>
    </>
  );
}
