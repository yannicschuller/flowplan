"use client";
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
  const [name, setName] = useState(""),
    [role, setRole] = useState("viewer"),
    [children, setChildren] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const labels = {
    viewer: "Lesen",
    commenter: "Kommentieren",
    editor: "Bearbeiten",
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
      <h3>Links mit eigenen Berechtigungen</h3>
      <p>
        Jeder mit einem Link erhält dessen Rechte, auch ohne Anmeldung.
        Bearbeiten erlaubt Änderungen an Titel, Dokumenten und sichtbaren
        Datensatzeigenschaften. Gastkommentare sind über alle Links dieser Seite
        sichtbar.
      </p>
      {links.map((link) => (
        <div className="share-link" key={link.token}>
          <strong>{link.name}</strong>
          <span>
            {labels[link.role]} · {link.count}{" "}
            {link.count === 1 ? "Seite" : "Seiten"}
          </span>
          <div className="copy-link">
            <input
              aria-label={`Link ${link.name}`}
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
                  setMessage("Link kopiert");
                } catch {
                  setMessage("Bitte den Link im Textfeld kopieren.");
                }
              }}
            >
              Kopieren
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
            Widerrufen: {link.name}
          </button>
        </div>
      ))}
      <form onSubmit={create}>
        <label>
          Linkname
          <input
            aria-label="Linkname"
            required
            maxLength={100}
            placeholder="Zum Beispiel Feedback vom Kunden"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Berechtigung
          <select
            aria-label="Linkberechtigung"
            value={role}
            onChange={(e) => setRole(e.target.value)}
          >
            <option value="viewer">Lesen</option>
            <option value="commenter">Lesen und kommentieren</option>
            <option value="editor">Lesen, kommentieren und bearbeiten</option>
          </select>
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={children}
            onChange={(e) => setChildren(e.target.checked)}
          />
          Aktuell vorhandene Unterseiten einschließen
        </label>
        <p className="muted">
          Neue Unterseiten werden nicht automatisch freigegeben. Jeder Link
          lässt sich einzeln widerrufen.
        </p>
        <button className="button primary" disabled={busy || !name.trim()}>
          Freigabelink erstellen
        </button>
      </form>
      <p role="status">{message}</p>
    </section>
  );
}
