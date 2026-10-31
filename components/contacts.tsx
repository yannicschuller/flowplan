"use client";
// Contacts databases in the browser (issue #64): the profile card on a
// contact's page, the "Kontakte" menu of the database toolbar (LDAP import
// and sync, vCard import and export, CardDAV address book) and the import
// dialog with the directory's organizational units.
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import {
  AddressBook,
  ArrowsClockwise,
  Cake,
  CaretDown,
  CaretRight,
  Copy,
  DeviceMobile,
  DownloadSimple,
  Envelope,
  FolderSimple,
  MagnifyingGlass,
  MapPin,
  Phone,
  TreeStructure,
  UploadSimple,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { serverMessage } from "@/lib/i18n-errors";
import { exportName } from "@/lib/export-name";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { qrModules, qrPath } from "@/lib/qr";
import { nativeApp } from "@/lib/native-app";
import type { Field, Row } from "@/lib/types";
import { useT } from "./i18n";
import { api, downloadBlob, Modal } from "./ui";
import { safeCollisionPadding } from "./safe-area";
import { showToast } from "./toast";
import { canInstallProfile } from "./caldav-profile";

export type ContactsData = { ldapFields: string[]; synced: Record<string, { missing: boolean }>; lastSync: number | null };
type Status = {
  available: boolean;
  connected: boolean;
  units: string[];
  mapping: Record<string, string[]>;
  defaultMapping: Record<string, string[]>;
  records: number;
  missing: number;
  lastSync: { at: number; ok: boolean; created: number; updated: number; missing: number; back: number; error?: string } | null;
  carddav: boolean;
};
type SyncResult = NonNullable<Status["lastSync"]>;

// Whether the directory keeps this property of this record (read-only here).
export function contactLocked(contacts: ContactsData | undefined, rowId: string, fieldId: string) {
  return !!contacts?.synced[rowId] && contacts.ldapFields.includes(fieldId);
}

const text = (value: unknown) => (value === null || value === undefined ? "" : Array.isArray(value) ? value.join(", ") : String(value)).trim();
export function initials(name: string) {
  const words = name.split(/\s+/).filter((w) => /\p{L}/u.test(w));
  return ((words[0]?.[0] || "") + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase() || "?";
}
const HUES = [210, 160, 25, 280, 340, 45, 190, 0];
export function avatarHue(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length];
}
export function ContactAvatar({ name, photo, size = 64 }: { name: string; photo?: string | null; size?: number }) {
  if (photo && /^\/api\/(?:files|share\/[\w-]+\/files)\/[\w-]+$/.test(photo))
    // eslint-disable-next-line @next/next/no-img-element
    return <img className="contact-avatar" src={photo} alt="" style={{ width: size, height: size }} />;
  return (
    <span className="contact-avatar contact-initials" aria-hidden style={{ width: size, height: size, fontSize: size * 0.38, ["--contact-hue" as string]: avatarHue(name) }}>
      {initials(name)}
    </span>
  );
}
const telHref = (value: string) => `tel:${value.replace(/[^\d+]/g, "")}`;

async function downloadVCards(pageId: string, title: string, rowIds?: string[]) {
  const response = await fetch("/api/contacts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "vcard.export", pageId, ...(rowIds ? { rowIds } : {}) }),
  });
  if (!response.ok) throw new Error(serverMessage((await response.json().catch(() => ({}))).error) || "Export failed.");
  downloadBlob(`${exportName(title)}.vcf`, await response.blob());
}

