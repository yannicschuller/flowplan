"use client";
import { useT } from "./i18n";
import { Select } from "./select";
import { useState } from "react";
import type { ShareLink } from "@/lib/share-links";
export function ShareLinks({
  pageId,
  links,
  act,
}: {
  pageId: string;
  links: ShareLink[];
  act: (input: Record<string, unknown>) => Promise<unknown>;
}) {
  const t = useT();
  const [name, setName] = useState(""),
    [role, setRole] = useState("viewer"),
    [children, setChildren] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const labels = {
    viewer: t("Lesen", "Read"),
    commenter: t("Kommentieren", "Comment"),
    editor: t("Bearbeiten", "Edit"),
  };
  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const result = await act({
        action: "share.create",
        pageId,
        name,
        role,
        includeChildren: children,
      });
      if (result) setName("");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-section share-links">
      <h3>{t("Links mit eigenen Berechtigungen", "Links with their own permissions")}</h3>
      <p>
        {t("Jeder mit einem Link erhält dessen Rechte, auch ohne Anmeldung. Bearbeiten erlaubt Änderungen an Titel, Dokumenten und sichtbaren Datensatzeigenschaften. Gastkommentare sind über alle Links dieser Seite sichtbar.", "Everyone with a link gets its permissions, even without signing in. Edit allows changes to the title, documents and visible record properties. Guest comments are visible through all links of this page.")}
      </p>
      {links.map((link) => (
        <div className="share-link" key={link.token}>
          <strong>{link.name}</strong>
          <span>
            {labels[link.role]} · {link.count}{" "}
            {link.count === 1 ? t("Seite", "page") : t("Seiten", "pages")}
          </span>
          <div className="copy-link">
            <input
              aria-label={t(`Link ${link.name}`, `Link ${link.name}`)}
              readOnly
              value={`${location.origin}/share/${link.token}`}
            />
            <button
              className="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(
                    `${location.origin}/share/${link.token}`,
                  );
                  setMessage(t("Link kopiert", "Link copied"));
                } catch {
                  setMessage(t("Bitte den Link im Textfeld kopieren.", "Please copy the link in the text field."));
                }
              }}
            >
              {t("Kopieren", "Copy")}
            </button>
          </div>
          <button
            className="button danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await act({
                  action: "share.revoke",
                  pageId,
                  token: link.token,
                });
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("Widerrufen:", "Revoke:")}{" "}{link.name}
          </button>
        </div>
      ))}
      <form onSubmit={create}>
        <label>
          {t("Linkname", "Link name")}
          <input
            aria-label={t("Linkname", "Link name")}
            required
            maxLength={100}
            placeholder={t("Zum Beispiel Feedback vom Kunden", "For example customer feedback")}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          {t("Berechtigung", "Permission")}
          <Select
            aria-label={t("Linkberechtigung", "Link permission")}
            value={role}
            onChange={(e) => setRole(e.target.value)}
          >
            <option value="viewer">{t("Lesen", "Read")}</option>
            <option value="commenter">{t("Lesen und kommentieren", "Read and comment")}</option>
            <option value="editor">{t("Lesen, kommentieren und bearbeiten", "Read, comment and edit")}</option>
          </Select>
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={children}
            onChange={(e) => setChildren(e.target.checked)}
          />
          {t("Aktuell vorhandene Unterseiten einschließen", "Include current sub-pages")}
        </label>
        <p className="muted">
          {t("Neue Unterseiten werden nicht automatisch freigegeben. Jeder Link lässt sich einzeln widerrufen.", "New sub-pages are not shared automatically. Every link can be revoked on its own.")}
        </p>
        <button className="button primary" disabled={busy || !name.trim()}>
          {t("Freigabelink erstellen", "Create share link")}
        </button>
      </form>
      <p role="status">{message}</p>
    </section>
  );
}
