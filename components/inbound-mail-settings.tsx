"use client";
// Settings → Allgemein (workspace) → "E-Mail-Eingang": addresses that turn incoming
// mail into pages or records (lib/inbound-mail.ts). Owners create them with
// a target, allowed senders and an optional signing key, copy the webhook
// URL (or the IMAP address), rotate the token and remove them.
import { useCallback, useEffect, useState } from "react";
import { ArrowsClockwise, Copy, EnvelopeSimple, Plus, Trash } from "@phosphor-icons/react";
import { LOCALE_TAG, tr } from "@/lib/locale-tag";
import { serverMessage } from "@/lib/i18n-errors";
import type { Page } from "@/lib/types";
import { useT } from "./i18n";
import { api } from "./ui";
import { Select } from "./select";
import { EmptyState, SettingGroup, StatusBadge } from "./settings-ui";

type Address = {
  id: string;
  label: string;
  pageId: string;
  target: { title: string; kind: string; deleted: boolean };
  senders: string[];
  signed: boolean;
  webhookUrl: string;
  email: string;
  lastReceivedAt: number | null;
  lastError: string | null;
  received: number;
};
type Listing = { imap: boolean; domain: string; addresses: Address[] };

const when = (ms: number | null) =>
  ms ? new Date(ms).toLocaleString(LOCALE_TAG, { dateStyle: "short", timeStyle: "short" }) : tr("noch nie", "never yet");
const copy = (text: string) => void navigator.clipboard.writeText(text).catch(() => {});