// The card at the top of a contact's page.
export function ContactCard({
  row,
  fields,
  pageId,
  contacts,
  onError,
}: {
  row: Row;
  fields: Field[];
  pageId: string;
  contacts?: ContactsData;
  onError: (message: string) => void;
}) {
  const t = useT();
  const has = (id: string) => fields.some((f) => f.id === id);
  const get = (id: string) => (has(id) ? text(row.cells[id]) : "");
  const name = text(row.cells[fields[0]?.id || "title"]) || [get("firstName"), get("lastName")].filter(Boolean).join(" ");
  const role = [get("position"), get("company")].filter(Boolean).join(" · ");
  const street = get("street"),
    place = [get("postalCode"), get("city")].filter(Boolean).join(" "),
    country = get("country");
  const address = [street, place, country].filter(Boolean);
  const birthday = get("birthday").slice(0, 10);
  const linked = contacts?.synced[row.id];
  let birthdayLabel = "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(birthday)) {
    const date = new Date(`${birthday}T00:00:00`);
    const now = new Date();
    let age = now.getFullYear() - date.getFullYear();
    if (now.getMonth() < date.getMonth() || (now.getMonth() === date.getMonth() && now.getDate() < date.getDate())) age--;
    birthdayLabel = `${date.toLocaleDateString(LOCALE_TAG, { day: "numeric", month: "long", year: "numeric" })}${age >= 0 && age < 130 ? t(` (${age} Jahre)`, ` (${age} years)`) : ""}`;
  }
  return (
    <section className="contact-card" aria-label={t("Kontaktkarte", "Contact card")}>
      <ContactAvatar name={name} photo={row.icon} size={72} />
      <div className="contact-card-body">
        {role && <p className="contact-role">{role}</p>}
        {(linked || false) && (
          <p className="contact-badges">
            <span className="ldap-marker" title={t("Name, Firma, Adresse und Telefon kommen aus dem LDAP-Verzeichnis und werden dort gepflegt.", "Name, company, address and phone come from the LDAP directory and are kept there.")}>
              {t("aus LDAP", "from LDAP")}
            </span>
            {linked?.missing && <span className="ldap-marker missing">{t("Nicht mehr im Verzeichnis", "No longer in directory")}</span>}
          </p>
        )}
        <div className="contact-actions">
          {get("email") && (
            <a className="contact-action" href={`mailto:${get("email")}`}>
              <Envelope size={16} aria-hidden />
              <span>{get("email")}</span>
            </a>
          )}
          {get("phone") && (
            <a className="contact-action" href={telHref(get("phone"))}>
              <Phone size={16} aria-hidden />
              <span>{get("phone")}</span>
            </a>
          )}
          {get("mobile") && (
            <a className="contact-action" href={telHref(get("mobile"))}>
              <DeviceMobile size={16} aria-hidden />
              <span>{get("mobile")}</span>
            </a>
          )}
        </div>
        {(address.length > 0 || birthdayLabel) && (
          <div className="contact-details">
            {address.length > 0 && (
              <a className="contact-address" href={`https://www.openstreetmap.org/search?query=${encodeURIComponent(address.join(", "))}`} target="_blank" rel="noopener noreferrer" title={t("Auf der Karte zeigen", "Show on the map")}>
                <MapPin size={16} aria-hidden />
                <span>
                  {address.map((line) => (
                    <span key={line}>{line}</span>
                  ))}
                </span>
              </a>
            )}
            {birthdayLabel && (
              <p className="contact-birthday">
                <Cake size={16} aria-hidden />
                <span>{birthdayLabel}</span>
              </p>
            )}
          </div>
        )}
      </div>
      <button
        type="button"
        className="icon-button contact-vcard"
        title={t("Als vCard herunterladen", "Download as vCard")}
        aria-label={t("Als vCard herunterladen", "Download as vCard")}
        onClick={() => void downloadVCards(pageId, name || "Kontakt", [row.id]).catch((e) => onError((e as Error).message))}
      >
        <DownloadSimple size={17} />
      </button>
    </section>
  );
}

// "aus LDAP" next to a property the directory keeps.
export function LdapMarker() {
  const t = useT();
  return (
    <span className="ldap-marker small" title={t("Kommt aus dem LDAP-Verzeichnis und wird dort gepflegt.", "Comes from the LDAP directory and is kept there.")}>
      LDAP
    </span>
  );
}

const syncSummary = (r: SyncResult, t: ReturnType<typeof useT>) =>
  r.ok
    ? t(
        `${new Date(r.at).toLocaleString(LOCALE_TAG)} · ${r.created} neu, ${r.updated} geändert, ${r.missing} nicht mehr im Verzeichnis`,
        `${new Date(r.at).toLocaleString(LOCALE_TAG)} · ${r.created} new, ${r.updated} changed, ${r.missing} no longer in directory`,
      )
    : t(`${new Date(r.at).toLocaleString(LOCALE_TAG)} · Fehler: ${r.error || ""}`, `${new Date(r.at).toLocaleString(LOCALE_TAG)} · Error: ${r.error || ""}`);

