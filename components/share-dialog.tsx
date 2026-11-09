"use client";
// "Seite teilen": a one-line summary (space, people, links, published) and
// three tabs – Personen (who has access to exactly this page), Links (links
// with their own permissions) and Web (the publication). All three stay
// mounted while the dialog is open: their counts feed the summary, and a
// half-filled form survives switching tabs.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { ArrowSquareOut, CaretRight, Check, Copy, FolderSimple, Globe, Link as LinkIcon, Users } from "@phosphor-icons/react";
import type { Page, Role, Space } from "@/lib/types";
import type { ShareLink } from "@/lib/share-links";
import { pageLocationHash } from "@/lib/page-location";
import { AiBlockToggle } from "./ai-settings";
import { useT } from "./i18n";
import { ExpiryEditor, PasswordEditor, formatExpiry } from "./link-protection";
import { PagePeople, type Shares } from "./page-people";
import { PublicationDomain } from "./publication-domain";
import { Hint } from "./share-hint";
import { ShareLinks } from "./share-links";
import { Modal } from "./ui";

type Tab = "people" | "links" | "web";
export type SharePublication = {
  includeChildren: boolean;
  count: number;
  allowCopy?: boolean;
  password?: boolean;
  expiresAt?: number | null;
};

export function ShareDialog({
  open,
  onClose,
  page,
  role,
  editable,
  shareLinks,
  publication,
  workspaceId,
  me,
  members,
  space,
  spaceMembers,
  onManageSpace,
  act,
  onChanged,
  onError,
}: {
  open: boolean;
  onClose: () => void;
  // Null while the page loads.
  page: Page | null;
  role: Role;
  editable: boolean;
  shareLinks?: ShareLink[];
  publication?: SharePublication;
  workspaceId: string;
  me: { id: string; name: string; email: string };
  // Workspace members to suggest (without the person looking).
  members: { id: string; name: string; email: string }[];
  space?: Space;
  // Members of a team space; null: not known (a private space, a guest).
  spaceMembers: number | null;
  // "Bereich verwalten", for those who may.
  onManageSpace?: () => void;
  act: (input: Record<string, unknown>) => Promise<unknown>;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const t = useT();
  const id = useId();
  const [tab, setTab] = useState<Tab>("people"),
    [people, setPeople] = useState<number | null>(null),
    [copied, setCopied] = useState<"page" | "public" | null>(null),
    [status, setStatus] = useState(""),
    [protection, setProtection] = useState<"password" | "expiry" | null>(null);
  const tabs = useRef<HTMLDivElement>(null);
  // Every opening starts on "Personen".
  useEffect(() => {
    if (!open) return;
    setTab("people");
    setPeople(null);
    setProtection(null);
    setStatus("");
  }, [open, page?.id]);
  const pageId = page?.id;
  const links = role !== "viewer";
  const published = !!page?.public_token;
  const publicUrl = page?.public_token ? `${location.origin}/share/${page.public_token}` : "";
  const list: { key: Tab; label: string; icon: React.ReactNode; count?: number | null; dot?: boolean }[] = [
    { key: "people", label: t("Personen", "People"), icon: <Users aria-hidden />, count: people },
    ...(links ? [{ key: "links" as Tab, label: t("Links", "Links"), icon: <LinkIcon aria-hidden />, count: shareLinks?.length ?? 0 }] : []),
    { key: "web", label: t("Web", "Web"), icon: <Globe aria-hidden />, dot: published },
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
  const copy = async (what: "page" | "public", value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      setStatus(t("Link kopiert", "Link copied"));
      setTimeout(() => setCopied((c) => (c === what ? null : c)), 1800);
    } catch {
      onError(t("Link konnte nicht kopiert werden.", "The link could not be copied."));
    }
  };
  const publish = (patch: { enabled: boolean; includeChildren?: boolean; allowCopy?: boolean }) =>
    act({
      action: "page.publish",
      pageId,
      ...(patch.enabled
        ? {
            enabled: true,
            includeChildren: patch.includeChildren ?? !!publication?.includeChildren,
            allowCopy: patch.allowCopy ?? publication?.allowCopy !== false,
          }
        : { enabled: false }),
    });
  const [now] = useState(() => Date.now());
  const expiresAt = publication?.expiresAt ?? null;
  const expiry = expiresAt ? (expiresAt <= now ? t("abgelaufen", "expired") : formatExpiry(expiresAt)) : t("Nie", "Never");
  const count = publication?.count || 1;
  const panel = (key: Tab) => ({
    role: "tabpanel" as const,
    id: `${id}-panel-${key}`,
    "aria-labelledby": `${id}-tab-${key}`,
    hidden: tab !== key,
    className: "sh-panel",
    tabIndex: 0,
  });
  return (
    <Modal open={open} sheet onClose={onClose} title={t("Seite teilen", "Share page")} className="share-dialog">
      {page && (
        <div className="sh-root" data-published={published || undefined}>
          <p className="sh-summary">
            {space && (
              <span className="sh-summary-item">
                <FolderSimple aria-hidden />
                {t(`Bereich ${space.name}`, `Space ${space.name}`)}
              </span>
            )}
            {people !== null && (
              <span className="sh-summary-item">{people === 1 ? t("1 Person", "1 person") : t(`${people} Personen`, `${people} people`)}</span>
            )}
            {links && (
              <span className="sh-summary-item">
                {shareLinks?.length === 1 ? t("1 Link", "1 link") : t(`${shareLinks?.length ?? 0} Links`, `${shareLinks?.length ?? 0} links`)}
              </span>
            )}
            <span className={`sh-summary-item${published ? " sh-pub-on" : ""}`}>
              {published && <i className="sh-live" aria-hidden />}
              {published ? t("veröffentlicht", "published") : t("nicht veröffentlicht", "not published")}
            </span>
          </p>

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

          <section {...panel("people")}>
            <PagePeople
              pageId={page.id}
              workspaceId={workspaceId}
              me={me}
              myRole={role}
              members={members}
              onChanged={onChanged}
              onShares={(s: Shares) => setPeople(s.people.filter((p) => p.id !== me.id).length + s.pending.length)}
              onError={onError}
            />
            {space && (
              <p className="sh-inherit">
                <Users aria-hidden />
                <span>
                  {space.visibility === "private" || spaceMembers === null
                    ? t(`Dazu alle mit Zugriff auf den Bereich ${space.name}`, `Plus everyone with access to the space ${space.name}`)
                    : spaceMembers === 1
                      ? t(`Dazu das 1 Mitglied des Bereichs ${space.name}`, `Plus the 1 member of the space ${space.name}`)
                      : t(`Dazu alle ${spaceMembers} Mitglieder des Bereichs ${space.name}`, `Plus all ${spaceMembers} members of the space ${space.name}`)}
                </span>
                {onManageSpace && (
                  <button type="button" className="sh-link-button" onClick={onManageSpace}>
                    {t("Bereich verwalten", "Manage space")}
                  </button>
                )}
              </p>
            )}
            <AiBlockToggle targetId={page.id} kind="page" onError={onError} />
          </section>

          {links && (
            <section {...panel("links")}>
              <ShareLinks pageId={page.id} links={shareLinks || []} act={act} />
            </section>
          )}

          <section {...panel("web")}>
            <div className="sh-publish">
              <span className="sh-publish-icon" aria-hidden>
                <Globe />
              </span>
              <span className="sh-who">
                <strong id={`${id}-publish`}>{t("Im Web veröffentlichen", "Publish on the web")}</strong>
                <small id={`${id}-publish-note`}>{t("Jeder mit dem Link kann den Inhalt dieser Seite lesen.", "Anyone with the link can read this page's content.")}</small>
              </span>
              <button
                type="button"
                role="switch"
                className="switch"
                aria-checked={published}
                aria-labelledby={`${id}-publish`}
                aria-describedby={`${id}-publish-note`}
                disabled={!editable}
                onClick={() => void publish({ enabled: !published })}
              >
                <span />
              </button>
            </div>
            {published && (
              <>
                <div className="sh-url">
                  <input readOnly aria-label={t("Öffentlicher Link", "Public link")} value={publicUrl} onFocus={(e) => e.target.select()} />
                  <button type="button" className="button compact" onClick={() => void copy("public", publicUrl)}>
                    {copied === "public" ? <Check aria-hidden /> : <Copy aria-hidden />}
                    {t("Kopieren", "Copy")}
                  </button>
                  <a className="icon-button" href={publicUrl} target="_blank" rel="noopener noreferrer" aria-label={t("Veröffentlichte Seite öffnen", "Open the published page")}>
                    <ArrowSquareOut aria-hidden />
                  </a>
                </div>
                <div className="sh-opts">
                  <div className="sh-opt-block">
                    <div className="sh-opt">
                      <span className="sh-opt-label">
                        <span id={`${id}-children`}>{t("Aktuell vorhandene Unterseiten mit veröffentlichen", "Also publish the current sub-pages")}</span>
                        <Hint text={t("Später angelegte Unterseiten kommen erst dazu, wenn du die Auswahl ergänzt.", "Sub-pages created later only join once you add them to the selection.")} />
                      </span>
                      <button
                        type="button"
                        role="switch"
                        className="switch"
                        aria-checked={!!publication?.includeChildren}
                        aria-labelledby={`${id}-children`}
                        disabled={!editable}
                        onClick={() => void publish({ enabled: true, includeChildren: !publication?.includeChildren })}
                      >
                        <span />
                      </button>
                    </div>
                    {publication?.includeChildren && editable && (
                      <div className="sh-opt-panel">
                        <button type="button" className="button compact" onClick={() => void publish({ enabled: true, includeChildren: true })}>
                          {t("Auswahl um neue Unterseiten ergänzen", "Add new sub-pages to the selection")}
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="sh-opt">
                    <span className="sh-opt-label">
                      <span id={`${id}-copy`}>{t("Besucher dürfen eine Kopie in ihren Arbeitsbereich übernehmen", "Visitors may copy it into their workspace")}</span>
                      {publication?.password && <Hint text={t("Mit Passwort kann die Veröffentlichung nicht kopiert werden.", "With a password the publication cannot be copied.")} />}
                    </span>
                    <button
                      type="button"
                      role="switch"
                      className="switch"
                      aria-checked={publication?.allowCopy !== false}
                      aria-labelledby={`${id}-copy`}
                      disabled={!editable}
                      onClick={() => void publish({ enabled: true, allowCopy: publication?.allowCopy === false })}
                    >
                      <span />
                    </button>
                  </div>
                  {(
                    [
                      ["password", t("Passwort", "Password"), publication?.password ? t("Festgelegt", "Set||state") : t("Ohne", "None||password")],
                      ["expiry", t("Läuft ab", "Expires"), expiry],
                    ] as const
                  ).map(([key, label, value]) => (
                    <div className="sh-opt-block" key={key}>
                      <div className="sh-opt">
                        <span className="sh-opt-label" id={`${id}-${key}`}>
                          {label}
                        </span>
                        {editable ? (
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
                        ) : (
                          <span className="sh-value">{value}</span>
                        )}
                      </div>
                      {editable && (
                        <div className="sh-opt-panel" id={`${id}-${key}-panel`} hidden={protection !== key}>
                          {key === "password" ? (
                            <PasswordEditor
                              label={t("öffentlichen Link", "public link")}
                              password={!!publication?.password}
                              onSave={(patch) => act({ action: "publication.protect", pageId, ...patch })}
                            />
                          ) : (
                            <ExpiryEditor
                              label={t("öffentlichen Link", "public link")}
                              expiresAt={expiresAt}
                              onSave={(patch) => act({ action: "publication.protect", pageId, ...patch })}
                            />
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                  <PublicationDomain pageId={page.id} editable={editable} password={!!publication?.password} onError={onError} />
                </div>
                <p className="sh-note sh-web-note">
                  {count === 1 ? t("1 Seite veröffentlicht.", "1 page published.") : t(`${count} Seiten veröffentlicht.`, `${count} pages published.`)}{" "}
                  {t("Kommentare und Mitgliederangaben bleiben privat.", "Comments and member details stay private.")}
                  <Hint text={t("Dokumente, Datensatzinhalte und darin verlinkte Uploads sind öffentlich.", "Documents, record contents and uploads linked in them are public.")} />
                </p>
              </>
            )}
          </section>

          <div className="sh-footer">
            <button
              type="button"
              className="button compact"
              onClick={() => void copy("page", `${location.origin}${location.pathname}${pageLocationHash({ pageId: page.id })}`)}
            >
              {copied === "page" ? <Check aria-hidden /> : <LinkIcon aria-hidden />}
              {t("Link zur Seite kopieren", "Copy link to page")}
            </button>
            <button type="button" className="button compact primary" onClick={onClose}>
              {t("Fertig", "Done")}
            </button>
          </div>
          <p role="status" className="sr-only">
            {status}
          </p>
        </div>
      )}
    </Modal>
  );
}
