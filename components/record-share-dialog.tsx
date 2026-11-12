"use client";
// "Eintrag teilen" (#231): the Share menu of a single record, in its dialog
// and on its page – links with their own permissions (role, password, end
// date), publishing on the web, and which properties visitors see. Every
// share opens only this record (lib/record-share.ts); members get access
// through the database and the record's permissions instead.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { ArrowSquareOut, CaretRight, Check, Copy, Globe, Link as LinkIcon, ListChecks } from "@phosphor-icons/react";
import type { RecordShares } from "@/lib/record-share";
import { useT } from "./i18n";
import { ExpiryEditor, PasswordEditor, formatExpiry } from "./link-protection";
import { Hint } from "./share-hint";
import { ShareLinks } from "./share-links";
import { Modal } from "./ui";

type Tab = "links" | "web" | "fields";

export function RecordShareDialog({
  open,
  onClose,
  pageId,
  rowId,
  title,
  mutate,
  onError,
}: {
  open: boolean;
  onClose: () => void;
  pageId: string;
  rowId: string;
  title: string;
  mutate: (input: Record<string, unknown>) => Promise<unknown>;
  onError: (message: string) => void;
}) {
  const t = useT();
  const id = useId();
  const [tab, setTab] = useState<Tab>("links"),
    [shares, setShares] = useState<RecordShares | null>(null),
    [copied, setCopied] = useState(false),
    [status, setStatus] = useState(""),
    [protection, setProtection] = useState<"password" | "expiry" | null>(null);
  const tabs = useRef<HTMLDivElement>(null);
  const act = async (input: Record<string, unknown>) => {
    try {
      const result = (await mutate({ ...input, pageId, rowId })) as RecordShares | null;
      if (result && Array.isArray(result.links)) setShares(result);
      return result;
    } catch (e) {
      onError((e as Error).message);
      return null;
    }
  };
  const actRef = useRef(act);
  actRef.current = act;
  useEffect(() => {
    if (!open) return;
    setTab("links");
    setProtection(null);
    setStatus("");
    setShares(null);
    void actRef.current({ action: "record.shares" });
  }, [open, pageId, rowId]);
  const publication = shares?.publication || null;
  const publicUrl = publication && typeof location !== "undefined" ? `${location.origin}/share/${publication.token}` : "";
  const list: { key: Tab; label: string; icon: React.ReactNode; count?: number; dot?: boolean }[] = [
    { key: "links", label: t("Links", "Links"), icon: <LinkIcon aria-hidden />, count: shares?.links.length ?? 0 },
    { key: "web", label: t("Web", "Web"), icon: <Globe aria-hidden />, dot: !!publication },
    { key: "fields", label: t("Eigenschaften", "Properties"), icon: <ListChecks aria-hidden /> },
  ];
  const keyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = list.findIndex((x) => x.key === tab);
    const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
    const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[e.key];
    const next = step ? (i + step + list.length) % list.length : e.key === "Home" ? 0 : e.key === "End" ? list.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    setTab(list[next].key);
    tabs.current?.querySelectorAll<HTMLElement>("[role=tab]")[next]?.focus();
  };
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setStatus(t("Link kopiert", "Link copied"));
      setTimeout(() => setCopied(false), 1800);
    } catch {
      onError(t("Link konnte nicht kopiert werden.", "The link could not be copied."));
    }
  };
  const [now] = useState(() => Date.now());
  const expiresAt = publication?.expiresAt ?? null;
  const expiry = expiresAt ? (expiresAt <= now ? t("abgelaufen", "expired") : formatExpiry(expiresAt)) : t("Nie", "Never");
  const setFields = (ids: string[] | null) => void act({ action: "record.share.fields", fields: ids });
  const panel = (key: Tab) => ({
    role: "tabpanel" as const,
    id: `${id}-panel-${key}`,
    "aria-labelledby": `${id}-tab-${key}`,
    hidden: tab !== key,
    className: "sh-panel",
    tabIndex: 0,
  });
  const locked = !!shares?.private;
  return (
    <Modal open={open} sheet onClose={onClose} title={t("Eintrag teilen", "Share record")} className="share-dialog record-share-dialog">
      <div className="sh-root" data-published={!!publication || undefined}>
        <p className="sh-summary">
          <span className="sh-summary-item sh-record-title">{title}</span>
          <span className="sh-summary-item">
            {shares?.links.length === 1 ? t("1 Link", "1 link") : t(`${shares?.links.length ?? 0} Links`, `${shares?.links.length ?? 0} links`)}
          </span>
          <span className={`sh-summary-item${publication ? " sh-pub-on" : ""}`}>
            {publication && <i className="sh-live" aria-hidden />}
            {publication ? t("veröffentlicht", "published") : t("nicht veröffentlicht", "not published")}
          </span>
        </p>
        <p className="sh-note sh-record-note">
          {t(
            "Geteilt wird nur dieser Eintrag – nicht die Datenbank und keine anderen Einträge. Mitglieder erreichen ihn wie bisher über die Datenbank und die Rechte des Eintrags.",
            "Only this record is shared – not the database and no other records. Members reach it as before through the database and the record's permissions.",
          )}
        </p>
        {locked && (
          <p className="sh-note sh-record-private" role="note">
            {t("Dieser Eintrag ist privat. Private Einträge lassen sich nicht per Link teilen oder veröffentlichen.", "This record is private. Private records cannot be shared by link or published.")}
          </p>
        )}

        <div className="segmented sh-tabs" role="tablist" aria-label={t("Teilen", "Share")} ref={tabs}>
          {list.map((x) => (
            <button
              key={x.key}
              type="button"
              role="tab"
              id={`${id}-tab-${x.key}`}
              aria-controls={`${id}-panel-${x.key}`}
              aria-selected={tab === x.key}
              data-active={tab === x.key}
              tabIndex={tab === x.key ? 0 : -1}
              onClick={() => setTab(x.key)}
              onKeyDown={keyDown}
            >
              {x.icon}
              {x.label}
              {x.count != null && <span className="sh-count">{x.count}</span>}
              {x.dot && <i className="sh-tab-dot" title={t("veröffentlicht", "published")} />}
            </button>
          ))}
        </div>

        <section {...panel("links")}>
          {shares && (locked && !shares.links.length ? null : <ShareLinks pageId={pageId} rowId={rowId} links={shares.links} act={act} />)}
        </section>

        <section {...panel("web")}>
          <div className="sh-publish">
            <span className="sh-publish-icon" aria-hidden>
              <Globe />
            </span>
            <span className="sh-who">
              <strong id={`${id}-publish`}>{t("Im Web veröffentlichen", "Publish on the web")}</strong>
              <small id={`${id}-publish-note`}>
                {t("Jeder mit dem Link kann diesen Eintrag lesen – nur ihn, ohne die Datenbank.", "Anyone with the link can read this record – only it, without the database.")}
              </small>
            </span>
            <button
              type="button"
              role="switch"
              className="switch"
              aria-checked={!!publication}
              aria-labelledby={`${id}-publish`}
              aria-describedby={`${id}-publish-note`}
              disabled={!shares || (locked && !publication)}
              onClick={() => void act({ action: "record.publish", enabled: !publication })}
            >
              <span />
            </button>
          </div>
          {publication && (
            <>
              <div className="sh-url">
                <input readOnly aria-label={t("Öffentlicher Link", "Public link")} value={publicUrl} onFocus={(e) => e.target.select()} />
                <button type="button" className="button compact" onClick={() => void copy(publicUrl)}>
                  {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
                  {t("Kopieren", "Copy")}
                </button>
                <a className="icon-button" href={publicUrl} target="_blank" rel="noopener noreferrer" aria-label={t("Veröffentlichten Eintrag öffnen", "Open the published record")}>
                  <ArrowSquareOut aria-hidden />
                </a>
              </div>
              <div className="sh-opts">
                {(
                  [
                    ["password", t("Passwort", "Password"), publication.password ? t("Festgelegt", "Set||state") : t("Ohne", "None||password")],
                    ["expiry", t("Läuft ab", "Expires"), expiry],
                  ] as const
                ).map(([key, label, value]) => (
                  <div className="sh-opt-block" key={key}>
                    <div className="sh-opt">
                      <span className="sh-opt-label" id={`${id}-${key}`}>
                        {label}
                      </span>
                      <button
                        type="button"
                        className="sh-value"
                        aria-expanded={protection === key}
                        aria-controls={`${id}-${key}-panel`}
                        aria-describedby={`${id}-${key}`}
                        onClick={() => setProtection(protection === key ? null : key)}
                      >
                        {value}
                        <CaretRight className="sh-caret" aria-hidden />
                      </button>
                    </div>
                    <div className="sh-opt-panel" id={`${id}-${key}-panel`} hidden={protection !== key}>
                      {key === "password" ? (
                        <PasswordEditor
                          label={t("öffentlichen Link", "public link")}
                          password={publication.password}
                          onSave={(patch) => act({ action: "record.publication.protect", ...patch })}
                        />
                      ) : (
                        <ExpiryEditor
                          label={t("öffentlichen Link", "public link")}
                          expiresAt={expiresAt}
                          onSave={(patch) => act({ action: "record.publication.protect", ...patch })}
                        />
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <p className="sh-note sh-web-note">
                {t("Kommentare bleiben privat; Suchmaschinen bleiben draußen.", "Comments stay private; search engines stay out.")}
                <Hint text={t("Der Inhalt des Eintrags, die gewählten Eigenschaften und darin verlinkte Uploads sind öffentlich.", "The record's content, the chosen properties and uploads linked in them are public.")} />
              </p>
            </>
          )}
        </section>

        <section {...panel("fields")}>
          <div className="sh-label-row">
            <span id={`${id}-fields`}>{t("Was Besucher sehen", "What visitors see")}</span>
            <Hint
              text={t(
                "Gilt für alle Links und die Veröffentlichung dieses Eintrags. Leere Eigenschaften werden nicht angezeigt. Eigenschaften mit Leserechten und Rollups bleiben immer privat.",
                "Applies to all links and the publication of this record. Empty properties are not shown. Properties with read permissions and rollups always stay private.",
              )}
            />
          </div>
          {shares && (
            <ul className="sh-list sh-field-list" aria-labelledby={`${id}-fields`}>
              <li className="sh-field">
                <label>
                  <input type="checkbox" checked disabled />
                  <span>{t("Titel, Symbol, Cover und Inhalt", "Title, icon, cover and content")}</span>
                </label>
              </li>
              {shares.fields.map((f) => (
                <li key={f.id} className="sh-field">
                  <label>
                    <input
                      type="checkbox"
                      checked={f.shown}
                      onChange={() =>
                        setFields(shares.fields.filter((x) => (x.id === f.id ? !x.shown : x.shown)).map((x) => x.id))
                      }
                    />
                    <span>{f.name}</span>
                    {f.type === "relation" && <small className="muted">{t("zeigt Titel verknüpfter Einträge", "shows titles of linked records")}</small>}
                    {["person", "created_by", "updated_by"].includes(f.type) && (
                      <small className="muted">{t("zeigt Namen von Mitgliedern", "shows member names")}</small>
                    )}
                  </label>
                </li>
              ))}
            </ul>
          )}
          {shares?.chosen && (
            <button type="button" className="button compact" onClick={() => setFields(null)}>
              {t("Standardauswahl wiederherstellen", "Restore the default selection")}
            </button>
          )}
        </section>

        <div className="sh-footer">
          <button type="button" className="button compact primary" onClick={onClose}>
            {t("Fertig", "Done")}
          </button>
        </div>
        <p role="status" className="sr-only">
          {status}
        </p>
      </div>
    </Modal>
  );
}