export function InboundMailSettings({ workspaceId, pages, onError }: { workspaceId: string; pages: Page[]; onError: (message: string) => void }) {
  const t = useT();
  const [data, setData] = useState<Listing | null>(null);
  const [pageId, setPageId] = useState("");
  const [label, setLabel] = useState("");
  const [senders, setSenders] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const targets = pages.filter((p) => !p.deleted_at && !p.synced && !p.journal_date && (p.kind === "document" || p.kind === "database"));
  const load = useCallback(async () => {
    setData(await api<Listing>(`/api/inbound-mail?workspace=${workspaceId}`));
  }, [workspaceId]);
  useEffect(() => {
    void load().catch((e) => onError((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);
  const act = async (body: Record<string, unknown>) => {
    try {
      await api("/api/command", { workspaceId, ...body });
      await load();
      return true;
    } catch (e) {
      onError((e as Error).message);
      return false;
    }
  };
  const [adding, setAdding] = useState(false);
  const form = (
    <form
      method="post"
      action="/api/auth/no-script"
      className="ws-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const ok = await act({
          action: "inbound.save",
          pageId,
          label: label.trim(),
          senders: senders.split(/[\s,;]+/).filter(Boolean),
          ...(secret.trim() ? { secret: secret.trim() } : {}),
        });
        setBusy(false);
        if (ok) {
          setLabel("");
          setSenders("");
          setSecret("");
          setAdding(false);
        }
      }}
    >
      <div className="ws-field">
        <label htmlFor="inbound-target">{t("Ziel der E-Mails", "Target of the e-mails")}</label>
        <Select id="inbound-target" required value={pageId} onChange={(e) => setPageId(e.target.value)}>
          <option value="">{t("Ziel wählen …", "Choose a target …")}</option>
          {targets.map((p) => (
            <option key={p.id} value={p.id}>
              {(p.kind === "database" ? t("Datenbank: ", "Database: ") : t("Seite: ", "Page: ")) + (p.title || t("Ohne Titel", "Untitled"))}
            </option>
          ))}
        </Select>
        <small>{t("E-Mails werden Unterseiten einer Seite oder Einträge einer Datenbank.", "E-mails become subpages of a page or records of a database.")}</small>
      </div>
      <div className="ws-field">
        <label htmlFor="inbound-label">{t("Bezeichnung (optional)", "Label (optional)")}</label>
        <input id="inbound-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={100} />
      </div>
      <div className="ws-field">
        <label htmlFor="inbound-senders">{t("Erlaubte Absender", "Allowed senders")}</label>
        <input id="inbound-senders" required value={senders} onChange={(e) => setSenders(e.target.value)} placeholder="firma.de, ada@example.org" aria-describedby="inbound-senders-hint" />
        <small id="inbound-senders-hint">{t("Adressen oder Domains, durch Komma getrennt.", "Addresses or domains, separated by commas.")}</small>
      </div>
      <div className="ws-field">
        <label htmlFor="inbound-secret">{t("Signaturschlüssel (optional)", "Signing key (optional)")}</label>
        <input id="inbound-secret" value={secret} onChange={(e) => setSecret(e.target.value)} type="password" autoComplete="off" aria-describedby="inbound-secret-hint" />
        <small id="inbound-secret-hint">{t("Für die HMAC-Prüfung des Webhooks.", "For the HMAC check of the webhook.")}</small>
      </div>
      <div className="ws-form-actions">
        <button type="button" className="button" onClick={() => setAdding(false)} disabled={busy}>
          {t("Abbrechen", "Cancel")}
        </button>
        <button className="button primary" disabled={busy || !pageId || !senders.trim()}>
          {t("Adresse anlegen", "Create address")}
        </button>
      </div>
    </form>
  );
  return (
    <SettingGroup
      id="inbound-mail"
      title={t("E-Mail-Eingang", "Inbound e-mail")}
      description={t(
        "Weitergeleitete E-Mails werden zu Unterseiten einer Seite oder zu Einträgen einer Datenbank, mit Anhängen. Nur Absender aus der Liste werden angenommen; HTML wird bereinigt, externe Bilder entfernt. Höchstens 60 E-Mails pro Stunde und Adresse.",
        "Forwarded e-mails become subpages of a page or records of a database, attachments included. Only senders on the list are accepted; HTML is cleaned and remote images are removed. At most 60 e-mails per hour and address.",
      )}
      actions={
        !!data?.addresses.length && !adding ? (
          <button type="button" className="button" onClick={() => setAdding(true)}>
            <Plus aria-hidden /> {t("Adresse anlegen", "Create address")}
          </button>
        ) : undefined
      }
    >
      {adding && <div className="setting-row wide">{form}</div>}
      {data && !data.addresses.length && !adding && (
        <div className="setting-row wide">
          <EmptyState
            icon={<EnvelopeSimple size={20} />}
            title={t("Noch keine Adresse", "No address yet")}
            action={
              <button type="button" className="button primary" onClick={() => setAdding(true)}>
                <Plus aria-hidden /> {t("Adresse anlegen", "Create address")}
              </button>
            }
          >
            {t("Lege eine Adresse an, um E-Mails in eine Seite oder Datenbank zu leiten.", "Create an address to route e-mails into a page or database.")}
          </EmptyState>
        </div>
      )}
      {!!data?.addresses.length && (
        <ul className="ws-list" aria-label={t("Adressen", "Addresses")}>
          {data.addresses.map((a) => {
            const address = data.imap && a.email ? a.email : a.webhookUrl;
            return (
              <li key={a.id} className="ws-item">
                <span className="ws-item-icon" aria-hidden>
                  <EnvelopeSimple size={18} />
                </span>
                <div className="ws-item-text">
                  <strong>
                    {a.label || a.target.title || t("Ohne Titel", "Untitled")}
                    {a.target.deleted && <StatusBadge tone="warn">{t("Ziel im Papierkorb", "target in the trash")}</StatusBadge>}
                    {a.lastError && <StatusBadge tone="error">{t("Fehler", "Error")}</StatusBadge>}
                  </strong>
                  <code>{address}</code>
                  {data.imap && a.email && <code>{a.webhookUrl}</code>}
                  <small>
                    {(a.target.kind === "database" ? t("Datenbank", "Database") : t("Seite", "Page")) + `: ${a.target.title || t("Ohne Titel", "Untitled")} · `}
                    {t("Absender", "Senders")}: {a.senders.join(", ")}
                    {a.signed ? ` · ${t("signiert", "signed")}` : ""}
                  </small>
                  <small>
                    {t(`${a.received} empfangen, zuletzt ${when(a.lastReceivedAt)}`, `${a.received} received, last ${when(a.lastReceivedAt)}`)}
                    {a.lastError ? ` · ${serverMessage(a.lastError)}` : ""}
                  </small>
                </div>
                <span className="ws-item-controls">
                  <button type="button" className="icon-button" title={t("Adresse kopieren", "Copy address")} aria-label={t("Adresse kopieren", "Copy address")} onClick={() => copy(address)}>
                    <Copy size={18} />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    title={t("Neues Token erzeugen", "Generate a new token")}
                    aria-label={t("Neues Token erzeugen", "Generate a new token")}
                    onClick={() => {
                      if (confirm(t("Die bisherige Adresse funktioniert danach nicht mehr. Fortfahren?", "The current address stops working. Continue?")))
                        void act({ action: "inbound.rotate", id: a.id });
                    }}
                  >
                    <ArrowsClockwise size={18} />
                  </button>
                  <button
                    type="button"
                    className="icon-button ws-danger-icon"
                    title={t("Löschen", "Delete")}
                    aria-label={t("E-Mail-Eingang löschen", "Delete inbound address")}
                    onClick={() => {
                      if (confirm(t("Diesen E-Mail-Eingang löschen?", "Delete this inbound address?"))) void act({ action: "inbound.delete", id: a.id });
                    }}
                  >
                    <Trash size={18} />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {data && !data.imap && (
        <div className="setting-row wide">
          <p className="ws-note">
            {t(
              "Die Webhook-Adresse trägst du bei Mailgun, Postmark, SendGrid oder in einem Cloudflare Email Worker ein. Für ein eigenes Postfach per IMAP setzt die Administration INBOUND_IMAP_HOST und INBOUND_MAIL_DOMAIN.",
              "Enter the webhook address at Mailgun, Postmark, SendGrid or in a Cloudflare Email Worker. For a mailbox of your own over IMAP the administrators set INBOUND_IMAP_HOST and INBOUND_MAIL_DOMAIN.",
            )}
          </p>
        </div>
      )}
    </SettingGroup>
  );
}
