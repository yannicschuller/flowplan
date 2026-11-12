"use client";
// The Flowplan Marketplace in the app (docs: Marketplace,
// lib/marketplace-handover.ts, lib/marketplace-package.ts):
//
//   PublishButton / PublishDialog  "Im Marketplace veröffentlichen …": the
//     details and pictures, then the package (built on this server) goes to
//     the marketplace's submit page by postMessage – or is saved as a file.
//   MarketplaceReceiver            #marketplace-import: says "ready" to the
//     marketplace window that opened this page, takes the template it sends
//     (only from the configured origin and the opener, only with a matching
//     checksum), keeps it in IndexedDB until the person is signed in, and
//     shows what an import would create; also for `.flowplan-template`
//     files (openTemplateFile).
//
// The instance never contacts the marketplace: everything goes through
// this browser.
import "@/app/marketplace.css";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { DownloadSimple, Storefront, X } from "@phosphor-icons/react";
import { useLocale, useT } from "./i18n";
import { Modal } from "./ui";
import { Select } from "./select";
import { showToast } from "./toast";
import { serverMessage } from "@/lib/i18n-errors";
import { templateCategoryLabels, templateCategoryIds } from "@/lib/template-categories";
import {
  MAX_PACKAGE_BYTES,
  browseAddress,
  marketplacePageAddress,
  checksumMatches,
  instanceReady,
  isImportHash,
  isSubmitReady,
  packageFileName,
  packageMessage,
  parseTemplateMessage,
  submitAddress,
  trustedSource,
  uploadAddress,
  READY_MS,
} from "@/lib/marketplace-handover";
import { armDesktopMarketplace, marketplacePublishWay, nativeSaveFile } from "@/lib/native-app";
import type { MarketplaceClientConfig } from "@/lib/marketplace-config";
import type { Bootstrap } from "@/lib/types";

// The configuration of the open app (set by MarketplaceReceiver), for the
// buttons deep inside pages: workflow, whiteboard.
let current: MarketplaceClientConfig | null = null;
const listeners = new Set<() => void>();
function setMarketplace(config: MarketplaceClientConfig | null) {
  if (current?.origin === config?.origin && current?.version === config?.version) return;
  current = config;
  listeners.forEach((l) => l());
}
export function useMarketplace() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => null,
  );
}

// This instance's origin in the browser (null while rendering on the server),
// for the #from= part of marketplace links.
const noSubscription = () => () => {};
function useInstanceOrigin() {
  return useSyncExternalStore(
    noSubscription,
    () => location.origin,
    () => null,
  );
}

// A plain link to the marketplace (new tab); nothing when it is off.
export function MarketplaceLink({ config, path, className, children }: { config?: MarketplaceClientConfig | null; path?: string; className?: string; children: React.ReactNode }) {
  const href = browseAddress(config, useInstanceOrigin(), path);
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
    </a>
  );
}

export type MarketplaceKind ="document" | "database" | "workflow" | "whiteboard" | "appearance" | "link-rules";
type T = (de: string, en: string) => string;
export const kindLabel = (kind: string, t: T) =>
  ({
    document: t("Dokumentvorlage", "Document template"),
    database: t("Datenbankvorlage", "Database template"),
    workflow: t("Workflow", "Workflow"),
    whiteboard: t("Whiteboard-Vorlage", "Whiteboard template"),
    appearance: t("Erscheinungsbild", "Appearance"),
    "link-rules": t("Automatische Links", "Automatic links"),
  })[kind] ?? kind;
const languages = (t: T) => [
  ["de", "Deutsch"],
  ["en", "English"],
  ["fr", "Français"],
  ["zh", "中文"],
  ["multi", t("Mehrsprachig", "Multilingual")],
];

async function readError(response: Response, t: T) {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return serverMessage(body?.error) || t("Das hat nicht geklappt.", "That didn't work.");
}
function saveFile(name: string, bytes: ArrayBuffer) {
  // The mobile apps' web view cannot download: the app's share sheet.
  void nativeSaveFile(name, new Blob([bytes], { type: "application/zip" })).then((done) => done || downloadFile(name, bytes));
}
function downloadFile(name: string, bytes: ArrayBuffer) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------- Publishing ---------- */

export type PublishSource = { kind: MarketplaceKind; workspaceId: string; id?: string | null; title?: string };
type Draft = { kind: MarketplaceKind; title: string; category: string; minVersion: string; notes: { code: string; count?: number }[] };
type Picture = { file: File; url: string };
// "file": no hand-over possible here (or no answer) – the package was saved
// as a file, to upload on the marketplace's submit page.
type FileReason = "desktop" | "app" | "blocked" | "silent";
type Sending = { step: "idle" } | { step: "building" } | { step: "waiting" } | { step: "sent" } | { step: "file"; reason: FileReason } | { step: "error"; message: string };

export function PublishButton({ config, source, className = "button compact", label }: { config?: MarketplaceClientConfig | null; source: PublishSource; className?: string; label?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (!config) return null;
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        <Storefront aria-hidden /> {label ?? t("Im Marketplace veröffentlichen …", "Publish to the marketplace …")}
      </button>
      {open && <PublishDialog config={config} source={source} onClose={() => setOpen(false)} />}
    </>
  );
}

