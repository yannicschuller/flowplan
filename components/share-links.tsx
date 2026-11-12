"use client";
// The "Links" tab of the share dialog: links with their own permissions –
// a list with copy and a menu (edit password and end date, revoke), and
// "Neuer Link" unfolding a compact form.
import { useT } from "./i18n";
import { Select } from "./select";
import { useId, useState } from "react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { Check, Copy, DotsThree, Link as LinkIcon, PencilSimple, Plus, Trash, X } from "@phosphor-icons/react";
import type { ShareLink } from "@/lib/share-links";
import { ExpiryEditor, PasswordEditor, ProtectionChips, fromLocalInput } from "./link-protection";
import { safeCollisionPadding } from "./safe-area";
import { Hint } from "./share-hint";

const linkUrl = (token: string) => `${location.origin}/share/${token}`;

// The links of a page, or (`rowId`, #231) of a single record: those have
// their own commands (lib/record-share.ts) and include the record's
// sub-pages as they are, also later ones ("Unterseiten einbeziehen").
type LinkItem = Pick<ShareLink, "token" | "name" | "role" | "password" | "expires_at"> & { count?: number; includeChildren?: boolean };
export function ShareLinks({
  pageId,
  rowId,
  links,
  act,
}: {
  pageId: string;
  rowId?: string;
  links: LinkItem[];
  act: (input: Record<string, unknown>) => Promise<unknown>;
}) {
  const command = rowId ? "record.share" : "share";
  const target = rowId ? { pageId, rowId } : { pageId };
  const t = useT();
  const formId = useId();
  const [name, setName] = useState(""),
    [role, setRole] = useState("viewer"),
    [children, setChildren] = useState(false),
    [password, setPassword] = useState(""),
    [expiry, setExpiry] = useState(""),
    [busy, setBusy] = useState(false),
    [adding, setAdding] = useState(false),
    [editing, setEditing] = useState<string | null>(null),
    [copied, setCopied] = useState<string | null>(null),
    [message, setMessage] = useState("");
  const labels = {
    viewer: t("Lesen", "Read"),
    commenter: t("Kommentieren", "Comment"),
    editor: t("Bearbeiten", "Edit"),
  };
  const reset = () => {
    setName("");
    setRole("viewer");
    setChildren(false);
    setPassword("");
    setExpiry("");
  };
  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const result = await act({
        action: `${command}.create`,
        ...target,
        name,
        role,
        includeChildren: children,
        ...(password ? { password } : {}),
        ...(expiry ? { expiresAt: fromLocalInput(expiry) } : {}),
      });
      if (result) {
        setMessage(t(`Link „${name}“ erstellt.`, `Link “${name}” created.`));
        reset();
        setAdding(false);
      }
    } finally {
      setBusy(false);
    }
  }
  async function copy(link: LinkItem) {
    try {
      await navigator.clipboard.writeText(linkUrl(link.token));
      setCopied(link.token);
      setMessage(t("Link kopiert", "Link copied"));
      setTimeout(() => setCopied((c) => (c === link.token ? null : c)), 1800);
    } catch {
      // The address to copy by hand is in the unfolded row.
      setEditing(link.token);
      setMessage(t("Bitte den Link im Textfeld kopieren.", "Please copy the link in the text field."));
    }
  }
  async function revoke(link: LinkItem) {
    setBusy(true);
    try {
      if (await act({ action: `${command}.revoke`, ...target, token: link.token })) {
        setMessage(t(`Link „${link.name}“ widerrufen.`, `Link “${link.name}” revoked.`));
        if (editing === link.token) setEditing(null);
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="share-links">
      <div className="sh-label-row">
        <span id={`${formId}-title`}>{t("Links mit eigenen Berechtigungen", "Links with their own permissions")}</span>
        <Hint
          text={
            rowId
              ? t(
                  "Jeder mit einem Link sieht nur diesen Eintrag – keine anderen Einträge und nicht die Datenbank. Bearbeiten erlaubt Änderungen am Dokument und an sichtbaren Eigenschaften. Gastkommentare sind über alle Links dieses Eintrags sichtbar.",
                  "Everyone with a link sees only this record – no other records and not the database. Edit allows changes to the document and visible properties. Guest comments are visible through all links of this record.",
                )
              : t(
                  "Jeder mit einem Link erhält dessen Rechte, auch ohne Anmeldung. Bearbeiten erlaubt Änderungen an Titel, Dokumenten und sichtbaren Datensatzeigenschaften. Gastkommentare sind über alle Links dieser Seite sichtbar.",
                  "Everyone with a link gets its permissions, even without signing in. Edit allows changes to the title, documents and visible record properties. Guest comments are visible through all links of this page.",
                )
          }
        />
      </div>
      {links.length ? (
        <ul className="sh-list" aria-labelledby={`${formId}-title`}>
          {links.map((link) => {
            const open = editing === link.token;
            const panel = `${formId}-${link.token}`;
            return (
              <li key={link.token} className="sh-link" data-open={open || undefined}>
                <div className="sh-row">
                  <span className="sh-link-icon" aria-hidden>
                    <LinkIcon />
                  </span>
                  <span className="sh-who">
                    <strong>{link.name}</strong>
                    <span className="sh-badges">
                      <span className="sh-perm">{labels[link.role]}</span>
                      {rowId && link.includeChildren && <span className="tag">{t("mit Unterseiten", "with sub-pages")}</span>}
                      {!!link.count && link.count > 1 && (
                        <span className="tag">
                          {link.count === 2
                            ? t("mit 1 Unterseite", "with 1 sub-page")
                            : t(`mit ${link.count - 1} Unterseiten`, `with ${link.count - 1} sub-pages`)}
                        </span>
                      )}
                      <ProtectionChips password={link.password} expiresAt={link.expires_at} />
                    </span>
                  </span>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={t(`Link ${link.name} kopieren`, `Copy link ${link.name}`)}
                    title={t("Link kopieren", "Copy link")}
                    onClick={() => void copy(link)}
                  >
                    {copied === link.token ? <Check /> : <Copy />}
                  </button>
                  <Dropdown.Root>
                    <Dropdown.Trigger className="icon-button" aria-label={t(`Mehr zu ${link.name}`, `More for ${link.name}`)} disabled={busy}>
                      <DotsThree weight="bold" />
                    </Dropdown.Trigger>
                    <Dropdown.Portal>
                      <Dropdown.Content className="dropdown" align="end" sideOffset={4} collisionPadding={safeCollisionPadding()}>
                        <Dropdown.Item className="dropdown-item" onSelect={() => setEditing(open ? null : link.token)}>
                          <PencilSimple />
                          {t("Passwort und Ablaufdatum", "Password and expiry date")}
                        </Dropdown.Item>
                        <Dropdown.Separator className="dropdown-separator" />
                        <Dropdown.Item className="dropdown-item danger" onSelect={() => void revoke(link)}>
                          <Trash />
                          {t("Widerrufen", "Revoke")}
                        </Dropdown.Item>
                      </Dropdown.Content>
                    </Dropdown.Portal>
                  </Dropdown.Root>
                </div>
                {open && (
                  <div className="sh-panel-box" id={panel} role="group" aria-label={link.name}>
                    <div className="sh-box-head">
                      <strong>{link.name}</strong>
                      <button type="button" className="icon-button" aria-label={t("Schließen", "Close")} onClick={() => setEditing(null)}>
                        <X />
                      </button>
                    </div>
                    <div className="sh-url">
                      <input aria-label={t(`Link ${link.name}`, `Link ${link.name}`)} readOnly value={linkUrl(link.token)} onFocus={(e) => e.target.select()} />
                    </div>
                    <PasswordEditor
                      label={link.name}
                      password={link.password}
                      disabled={busy}
                      onSave={(patch) => act({ action: `${command}.protect`, ...target, token: link.token, ...patch })}
                    />
                    <ExpiryEditor
                      label={link.name}
                      expiresAt={link.expires_at}
                      disabled={busy}
                      onSave={(patch) => act({ action: `${command}.protect`, ...target, token: link.token, ...patch })}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        !adding && (
          <p className="sh-empty">
            {rowId
              ? t("Noch keine Links. Ein Link teilt diesen Eintrag auch mit Menschen ohne Konto.", "No links yet. A link shares this record with people without an account too.")
              : t("Noch keine Links. Ein Link teilt die Seite auch mit Menschen ohne Konto.", "No links yet. A link shares the page with people without an account too.")}
          </p>
        )
      )}
      {adding ? (
        <form className="sh-panel-box sh-link-form" method="post" action="/api/auth/no-script" onSubmit={create} aria-labelledby={`${formId}-new`}>
          <div className="sh-box-head">
            <strong id={`${formId}-new`}>{t("Neuer Link", "New link")}</strong>
            <button type="button" className="icon-button" aria-label={t("Schließen", "Close")} onClick={() => setAdding(false)}>
              <X />
            </button>
          </div>
          <div className="sh-grid-2">
            <label>
              {t("Name", "Name")}
              <input
                aria-label={t("Linkname", "Link name")}
                required
                autoFocus
                maxLength={100}
                placeholder={t("Zum Beispiel Feedback vom Kunden", "For example customer feedback")}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              {t("Berechtigung", "Permission")}
              <Select aria-label={t("Linkberechtigung", "Link permission")} value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="viewer">{t("Lesen", "Read")}</option>
                <option value="commenter">{t("Lesen und kommentieren", "Read and comment")}</option>
                <option value="editor">{t("Lesen, kommentieren und bearbeiten", "Read, comment and edit")}</option>
              </Select>
            </label>
          </div>
          <div className="sh-opt">
            <span className="sh-opt-label">
              <span id={`${formId}-children`}>
                {rowId ? t("Unterseiten einbeziehen", "Include sub-pages") : t("Aktuell vorhandene Unterseiten einschließen", "Include current sub-pages")}
              </span>
              <Hint
                text={
                  rowId
                    ? t(
                        "Besucher öffnen auch die Unterseiten dieses Eintrags – die heutigen und spätere, solange sie unter ihm liegen. Sonst nichts aus der Datenbank.",
                        "Visitors can also open this record's sub-pages – today's and later ones, as long as they sit under it. Nothing else of the database.",
                      )
                    : t(
                        "Neue Unterseiten werden nicht automatisch freigegeben. Jeder Link lässt sich einzeln widerrufen.",
                        "New sub-pages are not shared automatically. Every link can be revoked on its own.",
                      )
                }
              />
            </span>
            <button
              type="button"
              role="switch"
              className="switch"
              aria-checked={children}
              aria-labelledby={`${formId}-children`}
              onClick={() => setChildren(!children)}
            >
              <span />
            </button>
          </div>
          <div className="sh-grid-2">
            <label>
              {t("Passwort (optional)", "Password (optional)")}
              <input
                type="password"
                autoComplete="new-password"
                aria-label={t("Passwort für den neuen Link", "Password for the new link")}
                minLength={6}
                maxLength={200}
                placeholder={t("Ohne Passwort", "No password")}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <label>
              {t("Läuft ab am (optional)", "Expires on (optional)")}
              <input
                type="datetime-local"
                aria-label={t("Ablaufdatum für den neuen Link", "Expiry date for the new link")}
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
              />
            </label>
          </div>
          <div className="sh-form-actions">
            <button type="button" className="button compact" onClick={() => setAdding(false)}>
              {t("Abbrechen", "Cancel")}
            </button>
            <button className="button compact primary" disabled={busy || !name.trim() || (password.length > 0 && password.length < 6)}>
              {t("Link erstellen", "Create link")}
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className="button compact sh-new-link" onClick={() => setAdding(true)}>
          <Plus />
          {t("Neuer Link", "New link")}
        </button>
      )}
      <p role="status" className="sr-only">
        {message}
      </p>
    </div>
  );
}
