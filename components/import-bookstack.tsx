"use client";
// Import from BookStack through its API (lib/importers/bookstack-api.ts,
// #329), the source "BookStack (API)" of components/import-sources.tsx and
// of the introduction (components/onboarding-import.tsx): the person gives
// the address and an API token, loads the shelves and books it sees, picks
// some or all, checks the preview (counts and warnings, nothing downloaded)
// and imports – preview and import as background jobs (#163), whose
// progress the page around shows (`wait`). Address and token stay in this
// component's state until the import has started and are cleared then;
// the server keeps the token only while the job runs.
import { useState } from "react";
import { Books, BookOpen } from "@phosphor-icons/react";
import { serverMessage } from "@/lib/server-message";
import { useT } from "./i18n";
import { warningText } from "./import-client";

type Listing = { shelves: { id: number; name: string; books: { id: number; name: string }[] }[]; books: { id: number; name: string }[] };
export type BookStackPreview = {
  shelves: number;
  books: number;
  chapters: number;
  pages: number;
  images: number;
  attachments: number;
  links: number;
  tags: number;
  warnings: string[];
  tooMany?: boolean;
};

export function ImportBookStack({
  workspaceId,
  spaceId,
  canWrite,
  busy,
  wait,
  onImported,
  onError,
}: {
  workspaceId: string;
  spaceId: string;
  canWrite: boolean;
  busy: boolean;
  // Waits for a started job with progress and answers with its result.
  wait: (job: string) => Promise<unknown>;
  onImported: (result: unknown) => Promise<void> | void;
  onError: (message: string) => void;
}) {
  const t = useT();
  const [url, setUrl] = useState("");
  const [tokenId, setTokenId] = useState("");
  const [tokenSecret, setTokenSecret] = useState("");
  const [listing, setListing] = useState<Listing | null>(null);
  const [shelves, setShelves] = useState<Set<number>>(new Set());
  const [books, setBooks] = useState<Set<number>>(new Set());
  const [preview, setPreview] = useState<BookStackPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const post = async (body: Record<string, unknown>) => {
    const response = await fetch("/api/import/bookstack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, spaceId, url, tokenId, tokenSecret, ...body }),
    });
    const data = (await response.json().catch(() => null)) as ({ error?: string; job?: string } & Partial<Listing>) | null;
    if (!response.ok) throw new Error(serverMessage(data?.error) || String(response.status));
    return data || {};
  };
  const failed = (error: unknown) => onError((error as Error).message === "network" ? t("Keine Verbindung zum Server.", "No connection to the server.") : (error as Error).message);
  const changed = () => {
    setListing(null);
    setPreview(null);
  };
  const load = async () => {
    setLoading(true);
    try {
      const found = (await post({ action: "list" })) as Listing;
      setListing({ shelves: found.shelves || [], books: found.books || [] });
      setShelves(new Set((found.shelves || []).map((s) => s.id)));
      setBooks(new Set([...(found.shelves || []).flatMap((s) => s.books.map((b) => b.id)), ...(found.books || []).map((b) => b.id)]));
      setPreview(null);
    } catch (error) {
      failed(error);
    } finally {
      setLoading(false);
    }
  };
  const choice = () => ({ shelves: [...shelves], books: [...books] });
  const check = async () => {
    try {
      const { job } = await post({ action: "preview", ...choice() });
      if (job) setPreview((await wait(job)) as BookStackPreview);
    } catch (error) {
      failed(error);
    }
  };
  const start = async () => {
    let job: string | undefined;
    try {
      job = (await post({ action: "import", ...choice() })).job;
    } catch (error) {
      failed(error);
      return;
    }
    // The server has the token for the job; the page forgets it.
    setTokenId("");
    setTokenSecret("");
    setListing(null);
    setPreview(null);
    if (!job) return;
    try {
      await onImported(await wait(job));
    } catch (error) {
      failed(error);
    }
  };
  const toggleShelf = (id: number) => {
    const shelf = listing?.shelves.find((s) => s.id === id);
    const on = !shelves.has(id);
    setShelves((all) => {
      const next = new Set(all);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
    setBooks((all) => {
      const next = new Set(all);
      for (const book of shelf?.books || []) {
        if (on) next.add(book.id);
        else next.delete(book.id);
      }
      return next;
    });
    setPreview(null);
  };
  const toggleBook = (id: number) => {
    setBooks((all) => {
      const next = new Set(all);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setPreview(null);
  };
  const disabled = !canWrite || busy || loading;
  const ready = url.trim().length > 3 && tokenId.trim().length >= 8 && tokenSecret.trim().length >= 8;
  const bookBox = (book: { id: number; name: string }, key: string) => (
    <li key={key}>
      <label>
        <input type="checkbox" checked={books.has(book.id)} onChange={() => toggleBook(book.id)} disabled={busy} />
        <BookOpen aria-hidden />
        <span className="ws-break">{book.name}</span>
      </label>
    </li>
  );
  const empty = listing && !listing.shelves.length && !listing.books.length;
  return (
    <div className="import-notion import-bookstack">
      <p className="import-sources-hint">
        <span>
          {t(
            "Lege in BookStack unter deinem Profil → „Access & Security“ → „API Tokens“ ein Token an und kopiere Token-ID und Token-Secret; deine Rolle braucht die Berechtigung „Access system API“. Importiert wird, was dein Konto sehen darf: Regale, Bücher, Kapitel und Seiten mit Bildern, Anhängen und Tags (ohne Entwürfe und Versionen). Das Token wird nur für diesen Import verwendet und nicht gespeichert.",
            "In BookStack, create a token under your profile → “Access & Security” → “API Tokens” and copy the token ID and token secret; your role needs the permission “Access system API”. What your account may see is imported: shelves, books, chapters and pages with images, attachments and tags (without drafts and revisions). The token is only used for this import and not stored.",
          )}
        </span>
      </p>
      <p className="import-sources-hint">
        <span>
          {t(
            "Läuft BookStack in deinem lokalen Netz (etwa http://192.168.…), muss die Administration von Flowplan das mit FLOWPLAN_IMPORT_ALLOW_PRIVATE=true erlauben.",
            "If BookStack runs in your local network (such as http://192.168.…), the administration of Flowplan has to allow it with FLOWPLAN_IMPORT_ALLOW_PRIVATE=true.",
          )}
        </span>
      </p>
      <div className="ws-form ws-form-inline">
        <div className="ws-field">
          <label htmlFor="import-bookstack-url">{t("Adresse von BookStack", "BookStack address")}</label>
          <input
            id="import-bookstack-url"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={url}
            maxLength={500}
            placeholder="https://wiki.example.org"
            onChange={(e) => {
              setUrl(e.target.value);
              changed();
            }}
            disabled={disabled}
          />
        </div>
        <div className="ws-field">
          <label htmlFor="import-bookstack-id">{t("Token-ID", "Token ID")}</label>
          <input
            id="import-bookstack-id"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={tokenId}
            maxLength={200}
            onChange={(e) => {
              setTokenId(e.target.value);
              changed();
            }}
            disabled={disabled}
          />
        </div>
        <div className="ws-field">
          <label htmlFor="import-bookstack-secret">{t("Token-Secret", "Token secret")}</label>
          <input
            id="import-bookstack-secret"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={tokenSecret}
            maxLength={200}
            onChange={(e) => {
              setTokenSecret(e.target.value);
              changed();
            }}
            disabled={disabled}
          />
        </div>
        <div className="ws-form-actions">
          <button type="button" className="button" onClick={() => void load()} disabled={disabled || !ready}>
            {loading ? t("Wird geladen …", "Loading …") : t("Regale und Bücher laden", "Load shelves and books")}
          </button>
        </div>
      </div>
      {listing && !preview && !busy && (
        <div className="import-sources-preview" role="region" aria-label={t("Regale und Bücher aus BookStack", "Shelves and books from BookStack")}>
          <strong>{t("Was importiert werden soll", "What to import")}</strong>
          {empty ? (
            <p className="import-sources-warnings">
              {t("Das Token sieht keine Regale und Bücher. Prüfe die Rechte des Kontos in BookStack.", "The token sees no shelves and books. Check the account's permissions in BookStack.")}
            </p>
          ) : (
            <ul className="import-notion-list import-bookstack-list">
              {listing.shelves.map((shelf) => (
                <li key={`shelf-${shelf.id}`}>
                  <label>
                    <input type="checkbox" checked={shelves.has(shelf.id)} onChange={() => toggleShelf(shelf.id)} disabled={busy} />
                    <Books aria-hidden />
                    <span className="ws-break">{shelf.name}</span>
                    <small>{t("Regal", "Shelf")}</small>
                  </label>
                  {shelf.books.length > 0 && <ul>{shelf.books.map((book) => bookBox(book, `shelf-${shelf.id}-${book.id}`))}</ul>}
                </li>
              ))}
              {listing.books.length > 0 && (
                <li>
                  <span className="import-bookstack-group">{t("Bücher ohne Regal", "Books without a shelf")}</span>
                  <ul>{listing.books.map((book) => bookBox(book, `book-${book.id}`))}</ul>
                </li>
              )}
            </ul>
          )}
          <p className="import-sources-warnings">
            {t(
              "Jedes Regal wird eine Seite mit seinen Büchern darunter, jedes Buch eine Seite mit Kapiteln und Seiten als Unterseiten. Ein Buch in mehreren Regalen kommt einmal unter das erste.",
              "Each shelf becomes a page with its books below it, each book a page with chapters and pages as sub-pages. A book on several shelves comes once, below the first.",
            )}
          </p>
          <div className="import-sources-actions">
            <button type="button" className="button" onClick={() => setListing(null)}>
              {t("Abbrechen", "Cancel")}
            </button>
            <button type="button" className="button primary" onClick={() => void check()} disabled={!canWrite || !books.size}>
              {t("Prüfen", "Check")}
            </button>
          </div>
        </div>
      )}
      {preview && !busy && (
        <div className="import-sources-preview" role="region" aria-label={t("Vorschau des Imports", "Preview of the import")}>
          <strong>{t("Vorschau · BookStack", "Preview · BookStack")}</strong>
          <ul>
            <li>{t(`${preview.shelves} Regale`, `${preview.shelves} shelves`)}</li>
            <li>{t(`${preview.books} Bücher`, `${preview.books} books`)}</li>
            <li>{t(`${preview.chapters} Kapitel`, `${preview.chapters} chapters`)}</li>
            <li>{t(`${preview.pages} Seiten`, `${preview.pages} pages`)}</li>
            <li>{t(`${preview.images} Bilder`, `${preview.images} images`)}</li>
            <li>
              {t(`${preview.attachments} Anhänge`, `${preview.attachments} attachments`)}
              {preview.links > 0 && t(` und ${preview.links} Links`, ` and ${preview.links} links`)}
            </li>
            {preview.tags > 0 && <li>{t(`${preview.tags} Tags`, `${preview.tags} tags`)}</li>}
          </ul>
          {preview.warnings.length > 0 && (
            <ul className="import-sources-warnings">
              {preview.warnings.map((warning) => (
                <li key={warning}>{warningText(warning)}</li>
              ))}
            </ul>
          )}
          <div className="import-sources-actions">
            <button type="button" className="button" onClick={() => setPreview(null)}>
              {t("Zurück", "Back")}
            </button>
            <button type="button" className="button primary" onClick={() => void start()} disabled={!canWrite || preview.tooMany || !preview.books}>
              {t("Importieren", "Import")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