const defaultSummary = (kind: string, title: string) => {
  const de: Record<string, string> = {
    document: `Dokumentvorlage „${title}“.`,
    database: `Datenbankvorlage „${title}“.`,
    workflow: `Workflow „${title}“.`,
    whiteboard: `Whiteboard-Vorlage „${title}“.`,
    appearance: "Erscheinungsbild für einen Arbeitsbereich: Akzentfarbe, Hintergrund und Schriften.",
    "link-rules": "Regeln für automatische Links.",
  };
  const en: Record<string, string> = {
    document: `Document template “${title}”.`,
    database: `Database template “${title}”.`,
    workflow: `Workflow “${title}”.`,
    whiteboard: `Whiteboard template “${title}”.`,
    appearance: "Appearance for a workspace: accent colour, background and typefaces.",
    "link-rules": "Rules for automatic links.",
  };
  return { de: de[kind] ?? "", en: en[kind] ?? "" };
};

export function PublishDialog({ config, source, onClose }: { config: MarketplaceClientConfig; source: PublishSource; onClose: () => void }) {
  const t = useT();
  const locale = useLocale();
  const [draft, setDraft] = useState<Draft | null>(null),
    [loadError, setLoadError] = useState(""),
    [title, setTitle] = useState(""),
    [summaryDe, setSummaryDe] = useState(""),
    [summaryEn, setSummaryEn] = useState(""),
    [category, setCategory] = useState("other"),
    [tags, setTags] = useState(""),
    [language, setLanguage] = useState<string>(locale === "en" ? "en" : locale === "fr" ? "fr" : locale === "zh" ? "zh" : "de"),
    [pictures, setPictures] = useState<Picture[]>([]),
    [pictureError, setPictureError] = useState(""),
    [sending, setSending] = useState<Sending>({ step: "idle" });
  const stop = useRef<() => void>(() => {});
  useEffect(() => () => stop.current(), []);
  useEffect(() => () => pictures.forEach((p) => URL.revokeObjectURL(p.url)), [pictures]);
  useEffect(() => {
    let live = true;
    const query = new URLSearchParams({ kind: source.kind, workspace: source.workspaceId, ...(source.id ? { id: source.id } : {}) });
    fetch(`/api/marketplace/draft?${query}`)
      .then(async (r) => (r.ok ? ((await r.json()) as Draft) : Promise.reject(new Error(await readError(r, t)))))
      .then((d) => {
        if (!live) return;
        setDraft(d);
        const name = d.title || source.title || (d.kind === "appearance" ? t("Erscheinungsbild", "Appearance") : d.kind === "link-rules" ? t("Automatische Links", "Automatic links") : "");
        setTitle(name.slice(0, 120));
        const s = defaultSummary(d.kind, name);
        setSummaryDe(s.de.slice(0, 300));
        setSummaryEn(s.en.slice(0, 300));
        setCategory(templateCategoryIds.includes(d.category as never) ? d.category : "other");
      })
      .catch((e: Error) => live && setLoadError(e.message));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.kind, source.workspaceId, source.id]);

  function addPictures(files: FileList | null) {
    setPictureError("");
    const next = [...pictures];
    for (const file of Array.from(files || [])) {
      if (next.length >= 4) {
        setPictureError(t("Höchstens 4 Bilder.", "At most 4 pictures."));
        break;
      }
      if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
        setPictureError(t("Nur PNG-, JPEG- oder WebP-Bilder.", "Only PNG, JPEG or WebP pictures."));
        continue;
      }
      if (file.size > 1024 * 1024) {
        setPictureError(t("Jedes Bild darf höchstens 1 MB groß sein.", "Each picture may be 1 MB at most."));
        continue;
      }
      next.push({ file, url: URL.createObjectURL(file) });
    }
    setPictures(next);
  }

  const meta = () => ({
    title: title.trim(),
    summary: { de: summaryDe.trim(), en: summaryEn.trim() },
    category,
    tags: [...new Set(tags.split(",").map((x) => x.trim()).filter(Boolean))].slice(0, 10).map((x) => x.slice(0, 32)),
    language,
  });
  async function build() {
    const body = new FormData();
    body.set("kind", source.kind);
    body.set("workspaceId", source.workspaceId);
    if (source.id) body.set("id", source.id);
    body.set("meta", JSON.stringify(meta()));
    for (const p of pictures) body.append("preview", p.file);
    const response = await fetch("/api/marketplace/package", { method: "POST", body, headers: { "Idempotency-Key": crypto.randomUUID() } });
    if (!response.ok) throw new Error(await readError(response, t));
    return { name: packageFileName(title.trim()), bytes: await response.arrayBuffer() };
  }
  const valid = !!title.trim() && !!(summaryDe.trim() || summaryEn.trim()) && !!draft;

  async function download() {
    setSending({ step: "building" });
    try {
      const pkg = await build();
      saveFile(pkg.name, pkg.bytes);
      setSending({ step: "idle" });
    } catch (e) {
      setSending({ step: "error", message: (e as Error).message });
    }
  }
  // The package as a file and the submit page to upload it: older desktop
  // apps and the mobile apps open other sites in the system browser, where
  // the page has no opener; also when the browser blocked the window or the
  // marketplace did not say "ready" in time.
  async function handToFile(reason: FileReason, pkg: Promise<{ name: string; bytes: ArrayBuffer }>, openPage: boolean) {
    try {
      const { name, bytes } = await pkg;
      saveFile(name, bytes);
      setSending((s) => (s.step === "sent" ? s : { step: "file", reason }));
      if (openPage) window.open(uploadAddress(config.origin, location.origin), "_blank", "noopener");
    } catch (e) {
      setSending({ step: "error", message: (e as Error).message });
    }
  }
  // Opened in the click (popup blockers), with its opener: the submit page
  // says "ready" to us and gets the package – only from and to the
  // configured origin and only that window. The desktop app opens it in a
  // window of its own when armed right before (lib/native-app.ts).
  function openMarketplace() {
    stop.current();
    const way = marketplacePublishWay();
    if (way !== "handover") {
      setSending({ step: "building" });
      void handToFile(way === "app-file" ? "app" : "desktop", build(), way === "desktop-file");
      return;
    }
    armDesktopMarketplace(config.origin);
    const win = window.open(submitAddress(config.origin, location.origin), "_blank");
    setSending({ step: "building" });
    const pkg = build();
    if (!win) {
      void handToFile("blocked", pkg, false);
      return;
    }
    pkg.then(() => setSending((s) => (s.step === "building" ? { step: "waiting" } : s))).catch((e: Error) => {
      setSending({ step: "error", message: e.message });
      cleanup();
    });
    let ready = false;
    // A copy each time: the submit page may load again (signing in there).
    const onMessage = async (event: MessageEvent) => {
      if (!trustedSource(event, config.origin, win) || !isSubmitReady(event.data)) return;
      ready = true;
      window.clearTimeout(timer);
      try {
        const { name, bytes } = await pkg;
        const copy = bytes.slice(0);
        win.postMessage(packageMessage(name, copy), config.origin, [copy]);
        setSending({ step: "sent" });
      } catch {}
    };
    // The submit page says "ready" as soon as it has loaded; without it
    // (no opener there after all) the file – still listening, in case it
    // comes late.
    const timer = window.setTimeout(() => {
      if (!ready) void handToFile("silent", pkg, false);
    }, READY_MS);
    const cleanup = () => {
      window.removeEventListener("message", onMessage);
      window.clearTimeout(timer);
    };
    window.addEventListener("message", onMessage);
    // Kept listening while the dialog is open (signing in on the marketplace reloads it).
    stop.current = cleanup;
  }

  const busy = sending.step === "building";
  const host = new URL(config.origin).host;
  const note = (n: { code: string; count?: number }) =>
    n.code === "images-dropped"
      ? t(`${n.count} Elemente bleiben hier (hochgeladene Bilder und Datensatzkarten gibt es nur in diesem Arbeitsbereich).`, `${n.count} elements stay here (uploaded pictures and record cards only exist in this workspace).`)
      : n.code === "references-cleared"
        ? t(`${n.count} Verweise auf Seiten, Personen oder Zugänge dieses Arbeitsbereichs werden beim Import neu zugeordnet oder geleert. Namen von Personen und die Adresse dieser Instanz kommen nicht mit.`, `${n.count} references to pages, people or credentials of this workspace are matched again or cleared on import. Names of people and the address of this instance are not included.`)
        : n.code === "fonts"
          ? t(`Enthält ${n.count} hochgeladene Schriften – veröffentliche nur Schriften, deren Lizenz das erlaubt.`, `Contains ${n.count} uploaded typefaces – only publish typefaces whose licence allows it.`)
          : t("Zugangsdaten, Läufe und Webhook-Adressen kommen nie mit.", "Credentials, runs and webhook addresses are never included.");
  return (
    <Modal open onClose={onClose} title={t("Im Marketplace veröffentlichen", "Publish to the marketplace")} subtitle={kindLabel(source.kind, t)} sheet className="marketplace-dialog">
      {loadError ? (
        <>
          <p className="marketplace-error" role="alert">
            {loadError}
          </p>
          <div className="modal-actions">
            <button type="button" className="button" onClick={onClose}>
              {t("Schließen", "Close")}
            </button>
          </div>
        </>
      ) : !draft ? (
        <p className="muted">{t("Wird vorbereitet …", "Preparing …")}</p>
      ) : (
        <form
          className="marketplace-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && !busy) openMarketplace();
          }}
        >
          <label>
            {t("Titel", "Title")}
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} required />
          </label>
          <label>
            {t("Kurzbeschreibung (Deutsch)", "Summary (German)")}
            <textarea value={summaryDe} onChange={(e) => setSummaryDe(e.target.value)} maxLength={300} rows={2} />
          </label>
          <label>
            {t("Kurzbeschreibung (Englisch)", "Summary (English)")}
            <textarea value={summaryEn} onChange={(e) => setSummaryEn(e.target.value)} maxLength={300} rows={2} />
          </label>
          <div className="marketplace-row">
            <label>
              {t("Kategorie", "Category")}
              <Select value={category} onChange={(e) => setCategory(e.target.value)}>
                {Object.entries(templateCategoryLabels(t)).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </Select>
            </label>
            <label>
              {t("Sprache", "Language")}
              <Select value={language} onChange={(e) => setLanguage(e.target.value)}>
                {languages(t).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </Select>
            </label>
          </div>
          <label>
            {t("Schlagwörter (mit Komma getrennt)", "Tags (separated by commas)")}
            <input value={tags} onChange={(e) => setTags(e.target.value)} maxLength={400} placeholder={t("z. B. Team, Planung", "e.g. team, planning")} />
          </label>
          <fieldset className="marketplace-pictures">
            <legend>{t("Vorschaubilder (bis zu 4)", "Preview pictures (up to 4)")}</legend>
            <div className="marketplace-thumbs">
              {pictures.map((p, i) => (
                <figure key={p.url}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.url} alt={t(`Vorschaubild ${i + 1}`, `Preview picture ${i + 1}`)} />
                  <button type="button" className="icon-button" aria-label={t(`Vorschaubild ${i + 1} entfernen`, `Remove preview picture ${i + 1}`)} onClick={() => setPictures(pictures.filter((x) => x !== p))}>
                    <X aria-hidden />
                  </button>
                </figure>
              ))}
              {pictures.length < 4 && (
                <label className="button compact marketplace-add-picture">
                  {t("Bild hinzufügen", "Add picture")}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    multiple
                    hidden
                    onChange={(e) => {
                      addPictures(e.target.files);
                      e.target.value = "";
                    }}
                  />
                </label>
              )}
            </div>
            <p className="muted">
              {source.kind === "document" || source.kind === "database"
                ? t("Flowplan erstellt kein Bild der Vorlage – füge am besten selbst ein Bildschirmfoto hinzu (PNG, JPEG oder WebP, je höchstens 1 MB).", "Flowplan doesn't create a picture of the template – best add a screenshot yourself (PNG, JPEG or WebP, 1 MB each at most).")
                : t("PNG, JPEG oder WebP, je höchstens 1 MB.", "PNG, JPEG or WebP, 1 MB each at most.")}
            </p>
            {pictureError && <p className="marketplace-error">{pictureError}</p>}
          </fieldset>
          {draft.notes.length > 0 && (
            <ul className="marketplace-notes">
              {draft.notes.map((n) => (
                <li key={n.code}>{note(n)}</li>
              ))}
            </ul>
          )}
          <p className="muted marketplace-license">
            {t(
              `Auf ${host} meldest du dich an, wählst die Lizenz (Standard: CC BY 4.0) und bestätigst, dass du die Rechte am Inhalt hast. Erst nach der Prüfung ist die Vorlage öffentlich.`,
              `On ${host} you sign in, choose the licence (default: CC BY 4.0) and confirm that you hold the rights to the content. The template becomes public only after the review.`,
            )}
          </p>
          {sending.step === "waiting" && <p className="marketplace-status" role="status">{t("Warte auf den Marketplace …", "Waiting for the marketplace …")}</p>}
          {sending.step === "sent" && <p className="marketplace-status ok" role="status">{t("An den Marketplace übergeben – dort geht es weiter.", "Handed over to the marketplace – continue there.")}</p>}
          {sending.step === "file" && (
            <p className="marketplace-status ok" role="status">
              {sending.reason === "desktop"
                ? t("Die Desktop-App öffnet den Marketplace im Browser. Die Datei wurde gespeichert – lade sie dort unter „Datei hochladen“ hoch.", 'The desktop app opens the marketplace in the browser. The file has been saved – upload it there under "Upload a .flowplan-template file".')
                : sending.reason === "app"
                  ? t("Die App öffnet den Marketplace im Browser. Sichere die Datei und lade sie dort unter „Datei hochladen“ hoch.", 'The app opens the marketplace in the browser. Save the file and upload it there under "Upload a .flowplan-template file".')
                  : sending.reason === "blocked"
                    ? t("Dein Browser hat das neue Fenster blockiert. Die Datei wurde gespeichert – öffne den Marketplace und lade sie dort unter „Datei hochladen“ hoch.", 'Your browser blocked the new window. The file has been saved – open the marketplace and upload it there under "Upload a .flowplan-template file".')
                    : t("Der Marketplace hat sich nicht gemeldet. Die Datei wurde gespeichert – lade sie dort unter „Datei hochladen“ hoch.", 'The marketplace didn\'t answer. The file has been saved – upload it there under "Upload a .flowplan-template file".')}{" "}
              <a href={uploadAddress(config.origin, location.origin)} target="_blank" rel="noopener noreferrer">
                {t("Marketplace öffnen", "Open the marketplace")}
              </a>
            </p>
          )}
          {sending.step === "error" && (
            <p className="marketplace-error" role="alert">
              {sending.message}
            </p>
          )}
          <div className="modal-actions marketplace-actions">
            <button type="button" className="button" disabled={!valid || busy} onClick={() => void download()}>
              <DownloadSimple aria-hidden /> {t("Als Datei herunterladen", "Download as a file")}
            </button>
            <button type="submit" className="button primary" disabled={!valid || busy}>
              <Storefront aria-hidden /> {busy ? t("Wird erstellt …", "Building …") : t("Im Marketplace öffnen", "Open in the marketplace")}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

/* ---------- Importing ---------- */

// Kept across the sign-in (and a reload) in this browser only.
const DB = "flowplan-marketplace";
const STORE = "pending";
const PENDING_KEY = "template";
const PENDING_MS = 24 * 60 * 60 * 1000;
type Pending = { bytes: ArrayBuffer; name: string; at: number; title?: string; kind?: string; author?: string };
function idb<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return new Promise((resolve) => {
    try {
      const open = indexedDB.open(DB, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(STORE);
      open.onerror = () => resolve(undefined);
      open.onsuccess = () => {
        try {
          const tx = open.result.transaction(STORE, mode);
          const request = run(tx.objectStore(STORE));
          tx.oncomplete = () => {
            open.result.close();
            resolve(request ? request.result : undefined);
          };
          tx.onerror = () => {
            open.result.close();
            resolve(undefined);
          };
        } catch {
          resolve(undefined);
        }
      };
    } catch {
      resolve(undefined);
    }
  });
}
const savePending = (p: Pending) => idb("readwrite", (s) => s.put(p, PENDING_KEY));
const clearPending = () => idb("readwrite", (s) => s.delete(PENDING_KEY));
async function loadPending() {
  const p = (await idb<Pending>("readonly", (s) => s.get(PENDING_KEY))) as Pending | undefined;
  if (!p || !(p.bytes instanceof ArrayBuffer) || Date.now() - p.at > PENDING_MS) return null;
  return p;
}

// "Vorlage aus Datei importieren": hands a `.flowplan-template` file to the
// receiver of the open app.
const FILE_EVENT = "flowplan:marketplace-file";
export function openTemplateFile(file: File) {
  window.dispatchEvent(new CustomEvent(FILE_EVENT, { detail: file }));
}
export function TemplateFileButton({ config, className = "button compact" }: { config?: MarketplaceClientConfig | null; className?: string }) {
  const t = useT();
  if (!config) return null;
  return (
    <label className={className}>
      {t("Vorlage aus Datei importieren …", "Import template from file …")}
      <input
        type="file"
        accept=".flowplan-template,application/zip"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) openTemplateFile(file);
        }}
      />
    </label>
  );
}