// The "Kontakte" menu of the database toolbar.
export function ContactsMenu({
  pageId,
  title,
  editable,
  selected,
  onChanged,
  onError,
}: {
  pageId: string;
  title: string;
  editable: boolean;
  selected: string[];
  onChanged: () => Promise<unknown>;
  onError: (message: string) => void;
}) {
  const t = useT();
  const [status, setStatus] = useState<Status | null>(null);
  const [dialog, setDialog] = useState<"ldap" | "carddav" | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const load = () =>
    api<Status>(`/api/contacts?view=status&page=${pageId}`)
      .then(setStatus)
      .catch(() => setStatus(null));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId]);
  const sync = async () => {
    setBusy(true);
    try {
      const r = await api<{ result: SyncResult; status: Status }>("/api/contacts", { action: "ldap.sync", pageId });
      setStatus((s) => (s ? { ...s, ...r.status } : s));
      if (r.result.ok) showToast({ text: t("Abgleich fertig", "Sync finished"), detail: syncSummary(r.result, t), tone: "info" });
      else onError(syncSummary(r.result, t));
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const importFile = async (chosen: File) => {
    setBusy(true);
    try {
      if (chosen.size > 5 * 1024 * 1024) throw new Error(t("Die Datei ist zu groß (höchstens 5 MB).", "The file is too large (at most 5 MB)."));
      const r = await api<{ created: number; updated: number; skipped: number }>("/api/contacts", { action: "vcard.import", pageId, text: await chosen.text() });
      showToast({
        text: r.created === 1 ? t("1 Kontakt importiert", "1 contact imported") : t(`${r.created} Kontakte importiert`, `${r.created} contacts imported`),
        detail: r.updated || r.skipped ? t(`${r.updated} aktualisiert, ${r.skipped} übersprungen (aus LDAP)`, `${r.updated} updated, ${r.skipped} skipped (from LDAP)`) : undefined,
        tone: "info",
      });
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
      if (file.current) file.current.value = "";
    }
  };
  const exportAll = (rowIds?: string[]) => void downloadVCards(pageId, title || "Kontakte", rowIds).catch((e) => onError((e as Error).message));
  return (
    <>
      <Dropdown.Root onOpenChange={(open) => open && void load()}>
        <Dropdown.Trigger asChild>
          <button title={t("Kontakte: Import, Export, Abgleich", "Contacts: import, export, sync")} aria-label={t("Kontakte", "Contacts")} aria-busy={busy || undefined}>
            <AddressBook size={17} />
          </button>
        </Dropdown.Trigger>
        <Dropdown.Portal>
          <Dropdown.Content collisionPadding={safeCollisionPadding()} className="dropdown contacts-menu" align="end" sideOffset={4}>
            {editable && status?.available && (
              <Dropdown.Item className="dropdown-item" onSelect={() => setDialog("ldap")}>
                <TreeStructure />
                {t("Aus LDAP importieren …", "Import from LDAP …")}
              </Dropdown.Item>
            )}
            {editable && status?.connected && (
              <Dropdown.Item className="dropdown-item" disabled={busy || !status.available} onSelect={() => void sync()}>
                <ArrowsClockwise />
                <span>
                  {t("Jetzt abgleichen", "Sync now")}
                  {status.lastSync && <small className="dropdown-hint">{syncSummary(status.lastSync, t)}</small>}
                </span>
              </Dropdown.Item>
            )}
            {editable && (status?.available || status?.connected) && <Dropdown.Separator className="dropdown-separator" />}
            {editable && (
              <Dropdown.Item className="dropdown-item" disabled={busy} onSelect={() => file.current?.click()}>
                <UploadSimple />
                {t("vCard importieren (.vcf) …", "Import vCard (.vcf) …")}
              </Dropdown.Item>
            )}
            <Dropdown.Item className="dropdown-item" onSelect={() => exportAll()}>
              <DownloadSimple />
              {t("Alle als vCard exportieren", "Export all as vCard")}
            </Dropdown.Item>
            {selected.length > 0 && (
              <Dropdown.Item className="dropdown-item" onSelect={() => exportAll(selected)}>
                <DownloadSimple />
                {t(`Auswahl als vCard exportieren (${selected.length})`, `Export selection as vCard (${selected.length})`)}
              </Dropdown.Item>
            )}
            <Dropdown.Separator className="dropdown-separator" />
            <Dropdown.Item className="dropdown-item" onSelect={() => setDialog("carddav")}>
              <AddressBook />
              {t("Als Adressbuch abonnieren (CardDAV) …", "Subscribe as address book (CardDAV) …")}
            </Dropdown.Item>
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>
      <input
        ref={file}
        type="file"
        accept=".vcf,.vcard,text/vcard,text/x-vcard"
        hidden
        onChange={(e) => {
          const chosen = e.target.files?.[0];
          if (chosen) void importFile(chosen);
        }}
      />
      {dialog === "ldap" && status && (
        <LdapImportDialog
          pageId={pageId}
          status={status}
          onClose={() => setDialog(null)}
          onImported={async (next) => {
            setStatus((s) => (s ? { ...s, ...next } : s));
            await onChanged();
          }}
          onError={onError}
        />
      )}
      {dialog === "carddav" && <CardDavDialog pageId={pageId} active={!!status?.carddav} onClose={() => setDialog(null)} onChange={(on) => setStatus((s) => (s ? { ...s, carddav: on } : s))} />}
    </>
  );
}

type Unit = { dn: string; name: string; description: string };
type Person = { dn: string; name: string; email: string; position: string; company: string; imported: boolean };

// One unit of the tree: its children load when it opens.
function UnitNode({
  unit,
  pageId,
  depth,
  chosen,
  subscribed,
  onChoose,
  initial = null,
}: {
  unit: Unit;
  pageId: string;
  depth: number;
  chosen: string;
  subscribed: string[];
  onChoose: (unit: Unit) => void;
  initial?: Unit[] | null;
}) {
  const t = useT();
  const [open, setOpen] = useState(depth === 0);
  const [children, setChildren] = useState<Unit[] | null>(initial);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open || children) return;
    api<{ units: Unit[] }>(`/api/contacts?view=units&page=${pageId}${depth ? `&parent=${encodeURIComponent(unit.dn)}` : ""}`)
      .then((r) => setChildren(r.units))
      .catch((e) => setError((e as Error).message));
  }, [open, children, pageId, unit.dn, depth]);
  const following = subscribed.some((s) => s.toLowerCase() === unit.dn.toLowerCase());
  return (
    <li role="treeitem" aria-expanded={open} aria-selected={chosen === unit.dn}>
      <div className="ou-row" data-active={chosen === unit.dn || undefined}>
        <button type="button" className="icon-button ou-toggle" aria-label={open ? t("Zuklappen", "Collapse") : t("Aufklappen", "Expand")} onClick={() => setOpen((v) => !v)}>
          {open ? <CaretDown size={13} /> : <CaretRight size={13} />}
        </button>
        <button type="button" className="ou-name" onClick={() => onChoose(unit)} title={unit.dn}>
          <FolderSimple size={16} aria-hidden />
          <span>{unit.name}</span>
          {following && <span className="ldap-marker small">{t("folgt", "following")}</span>}
        </button>
      </div>
      {open && (
        <ul role="group">
          {error && <li className="error small">{error}</li>}
          {!children && !error && <li className="muted small">{t("Lädt …", "Loading …")}</li>}
          {children?.map((child) => (
            <UnitNode key={child.dn} unit={child} pageId={pageId} depth={depth + 1} chosen={chosen} subscribed={subscribed} onChoose={onChoose} />
          ))}
        </ul>
      )}
    </li>
  );
}

