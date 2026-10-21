"use client";
// Settings → Workspace → "E-Mail-Eingang": addresses that turn incoming
// mail into pages or records (lib/inbound-mail.ts). Owners create them with
// a target, allowed senders and an optional signing key, copy the webhook
// URL (or the IMAP address), rotate the token and remove them.
import { useCallback, useEffect, useState } from "react";
import { ArrowsClockwise, Copy, Trash } from "@phosphor-icons/react";
import { LOCALE_TAG, tr } from "@/lib/locale-tag";
import { serverMessage } from "@/lib/i18n-errors";
import type { Page } from "@/lib/types";
import { useT } from "./i18n";
import { api } from "./ui";
import { Select } from "./select";

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
  return (
    <section className="settings-section inbound-mail-settings">
      <h2>{t("E-Mail-Eingang", "Inbound e-mail")}</h2>
      <p className="muted">
        {t(
          "Weitergeleitete E-Mails werden zu Unterseiten einer Seite oder zu Einträgen einer Datenbank, mit Anhängen. Nur Absender aus der Liste werden angenommen; HTML wird bereinigt, externe Bilder entfernt. Höchstens 60 E-Mails pro Stunde und Adresse.",
          "Forwarded e-mails become subpages of a page or records of a database, attachments included. Only senders on the list are accepted; HTML is cleaned and remote images are removed. At most 60 e-mails per hour and address.",
        )}
      </p>
      <form
        className="integration-form"
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
          }
        }}
      >
        <Select required value={pageId} onChange={(e) => setPageId(e.target.value)} aria-label={t("Ziel der E-Mails", "Target of the e-mails")}>
          <option value="">{t("Ziel wählen …", "Choose a target …")}</option>
          {targets.map((p) => (
            <option key={p.id} value={p.id}>
              {(p.kind === "database" ? t("Datenbank: ", "Database: ") : t("Seite: ", "Page: ")) + (p.title || t("Ohne Titel", "Untitled"))}
            </option>
          ))}
        </Select>
        <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={100} placeholder={t("Bezeichnung (optional)", "Label (optional)")} aria-label={t("Bezeichnung", "Label")} />
        <input
          required
          value={senders}
          onChange={(e) => setSenders(e.target.value)}
          placeholder={t("Erlaubte Absender: firma.de, ada@example.org", "Allowed senders: company.com, ada@example.org")}
          aria-label={t("Erlaubte Absender (Adressen oder Domains, durch Komma getrennt)", "Allowed senders (addresses or domains, separated by commas)")}
        />
        <input
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          type="password"
          autoComplete="off"
          placeholder={t("Signaturschlüssel (optional)", "Signing key (optional)")}
          aria-label={t("Signaturschlüssel für die HMAC-Prüfung (optional)", "Signing key for the HMAC check (optional)")}
        />
        <button className="button primary" disabled={busy || !pageId || !senders.trim()}>
          {t("Adresse anlegen", "Create address")}
        </button>
      </form>
      <ul className="integration-list">
        {data?.addresses.map((a) => {
          const address = data.imap && a.email ? a.email : a.webhookUrl;
          return (
            <li key={a.id}>
              <span>
                <strong>
                  {a.label || a.target.title || t("Ohne Titel", "Untitled")}
                  {a.target.deleted ? ` (${t("Ziel im Papierkorb", "target in the trash")})` : ""}
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
              </span>
              <span className="calendar-subscribe-actions">
                <button type="button" className="icon-button" title={t("Adresse kopieren", "Copy address")} aria-label={t("Adresse kopieren", "Copy address")} onClick={() => copy(address)}>
                  <Copy size={16} />
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
                  <ArrowsClockwise size={16} />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  title={t("Löschen", "Delete")}
                  aria-label={t("E-Mail-Eingang löschen", "Delete inbound address")}
                  onClick={() => {
                    if (confirm(t("Diesen E-Mail-Eingang löschen?", "Delete this inbound address?"))) void act({ action: "inbound.delete", id: a.id });
                  }}
                >
                  <Trash size={16} />
                </button>
              </span>
            </li>
          );
        })}
        {data && !data.addresses.length && <li className="muted">{t("Noch keine Adressen.", "No addresses yet.")}</li>}
      </ul>
      {data && !data.imap && (
        <p className="muted">
          {t(
            "Die Webhook-Adresse trägst du bei Mailgun, Postmark, SendGrid oder in einem Cloudflare Email Worker ein. Für ein eigenes Postfach per IMAP setzt die Administration INBOUND_IMAP_HOST und INBOUND_MAIL_DOMAIN.",
            "Enter the webhook address at Mailgun, Postmark, SendGrid or in a Cloudflare Email Worker. For a mailbox of your own over IMAP the administrators set INBOUND_IMAP_HOST and INBOUND_MAIL_DOMAIN.",
          )}
        </p>
      )}
    </section>
  );
}