type Preview = {
  kind: MarketplaceKind;
  title: string;
  summary: { de: string; en: string };
  category: string;
  tags: string[];
  language: string;
  minVersion: string;
  license: string | null;
  author: string | null;
  url: string | null;
  previews: string[];
  size: number;
  creates: {
    name?: string;
    files?: number;
    fields?: number;
    views?: number;
    rows?: number;
    items?: number;
    dropped?: number;
    accent?: string | null;
    background?: string | null;
    fonts?: string[];
    rules?: { name: string; pattern: string; template: string }[];
    invalid?: number;
    workflow?: { nodes: { type: string; label: string; name: [string, string] | null }[]; hosts: string[]; ai: boolean; email: boolean; chat: boolean; webhook: boolean; references: number; gaps?: string[] };
  };
};

type ReceiverProps = {
  config: MarketplaceClientConfig | null | undefined;
  // Signed in: the app's bootstrap (workspaces, spaces, pages of the open workspace).
  boot?: Bootstrap;
  onSwitchWorkspace?: (id: string) => void | Promise<unknown>;
  onImported?: (result: { kind: string; pageId?: string }) => void | Promise<unknown>;
};

export function MarketplaceReceiver({ config, boot, onSwitchWorkspace, onImported }: ReceiverProps) {
  const t = useT();
  const [pending, setPending] = useState<Pending | null>(null),
    [received, setReceived] = useState<string | null>(null),
    [rejected, setRejected] = useState("");
  const signedIn = !!boot;
  const origin = config?.origin ?? null;
  const guest = !!boot?.workspace.guest;
  useEffect(() => {
    // Guests never publish (the server refuses as well).
    setMarketplace(boot && config && !guest ? config : null);
  }, [boot, config, guest]);

  // #marketplace-import: ready to the opener, the template from it.
  useEffect(() => {
    if (!config || !isImportHash(location.hash)) return;
    const opener = window.opener as Window | null;
    if (!opener) return;
    let done = false;
    const onMessage = async (event: MessageEvent) => {
      if (done || !trustedSource(event, config.origin, window.opener)) return;
      const message = parseTemplateMessage(event.data);
      if (!message) return;
      done = true;
      if (!(await checksumMatches(message))) {
        setRejected(t("Die empfangene Vorlage stimmt nicht mit ihrer Prüfsumme überein – nicht übernommen.", "The template received does not match its checksum – not taken over."));
        return;
      }
      const entry: Pending = { bytes: message.bytes, name: `${message.slug || "vorlage"}.flowplan-template`, at: Date.now(), title: message.title, kind: message.kind, author: message.author };
      await savePending(entry);
      window.history.replaceState(null, "", `${location.pathname}${location.search}${signedIn ? "#home" : ""}`);
      setReceived(message.title || "");
      setPending(entry);
    };
    window.addEventListener("message", onMessage);
    // Said a few times: the marketplace may still be getting ready.
    let tries = 0;
    const say = () => {
      if (done || tries++ > 5) return;
      try {
        opener.postMessage(instanceReady(config.version), config.origin);
      } catch {}
    };
    say();
    const timer = window.setInterval(say, 1500);
    return () => {
      window.removeEventListener("message", onMessage);
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin]);

  // Signed in: a template that waited for it.
  useEffect(() => {
    if (!config || !signedIn) return;
    void loadPending().then((p) => p && setPending((now) => now ?? p));
  }, [config, signedIn]);

  // A file from "Vorlage aus Datei importieren".
  useEffect(() => {
    if (!config) return;
    const onFile = async (event: Event) => {
      const file = (event as CustomEvent<File>).detail;
      if (!(file instanceof File)) return;
      if (file.size > MAX_PACKAGE_BYTES) {
        showToast({ text: t("Die Vorlage darf höchstens 25 MB groß sein.", "The template may be 25 MB at most."), tone: "error" });
        return;
      }
      setPending({ bytes: await file.arrayBuffer(), name: file.name, at: Date.now() });
    };
    window.addEventListener(FILE_EVENT, onFile);
    return () => window.removeEventListener(FILE_EVENT, onFile);
  }, [config, t]);

  if (!config) return null;
  if (!signedIn)
    return received !== null || rejected ? (
      <div className={`marketplace-banner${rejected ? " error" : ""}`} role="status">
        {rejected ||
          (received
            ? t(`Vorlage „${received}“ aus dem Marketplace empfangen. Melde dich an, um sie zu übernehmen.`, `Template “${received}” received from the marketplace. Sign in to take it over.`)
            : t("Vorlage aus dem Marketplace empfangen. Melde dich an, um sie zu übernehmen.", "Template received from the marketplace. Sign in to take it over."))}
      </div>
    ) : null;
  return (
    <>
      {rejected && (
        <div className="marketplace-banner error" role="alert">
          {rejected}
          <button type="button" className="icon-button" aria-label={t("Schließen", "Close")} onClick={() => setRejected("")}>
            <X aria-hidden />
          </button>
        </div>
      )}
      {pending && boot && (
        <ImportDialog
          pending={pending}
          boot={boot}
          onSwitchWorkspace={onSwitchWorkspace}
          onClose={async (imported) => {
            await clearPending();
            setPending(null);
            if (imported) await onImported?.(imported);
          }}
        />
      )}
    </>
  );
}

const MARKETPLACE_TARGET_PAGE_KINDS = new Set(["document", "database", "whiteboard", "workflow", "collection"]);

function ImportDialog({
  pending,
  boot,
  onSwitchWorkspace,
  onClose,
}: {
  pending: Pending;
  boot: Bootstrap;
  onSwitchWorkspace?: (id: string) => void | Promise<unknown>;
  onClose: (imported?: { kind: string; pageId?: string }) => void | Promise<void>;
}) {
  const t = useT();
  const locale = useLocale();
  const config = boot.instance?.marketplace;
  const instanceOrigin = useInstanceOrigin();
  const [preview, setPreview] = useState<Preview | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [spaceId, setSpaceId] = useState(""),
    [parentId, setParentId] = useState(""),
    [mine, setMine] = useState(false);
  const file = useCallback(() => new File([pending.bytes], pending.name || "vorlage.flowplan-template", { type: "application/zip" }), [pending]);
  useEffect(() => {
    let live = true;
    const body = new FormData();
    body.set("file", file());
    body.set("preview", "1");
    fetch("/api/marketplace/import", { method: "POST", body, headers: { "Idempotency-Key": crypto.randomUUID() } })
      .then(async (r) => (r.ok ? ((await r.json()) as Preview) : Promise.reject(new Error(await readError(r, t)))))
      .then((p) => live && setPreview(p))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  const ws = boot.workspace;
  const kind = preview?.kind;
  const ownerOnly = kind === "appearance" || kind === "link-rules";
  const workspaces = boot.workspaces.filter((w) => !w.guest && (ownerOnly ? w.role === "owner" : w.role === "owner" || w.role === "editor"));
  const allowedHere = workspaces.some((w) => w.id === ws.id);
  const spaces = boot.spaces.filter((s) => !s.deleted_at);
  const needsSpace = kind === "workflow";
  const spaceChoice = kind === "document" || kind === "database" || kind === "workflow";
  useEffect(() => {
    if (needsSpace && !spaces.some((s) => s.id === spaceId)) setSpaceId(spaces[0]?.id ?? "");
    if (!needsSpace && spaceId && !spaces.some((s) => s.id === spaceId)) setSpaceId("");
    setParentId("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.id, needsSpace]);
  const parents = boot.pages.filter((p) => p.space_id === spaceId && !p.deleted_at && MARKETPLACE_TARGET_PAGE_KINDS.has(p.kind));

  async function importNow() {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      const body = new FormData();
      body.set("file", file());
      body.set("workspaceId", ws.id);
      if (spaceChoice && spaceId) body.set("spaceId", spaceId);
      if (kind === "workflow" && parentId) body.set("parentId", parentId);
      if (mine) body.set("private", "true");
      const response = await fetch("/api/marketplace/import", { method: "POST", body, headers: { "Idempotency-Key": crypto.randomUUID() } });
      if (!response.ok) throw new Error(await readError(response, t));
      const result = (await response.json()) as { kind: string; pageId?: string; unresolved?: number; added?: number; dropped?: number };
      showToast({
        text:
          result.kind === "workflow"
            ? t("Workflow übernommen – pausiert, als Entwurf.", "Workflow taken over – paused, as a draft.")
            : result.kind === "link-rules"
              ? t(`${result.added ?? 0} Linkregeln hinzugefügt.`, `${result.added ?? 0} link rules added.`)
              : result.kind === "appearance"
                ? t("Erscheinungsbild übernommen.", "Appearance taken over.")
                : t("Vorlage übernommen.", "Template taken over."),
        tone: "info",
      });
      await onClose({ kind: result.kind, pageId: result.pageId });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const summary = preview ? (locale === "de" ? preview.summary.de || preview.summary.en : preview.summary.en || preview.summary.de) : "";
  const c = preview?.creates;
  const what = !preview || !c
    ? null
    : preview.kind === "document"
      ? c.files
        ? t(`Eine Dokumentvorlage „${c.name}“ mit ${c.files} Anhängen in der Vorlagengalerie.`, `A document template “${c.name}” with ${c.files} attachments in the template gallery.`)
        : t(`Eine Dokumentvorlage „${c.name}“ in der Vorlagengalerie.`, `A document template “${c.name}” in the template gallery.`)
      : preview.kind === "database"
        ? t(`Eine Datenbankvorlage „${c.name}“ mit ${c.fields} Eigenschaften, ${c.views} Ansichten und ${c.rows} Beispieleinträgen.`, `A database template “${c.name}” with ${c.fields} properties, ${c.views} views and ${c.rows} sample records.`)
        : preview.kind === "whiteboard"
          ? t(`Eine Whiteboard-Vorlage „${c.name}“ mit ${c.items} Elementen (unter „Eigene Vorlagen“ jedes Whiteboards).`, `A whiteboard template “${c.name}” with ${c.items} elements (under “Own templates” of every whiteboard).`)
          : preview.kind === "workflow"
            ? t(`Eine neue Workflow-Seite „${c.name}“.`, `A new workflow page “${c.name}”.`)
            : preview.kind === "appearance"
              ? t("Das Erscheinungsbild des Arbeitsbereichs – es ersetzt das jetzige.", "The workspace's appearance – it replaces the current one.")
              : t(`${c.rules?.length ?? 0} Regeln für automatische Links, zu den vorhandenen hinzugefügt.`, `${c.rules?.length ?? 0} rules for automatic links, added to the existing ones.`);
  const wf = c?.workflow;
  // The node's kind in the reader's language (the server sends both).
  const nodeName = (n: { type: string; name: [string, string] | null }) => (n.name ? (locale === "de" ? n.name[0] : n.name[1]) : n.type);
  return (
    <Modal open onClose={() => !busy && void onClose()} title={t("Vorlage übernehmen", "Take over template")} subtitle={preview ? kindLabel(preview.kind, t) : undefined} sheet wide className="marketplace-dialog marketplace-import">
      {error && !preview ? (
        <>
          <p className="marketplace-error" role="alert">
            {error}
          </p>
          <div className="modal-actions">
            <button type="button" className="button" onClick={() => void onClose()}>
              {t("Verwerfen", "Discard")}
            </button>
          </div>
        </>
      ) : !preview ? (
        <p className="muted">{t("Vorlage wird geprüft …", "Checking the template …")}</p>
      ) : (
        <div className="marketplace-preview">
          <header>
            <h3>{preview.title}</h3>
            <p className="muted">
              {[kindLabel(preview.kind, t), preview.author ? t(`von ${preview.author}`, `by ${preview.author}`) : null, preview.license ? t(`Lizenz ${preview.license}`, `Licence ${preview.license}`) : null].filter(Boolean).join(" · ")}
            </p>
            {summary && <p>{summary}</p>}
            {preview.url && (
              <p className="muted">
                <a href={marketplacePageAddress(preview.url, config, instanceOrigin)} target="_blank" rel="noopener noreferrer">
                  {t("Im Marketplace ansehen", "View in the marketplace")}
                </a>
              </p>
            )}
          </header>
          {preview.previews.length > 0 && (
            <div className="marketplace-shots">
              {preview.previews.map((src, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={i} src={src} alt={t(`Vorschau ${i + 1}`, `Preview ${i + 1}`)} />
              ))}
            </div>
          )}
          <section className="marketplace-creates">
            <h4>{t("Was entsteht", "What will be created")}</h4>
            <p>{what}</p>
            {preview.kind === "whiteboard" && !!c?.dropped && <p className="muted">{t(`${c.dropped} Elemente werden nicht übernommen (Bilder ohne https-Adresse, Datensatzkarten).`, `${c.dropped} elements are left out (pictures without an https address, record cards).`)}</p>}
            {preview.kind === "appearance" && (
              <p className="marketplace-look">
                {c?.accent && <span className="marketplace-swatch" style={{ background: c.accent }} aria-hidden />}
                {c?.accent ? t(`Akzentfarbe ${c.accent}`, `Accent colour ${c.accent}`) : t("Flowplans Akzentfarbe", "Flowplan's accent colour")}
                {c?.fonts?.length ? ` · ${t(`Schriften: ${c.fonts.join(", ")}`, `Typefaces: ${c.fonts.join(", ")}`)}` : ""}
              </p>
            )}
            {preview.kind === "link-rules" && (
              <ul className="marketplace-rules">
                {c?.rules?.map((r, i) => (
                  <li key={i}>
                    {r.name && <strong>{r.name}: </strong>}
                    <code>{r.pattern}</code> → <code>{r.template}</code>
                  </li>
                ))}
              </ul>
            )}
            {wf && (
              <>
                <p className="marketplace-paused">{t("Kommt pausiert an: als Entwurf, den du prüfst und selbst aktivierst.", "Arrives paused: as a draft that you check and activate yourself.")}</p>
                <ol className="marketplace-nodes">
                  {wf.nodes.map((n, i) => (
                    <li key={i}>
                      <strong>{n.label}</strong> <span className="muted">{nodeName(n)}</span>
                    </li>
                  ))}
                </ol>
                <ul className="marketplace-warnings">
                  {wf.hosts.length > 0 && <li>{t(`Spricht externe Dienste an: ${wf.hosts.join(", ")}`, `Talks to external services: ${wf.hosts.join(", ")}`)}</li>}
                  {wf.ai && <li>{t("Nutzt KI-Schritte (der KI-Anbieter dieser Instanz).", "Uses AI steps (this instance's AI provider).")}</li>}
                  {wf.email && <li>{t("Verschickt oder empfängt E-Mails.", "Sends or receives e-mail.")}</li>}
                  {wf.chat && <li>{t("Schreibt in Chat-Apps.", "Posts to chat apps.")}</li>}
                  {wf.webhook && <li>{t("Startet über einen Webhook.", "Starts from a webhook.")}</li>}
                  {!!wf.gaps?.length && <li>{t(`Nach dem Import im Editor festzulegen: ${wf.gaps.join(", ")}`, `To set in the editor after the import: ${wf.gaps.join(", ")}`)}</li>}
                  {wf.references > 0 && <li>{t(`${wf.references} Verweise werden mit Seiten dieses Arbeitsbereichs gleichen Namens verbunden, der Rest bleibt leer.`, `${wf.references} references are connected to pages of this workspace with the same name, the rest stays empty.`)}</li>}
                </ul>
              </>
            )}
          </section>
          <section className="marketplace-target">
            <h4>{t("Wohin", "Where to")}</h4>
            <label>
              {t("Arbeitsbereich", "Workspace")}
              <Select value={ws.id} disabled={busy || !onSwitchWorkspace} onChange={(e) => void onSwitchWorkspace?.(e.target.value)}>
                {boot.workspaces
                  .filter((w) => !w.guest)
                  .map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
              </Select>
            </label>
            {!allowedHere && (
              <p className="marketplace-error">
                {ownerOnly ? t("Das dürfen nur Eigentümer dieses Arbeitsbereichs.", "Only owners of this workspace may do this.") : t("Hier darfst du nichts anlegen.", "You may not create anything here.")}
              </p>
            )}
            {spaceChoice && (
              <label>
                {t("Bereich", "Space")}
                <Select value={spaceId} onChange={(e) => setSpaceId(e.target.value)} disabled={busy}>
                  {!needsSpace && <option value="">{t("Ganzer Arbeitsbereich", "Whole workspace")}</option>}
                  {spaces.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </label>
            )}
            {kind === "workflow" && spaceId && (
              <label>
                {t("Unter der Seite", "Below the page")}
                <Select value={parentId} onChange={(e) => setParentId(e.target.value)} disabled={busy}>
                  <option value="">{t("Oberste Ebene", "Top level")}</option>
                  {parents.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title || t("Ohne Titel", "Untitled")}
                    </option>
                  ))}
                </Select>
              </label>
            )}
            {(kind === "document" || kind === "database" || kind === "whiteboard") && (
              <label className="checkbox-label">
                <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
                {t("Nur für mich", "Only for me")}
              </label>
            )}
          </section>
          {error && (
            <p className="marketplace-error" role="alert">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <button type="button" className="button" disabled={busy} onClick={() => void onClose()}>
              {t("Verwerfen", "Discard")}
            </button>
            <button type="button" className="button primary" disabled={busy || !allowedHere || (needsSpace && !spaceId)} onClick={() => void importNow()}>
              {busy ? t("Wird übernommen …", "Taking over …") : t("Übernehmen", "Take over")}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