const MAPPING_KEYS: [string, string, string][] = [
  ["title", "Name", "Name"],
  ["firstName", "Vorname", "First name"],
  ["lastName", "Nachname", "Last name"],
  ["company", "Firma", "Company"],
  ["position", "Position", "Position"],
  ["email", "E-Mail", "E-mail"],
  ["phone", "Telefon", "Phone"],
  ["mobile", "Mobil", "Mobile"],
  ["street", "Straße", "Street"],
  ["postalCode", "PLZ", "Postal code"],
  ["city", "Ort", "City"],
  ["country", "Land", "Country"],
  ["birthday", "Geburtstag", "Birthday"],
];

function LdapImportDialog({
  pageId,
  status,
  onClose,
  onImported,
  onError,
}: {
  pageId: string;
  status: Status;
  onClose: () => void;
  onImported: (status: Partial<Status>) => Promise<void>;
  onError: (message: string) => void;
}) {
  const t = useT();
  const [root, setRoot] = useState<Unit | null>(null);
  const [rootUnits, setRootUnits] = useState<Unit[] | null>(null);
  const [unit, setUnit] = useState<Unit | null>(null);
  const [people, setPeople] = useState<Person[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [whole, setWhole] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [units, setUnits] = useState(status.units);
  const [mapping, setMapping] = useState<Record<string, string>>(() =>
    Object.fromEntries(MAPPING_KEYS.map(([key]) => [key, (status.mapping[key] || status.defaultMapping[key] || []).join(", ")])),
  );
  useEffect(() => {
    api<{ base: string; units: Unit[] }>(`/api/contacts?view=units&page=${pageId}`)
      .then((r) => {
        const base = { dn: r.base, name: r.base.split(",")[0].replace(/^[^=]+=/, "") || r.base, description: "" };
        setRootUnits(r.units);
        setRoot(base);
        setUnit(base);
      })
      .catch((e) => setError((e as Error).message));
  }, [pageId]);
  // The people of the chosen unit, or a search below it.
  useEffect(() => {
    if (!unit) return;
    let current = true;
    setPeople(null);
    const timer = setTimeout(
      () =>
        api<{ people: Person[]; truncated: boolean }>(
          `/api/contacts?view=people&page=${pageId}&unit=${encodeURIComponent(unit.dn)}${query.trim() ? `&q=${encodeURIComponent(query.trim())}` : ""}`,
        )
          .then((r) => {
            if (!current) return;
            setPeople(r.people);
            setTruncated(r.truncated);
          })
          .catch((e) => current && setError((e as Error).message)),
      query ? 300 : 0,
    );
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [unit, query, pageId]);
  useEffect(() => setWhole(false), [unit]);
  const selectable = useMemo(() => (people || []).filter((p) => !p.imported), [people]);
  const allPicked = selectable.length > 0 && selectable.every((p) => picked.has(p.dn));
  const count = picked.size;
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const custom = Object.fromEntries(
        Object.entries(mapping).map(([key, value]) => [key, value.split(/[\s,]+/).map((v) => v.trim()).filter(Boolean)]),
      );
      const r = await api<{ result: SyncResult; status: Status }>("/api/contacts", {
        action: "ldap.import",
        pageId,
        entries: [...picked],
        units: whole && unit ? [unit.dn] : [],
        mapping: custom,
      });
      if (!r.result.ok) throw new Error(syncSummary(r.result, t));
      showToast({
        text: r.result.created === 1 ? t("1 Kontakt übernommen", "1 contact imported") : t(`${r.result.created} Kontakte übernommen`, `${r.result.created} contacts imported`),
        detail: syncSummary(r.result, t),
        tone: "info",
      });
      await onImported(r.status);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const unsubscribe = async (dn: string) => {
    try {
      const r = await api<{ status: Status }>("/api/contacts", { action: "ldap.unsubscribe", pageId, unit: dn });
      setUnits(r.status.units);
      await onImported(r.status);
    } catch (e) {
      onError((e as Error).message);
    }
  };
  return (
    <Modal open wide className="ldap-import" title={t("Kontakte aus LDAP importieren", "Import contacts from LDAP")} onClose={onClose}>
      <p className="muted small">
        {t(
          "Wähle eine Organisationseinheit (OU) und die Personen, die übernommen werden. Name, Firma, Adresse und Telefon bleiben mit dem Verzeichnis abgeglichen und sind hier schreibgeschützt; Notizen und eigene Eigenschaften bleiben frei.",
          "Choose an organizational unit (OU) and the people to import. Name, company, address and phone stay in sync with the directory and are read-only here; notes and your own properties stay free.",
        )}
      </p>
      {units.length > 0 && (
        <div className="ldap-subscribed">
          <strong>{t("Ganze OUs, denen diese Datenbank folgt:", "Whole OUs this database follows:")}</strong>
          <ul>
            {units.map((dn) => (
              <li key={dn}>
                <code>{dn}</code>
                <button type="button" className="text-button" onClick={() => void unsubscribe(dn)}>
                  {t("Nicht mehr folgen", "Stop following")}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="ldap-browser">
        <nav className="ldap-tree" aria-label={t("Organisationseinheiten", "Organizational units")}>
          {root ? (
            <ul role="tree">
              <UnitNode unit={root} pageId={pageId} depth={0} chosen={unit?.dn || ""} subscribed={units} onChoose={setUnit} initial={rootUnits} />
            </ul>
          ) : (
            !error && <p className="muted small">{t("Verzeichnis wird gelesen …", "Reading the directory …")}</p>
          )}
        </nav>
        <section className="ldap-people" aria-label={t("Personen", "People")}>
          <label className="ldap-search">
            <MagnifyingGlass size={15} aria-hidden />
            <input
              type="search"
              value={query}
              placeholder={t("In dieser OU und darunter suchen", "Search this OU and below")}
              aria-label={t("Personen suchen", "Search people")}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          {unit && (
            <label className="checkbox-label ldap-whole">
              <input type="checkbox" checked={whole} onChange={(e) => setWhole(e.target.checked)} />
              <span>
                {t(`Ganze OU „${unit.name}“ übernehmen (auch künftige)`, `Import the whole OU “${unit.name}” (also future members)`)}
                <small className="muted">{t("Alle Personen darin und in Unter-OUs, neue kommen beim Abgleich dazu.", "Everyone in it and in sub-OUs; new people are added by the sync.")}</small>
              </span>
            </label>
          )}
          {!whole && people && people.length > 0 && (
            <label className="checkbox-label ldap-all">
              <input
                type="checkbox"
                checked={allPicked}
                disabled={!selectable.length}
                onChange={(e) => setPicked(e.target.checked ? new Set([...picked, ...selectable.map((p) => p.dn)]) : new Set([...picked].filter((dn) => !selectable.some((p) => p.dn === dn))))}
              />
              {t("Alle auswählen", "Select all")}
            </label>
          )}
          {!people && !error && <p className="muted small">{t("Lädt …", "Loading …")}</p>}
          {people && !people.length && <p className="muted small">{t("Keine Personen in dieser OU.", "No people in this OU.")}</p>}
          <ul className="ldap-person-list">
            {people?.map((p) => (
              <li key={p.dn}>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    disabled={p.imported || whole}
                    checked={p.imported || whole || picked.has(p.dn)}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(p.dn);
                      else next.delete(p.dn);
                      setPicked(next);
                    }}
                  />
                  <span className="ldap-person">
                    <strong>{p.name}</strong>
                    <small className="muted">{[p.position, p.company, p.email].filter(Boolean).join(" · ") || p.dn}</small>
                  </span>
                  {p.imported && <span className="ldap-marker small">{t("übernommen", "imported")}</span>}
                </label>
              </li>
            ))}
          </ul>
          {truncated && <p className="muted small">{t("Nur die ersten 500 Einträge – bitte die Suche nutzen.", "Only the first 500 entries – please use the search.")}</p>}
        </section>
      </div>
      <details className="ldap-mapping">
        <summary>{t("Zuordnung der Attribute", "Attribute mapping")}</summary>
        <p className="muted small">{t("Je Eigenschaft die LDAP-Attribute, das erste mit Wert gilt.", "Per property the LDAP attributes; the first one with a value wins.")}</p>
        <div className="ldap-mapping-grid">
          {MAPPING_KEYS.map(([key, de, en]) => (
            <label key={key}>
              {t(de, en)}
              <input value={mapping[key] || ""} onChange={(e) => setMapping({ ...mapping, [key]: e.target.value })} spellCheck={false} />
            </label>
          ))}
        </div>
      </details>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button type="button" className="button" onClick={onClose}>
          {t("Abbrechen", "Cancel")}
        </button>
        <button type="button" className="button primary" disabled={busy || (!count && !whole)} onClick={() => void submit()}>
          {busy
            ? t("Wird übernommen …", "Importing …")
            : whole
              ? t("Ganze OU übernehmen", "Import whole OU")
              : t(`${count} übernehmen`, `Import ${count}`)}
        </button>
      </div>
    </Modal>
  );
}

// Read-only address book over CardDAV, like CalDAV for calendars.
function CardDavDialog({ pageId, active, onClose, onChange }: { pageId: string; active: boolean; onClose: () => void; onChange: (on: boolean) => void }) {
  const t = useT();
  const [access, setAccess] = useState<{ server: string; addressBook: string; username: string; password: string } | null>(null);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (action: "carddav.create" | "carddav.revoke") => {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ server: string; addressBook: string; username: string; password: string }>("/api/contacts", { action, pageId });
      setAccess(action === "carddav.create" ? r : null);
      onChange(action === "carddav.create");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const profile = async () => {
    setBusy(true);
    setError("");
    try {
      const { url } = await api<{ url: string }>("/api/contacts", { action: "carddav.profile", pageId });
      const app = nativeApp();
      if (app?.openInBrowser) app.openInBrowser(url);
      else if (canInstallProfile()) location.assign(url);
      else setLink(url);
      onChange(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const qr = useMemo(() => {
    if (!link) return null;
    try {
      const modules = qrModules(link);
      return { size: modules.length, path: qrPath(modules) };
    } catch {
      return null;
    }
  }, [link]);
  const field = (label: string, value: string) => (
    <label>
      {label}
      <span className="copy-field">
        <input readOnly value={value} onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="button compact" onClick={() => void navigator.clipboard.writeText(value).catch(() => {})}>
          <Copy size={14} /> {t("Kopieren", "Copy")}
        </button>
      </span>
    </label>
  );
  return (
    <Modal open title={t("Als Adressbuch abonnieren", "Subscribe as address book")} onClose={onClose}>
      <section className="caldav-sync">
        <p className="muted small">
          {t(
            "Die Kontakte erscheinen in Apple Kontakte, Thunderbird oder DAVx⁵ (Android) – nur lesend: Änderungen machst du hier in Flowplan. Du siehst dort nur, was du hier lesen darfst.",
            "The contacts appear in Apple Contacts, Thunderbird or DAVx⁵ (Android) – read-only: you make changes here in Flowplan. You see there only what you may read here.",
          )}
        </p>
        {access ? (
          <>
            {field(t("Server", "Server"), access.server)}
            {field(t("Benutzername", "Username"), access.username)}
            {field(t("Passwort (nur jetzt sichtbar)", "Password (visible only now)"), access.password)}
            {field(t("Adressbuch-Adresse (Thunderbird, DAVx⁵)", "Address book address (Thunderbird, DAVx⁵)"), access.addressBook)}
            <p className="muted small">
              {t(
                "Apple: Einstellungen → Kontakte → Accounts → Account hinzufügen → Andere → CardDAV-Account.",
                "Apple: Settings → Contacts → Accounts → Add account → Other → CardDAV account.",
              )}
            </p>
          </>
        ) : (
          <div className="calendar-subscribe-actions">
            <button className="button" disabled={busy} onClick={() => void run("carddav.create")}>
              {active ? t("Neues Passwort erzeugen", "Create new password") : t("Zugang einrichten", "Set up access")}
            </button>
            {active && (
              <button className="button" disabled={busy} onClick={() => void run("carddav.revoke")}>
                {t("Zugang beenden", "End access")}
              </button>
            )}
            <button className="button" disabled={busy} onClick={() => void profile()}>
              {t("Auf iPhone, iPad oder Mac einrichten", "Set up on iPhone, iPad or Mac")}
            </button>
          </div>
        )}
        {link && (
          <div className="contacts-profile-link">
            <p className="muted small">{t("Mit der Kamera des iPhones oder iPads scannen – der Link gilt einmal und zehn Minuten.", "Scan with the camera of the iPhone or iPad – the link works once and for ten minutes.")}</p>
            {qr && (
              <svg className="totp-qr" viewBox={`-4 -4 ${qr.size + 8} ${qr.size + 8}`} shapeRendering="crispEdges" role="img" aria-label={t("QR-Code für das Profil", "QR code for the profile")}>
                <rect x={-4} y={-4} width={qr.size + 8} height={qr.size + 8} fill="#fff" />
                <path d={qr.path} fill="#000" />
              </svg>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </section>
    </Modal>
  );
}
