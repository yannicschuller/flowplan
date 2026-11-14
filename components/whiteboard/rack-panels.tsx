"use client";
// Rack planning on the board (#90): the device library, the details of the
// selected rack, device, port or cable, the board's port overview and cable
// list, JSON import/export and the NetBox import. Racks, devices and cables
// are ordinary board elements (lib/whiteboard-rack.ts), so everything here
// is a normal, undoable board edit that collaborators see live.
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type ReactNode } from "react";
import { ArrowsDownUp, DownloadSimple, HardDrives, MagnifyingGlass, Plugs, Printer, Trash, UploadSimple, X, Warning, Plus, CloudArrowDown, FloppyDisk } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { Modal, api } from "../ui";
import { Select } from "../select";
import { showToast } from "../toast";
import { printDocument } from "../print-page";
import { saveFile, exportFileName } from "./board-export";
import type { BoardApi } from "./board-context";
import type { Point, WhiteboardItem } from "@/lib/whiteboard-model";
import { serverMessage } from "@/lib/i18n-errors";
import {
  RACK_HEADER,
  RACK_MAX_U,
  addPorts,
  applyRackLayout,
  cableColors,
  cableDraft,
  cableIssues,
  cableLabelsHtml,
  cableRows,
  cableStyle,
  cableTypeFor,
  cableTypeNames,
  cableTypes,
  cablesCsv,
  cleanRoles,
  MAX_IPS,
  nicPort,
  normalizeMac,
  parseIps,
  cleanIp,
  roleSuggestions,
  deviceKinds,
  deviceOf,
  devicesIn,
  firstFreeU,
  formatPower,
  formatWeight,
  isCable,
  parseRacksJson,
  portAnchor,
  portCategory,
  portConnections,
  portRows,
  portTypeNames,
  portTypes,
  portsCsv,
  rackCollisions,
  rackOf,
  rackTotals,
  racksIn,
  racksJson,
  rackWidths,
  resolveCables,
  settleCableEnds,
  snapDevice,
  sourceLoads,
  RackJsonError,
  type CableData,
  type DeviceData,
  type PortCategory,
  type PortRow,
  type PortType,
  type RackData,
  type RackPort,
} from "@/lib/whiteboard-rack";
import { deviceItem, deviceKindNames, libraryGroups, rackItem, rackPresets, searchTemplates, templateDevice, type DeviceTemplate } from "@/lib/whiteboard-rack-library";
import { deviceSvg, rackContext } from "@/lib/whiteboard-rack-svg";
import { DraftInput, DraftTextarea, useDraft } from "./draft-field";

type T = (de: string, en: string) => string;
// Colours for devices (besides the colour of their kind).
const DEVICE_SWATCHES = ["#3b5bdb", "#1971c2", "#0c8599", "#2b8a3e", "#f59f00", "#e8590c", "#c92a2a", "#c2255c", "#6741d9", "#5c636a", "#2b3035"];
export const RACK_DRAG_TYPE = "application/x-flowplan-rack";

// ---- the focused port (clicked on the board or chosen in the details) ----

type Focus = { device: string; port: string } | null;
let focused: Focus = null;
const listeners = new Set<() => void>();
export function setRackFocus(next: Focus) {
  if (focused?.device === next?.device && focused?.port === next?.port) return;
  focused = next;
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const useRackFocus = () => useSyncExternalStore(subscribe, () => focused, () => null);

// ---- placing racks and devices ----

// Racks go next to the last rack (side by side), below everything else.
export function placeRack(board: BoardApi, units: number, t: T, at?: Point) {
  const racks = racksIn(board.items);
  const last = racks.reduce<WhiteboardItem | null>((a, r) => (!a || r.x > a.x ? r : a), null);
  const draft = rackItem(units, t, { x: 0, y: 0 });
  const where = at ? { x: at.x - draft.w / 2, y: at.y - RACK_HEADER } : last ? { x: last.x + last.w + 48, y: last.y } : { x: board.center().x - draft.w / 2, y: board.center().y - draft.h / 2 };
  const lowest = Math.min(0, ...board.items.map((i) => i.z || 0));
  let id = "";
  board.stopCapturing();
  board.transact(() => {
    id = board.add({ ...draft, x: Math.round(where.x), y: Math.round(where.y), z: lowest - 1 });
  });
  board.stopCapturing();
  board.select([id]);
  return id;
}
// The rack a device added with a click goes into: the selected one (or the
// selected device's), else the one nearest to the middle of the view.
function targetRack(board: BoardApi) {
  const selected = board.items.filter((i) => board.selection.has(i.id));
  const direct = selected.find((i) => i.type === "rack") || selected.map((i) => (i.rackId ? board.byId.get(i.rackId) : undefined)).find(Boolean);
  if (direct) return direct;
  const c = board.center();
  return racksIn(board.items).sort((a, b) => Math.hypot(a.x + a.w / 2 - c.x, a.y + a.h / 2 - c.y) - Math.hypot(b.x + b.w / 2 - c.x, b.y + b.h / 2 - c.y))[0];
}
export function placeDevice(board: BoardApi, device: DeviceData, name: string, t: T, options: { at?: Point; fill?: string } = {}) {
  const draft = deviceItem(device, name, { x: 0, y: 0 }, options.fill);
  let props: Partial<WhiteboardItem>;
  if (options.at) {
    const probe = { ...draft, id: "", z: 0, x: options.at.x - draft.w / 2, y: options.at.y - draft.h / 2 } as WhiteboardItem;
    props = { x: probe.x, y: probe.y, ...snapDevice(board.items, probe, probe.x, probe.y) };
  } else {
    const rack = targetRack(board);
    const u = rack ? firstFreeU(board.items, rack.id, device) : null;
    if (rack && u) props = { rackId: rack.id, u };
    else {
      const c = board.center();
      props = { x: Math.round(c.x - draft.w / 2), y: Math.round(c.y - draft.h / 2) };
      if (rack) showToast({ text: t("Im Rack ist kein Platz mehr – das Gerät liegt daneben.", "There is no room left in the rack – the device lies next to it.") });
    }
  }
  let id = "";
  board.stopCapturing();
  board.transact(() => {
    const clean = Object.fromEntries(Object.entries({ ...draft, ...props }).filter(([, v]) => v !== undefined)) as typeof draft;
    id = board.add(clean);
  });
  board.stopCapturing();
  board.select([id]);
  return id;
}
type DragPayload = { rack: number } | { device: DeviceData; name: string; fill?: string };
export function dropRackItem(board: BoardApi, e: DragEvent, at: Point, t: T) {
  const raw = e.dataTransfer.getData(RACK_DRAG_TYPE);
  if (!raw) return false;
  e.preventDefault();
  try {
    const payload = JSON.parse(raw) as DragPayload;
    if ("rack" in payload) placeRack(board, Math.max(1, Math.min(RACK_MAX_U, Number(payload.rack) || 42)), t, at);
    else placeDevice(board, payload.device, payload.name, t, { at, fill: payload.fill });
  } catch {}
  return true;
}
// Puts imported racks (a JSON file or NetBox) on the board.
export function insertRacks(board: BoardApi, data: unknown, t: T) {
  try {
    const drafts = settleCableEnds(parseRacksJson(data));
    board.stopCapturing();
    const placed = board.insertDrafts(drafts);
    board.stopCapturing();
    // Racks below everything else, so their devices are on top.
    const lowest = Math.min(0, ...board.items.map((i) => i.z || 0));
    board.transact(() => placed.filter((i) => i.type === "rack").forEach((r, i) => board.setProps(r.id, { z: lowest - 1 - i })));
    board.fit(placed);
    const racks = placed.filter((i) => i.type === "rack").length,
      devices = placed.filter((i) => i.type === "device").length,
      cables = placed.filter((i) => i.type === "connector").length;
    showToast({ text: t(`Übernommen: ${racks} Racks, ${devices} Geräte, ${cables} Kabel`, `Imported: ${racks} racks, ${devices} devices, ${cables} cables`) });
  } catch (error) {
    const code = error instanceof RackJsonError ? error.message : "";
    board.onError(
      code === "json"
        ? t("Die Datei ist kein gültiges JSON.", "The file is not valid JSON.")
        : code === "format"
          ? t("Das ist keine Rack-Datei aus Flowplan.", "This is not a rack file from Flowplan.")
          : code === "empty"
            ? t("Die Datei enthält keine Racks oder Geräte.", "The file contains no racks or devices.")
            : (error as Error).message,
    );
  }
}
export function exportRacksJson(board: BoardApi, title: string) {
  const items = board.items;
  const chosen = board.selection.size ? new Set(board.selection) : undefined;
  const data = racksJson(items, chosen && items.some((i) => chosen.has(i.id) && (i.type === "rack" || i.type === "device")) ? chosen : undefined);
  saveFile(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }), exportFileName(`${title} – Racks`, "json"));
}

// ---- small pieces ----

// A small picture of a device: the side with its ports, 0U devices lying.
function DevicePreview({ device, fill, name, t }: { device: DeviceData; fill?: string; name: string; t: T }) {
  const markup = useMemo(() => {
    const front = device.ports.some((p) => p.face === "front");
    const shown: DeviceData = { ...device, mount: undefined, height: device.mount === "left" || device.mount === "right" ? 1 : Math.min(device.height, 2), ports: front ? device.ports.filter((p) => p.face === "front") : device.ports.map((p) => ({ ...p, face: "front" })) };
    const [item] = applyRackLayout([{ ...deviceItem(shown, name, { x: 0, y: 0 }, fill), id: "preview", z: 0 } as WhiteboardItem]);
    return { svg: deviceSvg(item, new Map([[item.id, item]]), rackContext([item]), t), w: item.w, h: item.h };
  }, [device, fill, name, t]);
  return (
    <svg className="wb-rack-preview" viewBox={`0 0 ${markup.w} ${markup.h}`} aria-hidden="true" preserveAspectRatio="xMidYMid meet">
      <g dangerouslySetInnerHTML={{ __html: markup.svg }} />
    </svg>
  );
}
const numberValue = (raw: string) => {
  if (!raw.trim()) return undefined;
  const n = Number(raw.replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};
function NumberField({ label, value, onChange, min = 0, max, step = 1, suffix }: { label: string; value: number | undefined; onChange: (v: number | undefined) => void; min?: number; max?: number; step?: number; suffix?: string }) {
  // What is typed stays while the field has the focus ("1." on the way to
  // "1.5"); see draft-field.tsx.
  const { draft: text, setDraft: setText, bind } = useDraft(value === undefined ? "" : String(value));
  return (
    <label className="wb-rack-field">
      <span>{label}</span>
      <span className="wb-rack-input">
        <input
          inputMode="decimal"
          type="number"
          min={min}
          max={max}
          step={step}
          value={text}
          {...bind}
          onChange={(e) => {
            setText(e.target.value);
            const n = numberValue(e.target.value);
            if (e.target.value.trim() === "" || (n !== undefined && n >= min && (max === undefined || n <= max))) onChange(n);
          }}
        />
        {suffix && <small>{suffix}</small>}
      </span>
    </label>
  );
}
function TextField({
  label,
  value,
  onChange,
  max = 120,
  multiline = false,
  placeholder,
  validate,
  inputMode,
  spellCheck,
}: {
  label: string;
  value: string | undefined;
  onChange: (v: string) => void;
  max?: number;
  multiline?: boolean;
  placeholder?: string;
  validate?: (draft: string) => string | null;
  inputMode?: "text" | "decimal";
  spellCheck?: boolean;
}) {
  // The label stands apart from the field, so an error below the field is
  // its description, not part of its name.
  const id = useId();
  return (
    <div className="wb-rack-field text">
      <label htmlFor={id} className="wb-rack-label">
        {label}
      </label>
      {multiline ? (
        <DraftTextarea id={id} rows={3} maxLength={max} value={value || ""} placeholder={placeholder} onValue={onChange} validate={validate} />
      ) : (
        <DraftInput id={id} type="text" maxLength={max} value={value || ""} placeholder={placeholder} onValue={onChange} validate={validate} inputMode={inputMode} spellCheck={spellCheck} autoCapitalize={spellCheck === false ? "off" : undefined} />
      )}
    </div>
  );
}
// Checks for the network fields (#187): what cannot be saved says why.
const ipsError = (t: T) => (draft: string) => {
  const { invalid, tooMany } = parseIps(draft);
  if (invalid.length) return t(`Keine gültige IP-Adresse: ${invalid[0]}`, `Not a valid IP address: ${invalid[0]}`);
  return tooMany ? t(`Höchstens ${MAX_IPS} Adressen.`, `At most ${MAX_IPS} addresses.`) : null;
};
const ipError = (t: T) => (draft: string) => (!draft.trim() || cleanIp(draft) ? null : t("Keine gültige IP-Adresse (z. B. 10.0.0.5/24).", "Not a valid IP address (e.g. 10.0.0.5/24)."));
const macError = (t: T) => (draft: string) => (!draft.trim() || normalizeMac(draft) ? null : t("Keine gültige MAC-Adresse (z. B. aa:bb:cc:dd:ee:ff).", "Not a valid MAC address (e.g. aa:bb:cc:dd:ee:ff)."));
// Roles of a device as tags; suggestions in the person's language, a role
// is kept as typed.
function RoleField({ roles, onChange, t }: { roles: string[]; onChange: (roles: string[] | undefined) => void; t: T }) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const id = useId();
  const add = (raw: string) => {
    if (raw.trim()) onChange(cleanRoles([...roles, ...raw.split(",")]));
    setText("");
  };
  const q = text.trim().toLowerCase();
  const suggestions = roleSuggestions
    .map(([de, en]) => t(de, en))
    .filter((s) => !roles.some((r) => r.toLowerCase() === s.toLowerCase()) && (!q || s.toLowerCase().includes(q)))
    .slice(0, 8);
  return (
    <div className="wb-rack-field text">
      <span id={`${id}-label`}>{t("Rollen", "Roles")}</span>
      <div className="wb-rack-roles">
        {roles.map((r) => (
          <span key={r} className="wb-rack-role">
            {r}
            <button type="button" aria-label={t(`Rolle „${r}“ entfernen`, `Remove role “${r}”`)} onClick={() => onChange(cleanRoles(roles.filter((x) => x !== r)))}>
              <X size={11} aria-hidden="true" />
            </button>
          </span>
        ))}
        <input
          type="text"
          aria-labelledby={`${id}-label`}
          aria-describedby={open && suggestions.length ? `${id}-list` : undefined}
          value={text}
          maxLength={40}
          placeholder={roles.length ? t("Weitere Rolle …", "Another role …") : t("z. B. Docker-Host, Hypervisor", "e.g. Docker host, hypervisor")}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            setOpen(false);
            add(text);
          }}
          onChange={(e) => {
            if (e.target.value.includes(",")) add(e.target.value);
            else setText(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add(text);
            } else if (e.key === "Backspace" && !text && roles.length) onChange(cleanRoles(roles.slice(0, -1)));
          }}
        />
      </div>
      {open && !!suggestions.length && (
        <div className="wb-rack-role-suggestions" id={`${id}-list`} aria-label={t("Vorschläge", "Suggestions")} role="group">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              // Keeps the focus in the field (its blur would add the typed text).
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => add(s)}
            >
              <Plus size={11} aria-hidden="true" /> {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
function Swatches({ colors, value, onChange, label, t, reset }: { colors: string[]; value?: string; onChange: (c: string | undefined) => void; label: string; t: T; reset?: boolean }) {
  return (
    <div className="wb-rack-field">
      <span>{label}</span>
      <div className="wb-rack-swatches" role="radiogroup" aria-label={label}>
        {reset && (
          <button type="button" role="radio" aria-checked={!value} className={`wb-rack-swatch auto${!value ? " active" : ""}`} onClick={() => onChange(undefined)} title={t("Automatisch", "Automatic")}>
            A
          </button>
        )}
        {colors.map((c) => (
          <button key={c} type="button" role="radio" aria-checked={value === c} aria-label={c} title={c} className={`wb-rack-swatch${value === c ? " active" : ""}`} style={{ background: c }} onClick={() => onChange(c)} />
        ))}
      </div>
    </div>
  );
}
const kindName = (kind: DeviceData["kind"], t: T) => t(...deviceKindNames[kind]);
function Warnings({ list }: { list: string[] }) {
  if (!list.length) return null;
  return (
    <div className="wb-rack-warnings" role="status">
      {list.map((w) => (
        <p key={w}>
          <Warning size={14} weight="fill" aria-hidden="true" /> {w}
        </p>
      ))}
    </div>
  );
}

// ---- the device library ----

type OwnTemplate = { id: string; name: string; device: DeviceData; fill?: string; canDelete: boolean };
export function RackLibrary({ board, onClose, title }: { board: BoardApi; onClose: () => void; title: string }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [own, setOwn] = useState<OwnTemplate[]>([]);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let live = true;
    if (board.guest) return;
    api<{ templates: OwnTemplate[] }>(`/api/whiteboards/${board.pageId}/rack-templates`)
      .then((r) => live && setOwn(r.templates))
      .catch(() => {});
    const reload = () =>
      api<{ templates: OwnTemplate[] }>(`/api/whiteboards/${board.pageId}/rack-templates`)
        .then((r) => live && setOwn(r.templates))
        .catch(() => {});
    window.addEventListener("flowplan-rack-templates", reload);
    return () => {
      live = false;
      window.removeEventListener("flowplan-rack-templates", reload);
    };
  }, [board.pageId]);
  const found = useMemo(() => searchTemplates(query, t), [query, t]);
  const ownFound = own.filter((o) => !query.trim() || `${o.name} ${o.device.model || ""} ${o.device.manufacturer || ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  const after = () => board.dock && onClose();
  const deviceButton = (key: string, name: string, device: DeviceData, fill: string | undefined, extra?: ReactNode) => (
    <div className="wb-rack-lib-item" key={key}>
      <button
        type="button"
        className="wb-rack-lib-device"
        draggable={board.editable}
        disabled={!board.editable}
        onDragStart={(e) => {
          e.dataTransfer.setData(RACK_DRAG_TYPE, JSON.stringify({ device, name, fill }));
          e.dataTransfer.effectAllowed = "copy";
        }}
        onClick={() => {
          placeDevice(board, device, name, t, { fill });
          after();
        }}
        title={t("Klicken: ins ausgewählte Rack an den nächsten freien Platz · Ziehen: an eine Stelle", "Click: into the selected rack at the next free place · Drag: to a spot")}
      >
        <DevicePreview device={device} fill={fill} name={name} t={t} />
        <span className="wb-rack-lib-name">{name}</span>
        <small>
          {device.mount === "left" || device.mount === "right" ? "0U" : `${device.height} U`}
          {device.powerW ? ` · ${formatPower(device.powerW)}` : ""}
          {device.ports.length ? ` · ${device.ports.length} ${t("Ports", "ports")}` : ""}
        </small>
      </button>
      {extra}
    </div>
  );
  const groups = libraryGroups
    .map(([id, name, kinds]) => ({ id, name, list: found.filter((d: DeviceTemplate) => kinds.includes(d.kind)) }))
    .filter((g) => g.list.length);
  const body = (
    <>
      <div className="wb-lib-search">
        <MagnifyingGlass size={16} aria-hidden="true" />
        <input
          type="search"
          autoFocus={!board.dock}
          aria-label={t("Geräte suchen", "Search devices")}
          placeholder={t("Geräte suchen, z. B. Switch, PDU …", "Search devices, e.g. switch, PDU …")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && found[0] && board.editable) {
              e.preventDefault();
              placeDevice(board, templateDevice(found[0]), t(...found[0].name), t);
            }
          }}
        />
      </div>
      <div className="wb-lib-results">
        {!query.trim() && (
          <section aria-label="Racks">
            <h3>Racks</h3>
            <div className="wb-rack-presets">
              {rackPresets.map((u) => (
                <button
                  key={u}
                  type="button"
                  disabled={!board.editable}
                  draggable={board.editable}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(RACK_DRAG_TYPE, JSON.stringify({ rack: u }));
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                  onClick={() => {
                    placeRack(board, u, t);
                    after();
                  }}
                >
                  <HardDrives size={18} aria-hidden="true" />
                  <span>{u === 12 ? t("Wandschrank 12 HE", "Wall cabinet 12U") : `Rack ${u} ${t("HE", "U")}`}</span>
                </button>
              ))}
            </div>
          </section>
        )}
        {groups.map((g) => (
          <section key={g.id} aria-label={t(...g.name)}>
            <h3>{t(...g.name)}</h3>
            <div className="wb-rack-lib-list">{g.list.map((d) => deviceButton(d.key, t(...d.name), templateDevice(d), undefined))}</div>
          </section>
        ))}
        {!!ownFound.length && (
          <section aria-label={t("Eigene Geräte", "Own devices")}>
            <h3>{t("Eigene Geräte", "Own devices")}</h3>
            <div className="wb-rack-lib-list">
              {ownFound.map((o) =>
                deviceButton(
                  o.id,
                  o.name,
                  o.device,
                  o.fill,
                  o.canDelete && board.editable ? (
                    <button
                      type="button"
                      className="wb-rack-lib-delete"
                      aria-label={t(`„${o.name}“ löschen`, `Delete “${o.name}”`)}
                      title={t("Eigenes Gerät löschen", "Delete own device")}
                      onClick={async () => {
                        if (!confirm(t(`Eigenes Gerät „${o.name}“ für alle im Arbeitsbereich löschen?`, `Delete the own device “${o.name}” for everyone in the workspace?`))) return;
                        try {
                          await api(`/api/whiteboards/${board.pageId}/rack-templates`, { action: "delete", templateId: o.id });
                          setOwn((list) => list.filter((x) => x.id !== o.id));
                        } catch (error) {
                          board.onError(serverMessage((error as Error).message));
                        }
                      }}
                    >
                      <Trash size={14} />
                    </button>
                  ) : undefined,
                ),
              )}
            </div>
          </section>
        )}
        {!groups.length && !ownFound.length && <p className="muted">{t("Keine passenden Geräte.", "No matching devices.")}</p>}
      </div>
      <div className="wb-rack-lib-actions">
        <button type="button" className="button" onClick={() => board.open({ kind: "rack-ports" })}>
          <Plugs size={16} aria-hidden="true" /> {t("Ports und Kabel", "Ports & cables")}
        </button>
        {board.editable && !board.guest && (
          <button type="button" className="button" onClick={() => board.open({ kind: "rack-netbox" })}>
            <CloudArrowDown size={16} aria-hidden="true" /> {t("Aus NetBox …", "From NetBox …")}
          </button>
        )}
        {board.editable && (
          <button type="button" className="button" onClick={() => file.current?.click()}>
            <UploadSimple size={16} aria-hidden="true" /> {t("JSON importieren", "Import JSON")}
          </button>
        )}
        <button type="button" className="button" disabled={!board.items.some((i) => i.type === "rack" || i.type === "device")} onClick={() => exportRacksJson(board, title)}>
          <DownloadSimple size={16} aria-hidden="true" /> {t("JSON exportieren", "Export JSON")}
        </button>
        <input
          ref={file}
          type="file"
          hidden
          accept=".json,application/json"
          aria-label={t("Rack-Datei öffnen", "Open rack file")}
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            if (f.size > 10_000_000) return board.onError(t("Die Datei ist zu groß.", "The file is too large."));
            insertRacks(board, await f.text(), t);
            after();
          }}
        />
      </div>
      <p className="wb-lib-note muted">
        {t(
          "Geräte ins Rack ziehen oder anklicken: Sie rasten an ganzen Höheneinheiten ein. Kabel zieht man mit dem Verbindungswerkzeug (L) von Port zu Port.",
          "Drag devices into a rack or click them: they snap to whole rack units. Draw cables with the connector tool (L) from port to port.",
        )}
      </p>
    </>
  );
  if (board.dock)
    return (
      <Modal open onClose={onClose} title={t("Racks und Geräte", "Racks and devices")} sheet className="wb-lib-sheet">
        {body}
      </Modal>
    );
  return (
    <div
      className="wb-library wb-rack-library"
      role="dialog"
      aria-label={t("Racks und Geräte", "Racks and devices")}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="wb-lib-head">
        <strong>{t("Racks und Geräte", "Racks and devices")}</strong>
        <button type="button" aria-label={t("Gerätebibliothek schließen", "Close device library")} onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      {body}
    </div>
  );
}

// ---- details of the selected rack, device, port or cable ----

export function rackSelection(board: BoardApi) {
  if (board.selection.size !== 1) return null;
  const item = board.byId.get([...board.selection][0]);
  return item && (item.type === "rack" || item.type === "device" || isCable(item)) ? item : null;
}
export function RackInspector({ board, sheet, onClose, beside }: { board: BoardApi; sheet?: boolean; onClose?: () => void; beside?: boolean }) {
  const t = useT();
  const item = rackSelection(board);
  const [hiddenFor, setHiddenFor] = useState<string | null>(null);
  useEffect(() => {
    const show = () => setHiddenFor(null);
    window.addEventListener("flowplan-rack-details", show);
    return () => window.removeEventListener("flowplan-rack-details", show);
  }, []);
  if (!item || (!sheet && (board.dock || hiddenFor === item.id))) return null;
  const close = () => (onClose ? onClose() : setHiddenFor(item.id));
  const heading = item.type === "rack" ? "Rack" : item.type === "device" ? t("Gerät", "Device") : t("Kabel", "Cable");
  const body = (
    <div className="wb-rack-form">
      {/* One form per element, so no draft of one element's field reaches another (draft-field.tsx). */}
      {item.type === "rack" ? <RackForm key={item.id} board={board} item={item} t={t} /> : item.type === "device" ? <DeviceForm key={item.id} board={board} item={item} t={t} /> : <CableForm key={item.id} board={board} item={item} t={t} />}
    </div>
  );
  if (sheet)
    return (
      <Modal open onClose={close} title={heading} sheet className="wb-rack-sheet">
        {body}
      </Modal>
    );
  return (
    <aside
      className={`wb-rack-inspector${beside ? " beside" : ""}`}
      aria-label={t(`Details: ${heading}`, `Details: ${heading}`)}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") close();
      }}
    >
      <div className="wb-lib-head">
        <strong>{heading}</strong>
        <button type="button" aria-label={t("Details schließen", "Close details")} onClick={close}>
          <X size={16} />
        </button>
      </div>
      {body}
    </aside>
  );
}
function useSetter(board: BoardApi, item: WhiteboardItem) {
  return (props: Partial<WhiteboardItem>) => board.transact(() => board.setProps(item.id, props));
}
function RackForm({ board, item, t }: { board: BoardApi; item: WhiteboardItem; t: T }) {
  const rack = rackOf(item)!;
  const set = useSetter(board, item);
  const ro = !board.editable || !!item.locked;
  const setRack = (patch: Partial<RackData>) => {
    const next = { ...rack, ...patch };
    for (const key of Object.keys(next) as (keyof RackData)[]) if (next[key] === undefined) delete next[key];
    set({ rack: next });
  };
  const totals = rackTotals(board.items).get(item.id);
  const devices = devicesIn(board.items, item.id).sort((a, b) => (b.u || 0) - (a.u || 0));
  const collisions = rackCollisions(board.items);
  const clashing = devices.filter((d) => collisions.has(d.id)).length;
  const warnings = [
    totals?.overPower ? t(`Stromgrenze überschritten: ${formatPower(totals.powerW)} von ${formatPower(totals.maxPowerW || 0)}`, `Power limit exceeded: ${formatPower(totals.powerW)} of ${formatPower(totals.maxPowerW || 0)}`) : "",
    totals?.overWeight ? t(`Gewichtsgrenze überschritten: ${formatWeight(totals.weightKg)} von ${formatWeight(totals.maxWeightKg || 0)}`, `Weight limit exceeded: ${formatWeight(totals.weightKg)} of ${formatWeight(totals.maxWeightKg || 0)}`) : "",
    clashing ? t(`${clashing} Geräte überschneiden sich oder ragen heraus`, `${clashing} devices overlap or stick out`) : "",
  ].filter(Boolean);
  return (
    <fieldset disabled={ro}>
      <TextField label={t("Name", "Name")} value={item.text} onChange={(text) => set({ text })} max={200} />
      <TextField label={t("Standort", "Location")} value={rack.location} onChange={(location) => setRack({ location: location || undefined })} placeholder={t("z. B. RZ 1 · Reihe B", "e.g. DC 1 · Row B")} />
      <div className="wb-rack-row">
        <NumberField label={t("Höhe", "Height")} suffix={t("HE", "U")} min={1} max={RACK_MAX_U} value={rack.u} onChange={(u) => u && setRack({ u: Math.round(u) })} />
        <label className="wb-rack-field">
          <span>{t("Breite", "Width")}</span>
          <Select value={String(rack.width)} onChange={(e) => setRack({ width: Number(e.target.value) as RackData["width"] })}>
            {rackWidths.map((w) => (
              <option key={w} value={w}>
                {w}″
              </option>
            ))}
          </Select>
        </label>
      </div>
      <div className="wb-rack-field">
        <span>{t("Ansicht", "View")}</span>
        <div className="wb-rack-toggle" role="radiogroup" aria-label={t("Ansicht", "View")}>
          {(["front", "rear"] as const).map((f) => (
            <button key={f} type="button" role="radio" aria-checked={(rack.face || "front") === f} className={(rack.face || "front") === f ? "active" : ""} onClick={() => setRack({ face: f })}>
              {f === "front" ? t("Vorderseite", "Front") : t("Rückseite", "Rear")}
            </button>
          ))}
        </div>
      </div>
      <div className="wb-rack-row">
        <NumberField label={t("Max. Leistung", "Max. power")} suffix="W" value={rack.maxPowerW} onChange={(maxPowerW) => setRack({ maxPowerW: maxPowerW || undefined })} />
        <NumberField label={t("Max. Gewicht", "Max. weight")} suffix="kg" value={rack.maxWeightKg} onChange={(maxWeightKg) => setRack({ maxWeightKg: maxWeightKg || undefined })} />
      </div>
      {totals && (
        <dl className="wb-rack-totals">
          <div>
            <dt>{t("Belegt", "Used")}</dt>
            <dd>
              {totals.units}/{rack.u} {t("HE", "U")}
            </dd>
          </div>
          <div className={totals.overPower ? "over" : ""}>
            <dt>{t("Leistung", "Power")}</dt>
            <dd>{formatPower(totals.powerW)}</dd>
          </div>
          <div className={totals.overWeight ? "over" : ""}>
            <dt>{t("Gewicht", "Weight")}</dt>
            <dd>{formatWeight(totals.weightKg)}</dd>
          </div>
        </dl>
      )}
      <Warnings list={warnings} />
      <div className="wb-rack-field">
        <span>{t("Geräte", "Devices")}</span>
        {devices.length ? (
          <ul className="wb-rack-devices">
            {devices.map((d) => {
              const data = deviceOf(d)!;
              return (
                <li key={d.id}>
                  <button type="button" onClick={() => board.select([d.id])} className={collisions.has(d.id) ? "clash" : ""}>
                    <span className="u">{data.mount === "left" || data.mount === "right" ? "0U" : d.u === undefined ? "" : data.height > 1 ? `${d.u}–${d.u + data.height - 1}` : d.u}</span>
                    <span className="name">{d.text || kindName(data.kind, t)}</span>
                    <small>{kindName(data.kind, t)}</small>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="muted">{t("Noch keine Geräte – aus der Bibliothek hineinziehen.", "No devices yet – drag them in from the library.")}</p>
        )}
      </div>
      {board.editable && (
        <button type="button" className="button" onClick={() => board.open({ kind: "racks" })}>
          <Plus size={14} aria-hidden="true" /> {t("Gerät hinzufügen", "Add device")}
        </button>
      )}
    </fieldset>
  );
}
function DeviceForm({ board, item, t }: { board: BoardApi; item: WhiteboardItem; t: T }) {
  const device = deviceOf(item)!;
  const set = useSetter(board, item);
  const focus = useRackFocus();
  const ro = !board.editable || !!item.locked;
  const setDevice = (patch: Partial<DeviceData>) => {
    // From the shared document: the render state may lag a frame behind
    // quick successive edits of several fields.
    const live = board.live(item.id);
    const next = { ...((live && deviceOf({ ...live, type: "device" })) || device), ...patch };
    for (const key of Object.keys(next) as (keyof DeviceData)[]) if (next[key] === undefined) delete next[key];
    set({ device: next });
  };
  const rack = item.rackId ? board.byId.get(item.rackId) : undefined;
  const rackData = rack ? rackOf(rack) : null;
  const collisions = rackCollisions(board.items);
  const load = sourceLoads(board.items).get(item.id);
  const zero = device.mount === "left" || device.mount === "right";
  const warnings = [
    collisions.has(item.id) ? t("Überschneidet sich mit einem anderen Gerät oder ragt aus dem Rack.", "Overlaps another device or sticks out of the rack.") : "",
    load?.over ? t(`Überlastet: ${formatPower(load.loadW)} von ${formatPower(load.maxPowerW || 0)}`, `Overloaded: ${formatPower(load.loadW)} of ${formatPower(load.maxPowerW || 0)}`) : "",
  ].filter(Boolean);
  const [adding, setAdding] = useState<{ count: number; type: PortType; face: "front" | "rear"; prefix: string }>({ count: 1, type: "rj45", face: "front", prefix: "" });
  const [saving, setSaving] = useState(false);
  return (
    <fieldset disabled={ro}>
      <TextField label={t("Name", "Name")} value={item.text} onChange={(text) => set({ text })} max={200} placeholder={t("z. B. sw-core-01", "e.g. sw-core-01")} />
      <div className="wb-rack-row">
        <label className="wb-rack-field">
          <span>{t("Art", "Kind")}</span>
          <Select value={device.kind} onChange={(e) => setDevice({ kind: e.target.value as DeviceData["kind"] })}>
            {deviceKinds.map((k) => (
              <option key={k} value={k}>
                {kindName(k, t)}
              </option>
            ))}
          </Select>
        </label>
        <NumberField label={t("Höhe", "Height")} suffix={t("HE", "U")} min={1} max={RACK_MAX_U} value={device.height} onChange={(height) => height && setDevice({ height: Math.round(height) })} />
      </div>
      <RoleField roles={device.roles || []} onChange={(roles) => setDevice({ roles })} t={t} />
      <div className="wb-rack-row">
        <TextField label={t("Hostname", "Host name")} value={device.hostname} onChange={(v) => setDevice({ hostname: v || undefined })} max={253} placeholder="srv-01.lan" spellCheck={false} />
        <TextField label={t("MAC-Adresse", "MAC address")} value={device.mac} onChange={(v) => setDevice({ mac: normalizeMac(v) ?? undefined })} max={17} placeholder="aa:bb:cc:dd:ee:ff" validate={macError(t)} spellCheck={false} />
      </div>
      <TextField
        label={t("IP-Adressen", "IP addresses")}
        value={(device.ips || []).join(", ")}
        onChange={(v) => {
          const ips = parseIps(v).ips;
          setDevice({ ips: ips.length ? ips : undefined });
        }}
        max={800}
        placeholder="10.0.0.5/24, 2001:db8::5"
        validate={ipsError(t)}
        spellCheck={false}
      />
      <div className="wb-rack-row">
        <TextField label={t("Hersteller", "Manufacturer")} value={device.manufacturer} onChange={(v) => setDevice({ manufacturer: v || undefined })} max={80} />
        <TextField label={t("Modell", "Model")} value={device.model} onChange={(v) => setDevice({ model: v || undefined })} max={80} />
      </div>
      {rack && rackData && (
        <div className="wb-rack-row">
          <NumberField
            label={t("Position (unterste HE)", "Position (lowest U)")}
            min={1}
            max={rackData.u}
            value={item.u}
            onChange={(u) => u && set({ u: Math.round(u) })}
          />
          <label className="wb-rack-field">
            <span>{t("Einbau", "Mounting")}</span>
            <Select value={device.mount || "rack"} onChange={(e) => setDevice({ mount: e.target.value === "rack" ? undefined : (e.target.value as DeviceData["mount"]) })}>
              <option value="rack">{t("In den Schienen", "In the rails")}</option>
              <option value="left">{t("0 HE links", "0U left")}</option>
              <option value="right">{t("0 HE rechts", "0U right")}</option>
            </Select>
          </label>
        </div>
      )}
      {!zero && (
        <label className="wb-rack-field">
          <span>{t("Tiefe", "Depth")}</span>
          <Select value={device.depth || "full"} onChange={(e) => setDevice({ depth: e.target.value === "full" ? undefined : (e.target.value as DeviceData["depth"]) })}>
            <option value="full">{t("Volle Tiefe", "Full depth")}</option>
            <option value="front">{t("Halbe Tiefe, vorne", "Half depth, front")}</option>
            <option value="rear">{t("Halbe Tiefe, hinten", "Half depth, rear")}</option>
          </Select>
        </label>
      )}
      {rack && (
        <p className="wb-rack-where muted">
          {t("In", "In")} <button type="button" className="link" onClick={() => board.select([rack.id])}>{rack.text || "Rack"}</button>
          {board.editable && (
            <>
              {" · "}
              <button
                type="button"
                className="link"
                onClick={() => set({ rackId: undefined, u: undefined, x: rack.x + rack.w + 40, y: item.y })}
              >
                {t("Aus dem Rack nehmen", "Take out of the rack")}
              </button>
            </>
          )}
        </p>
      )}
      <Swatches label={t("Farbe", "Colour")} colors={DEVICE_SWATCHES} value={item.fill} onChange={(fill) => set({ fill })} t={t} reset />
      <div className="wb-rack-row">
        <NumberField label={t("Leistung", "Power")} suffix="W" value={device.powerW} onChange={(powerW) => setDevice({ powerW })} />
        <NumberField label={t("Gewicht", "Weight")} suffix="kg" step={0.1} value={device.weightKg} onChange={(weightKg) => setDevice({ weightKg })} />
      </div>
      {(device.kind === "pdu" || device.kind === "ups") && (
        <>
          <NumberField label={t("Belastbar bis", "Capacity")} suffix="W" value={device.maxPowerW} onChange={(maxPowerW) => setDevice({ maxPowerW: maxPowerW || undefined })} />
          {load && (
            <p className={`wb-rack-load${load.over ? " over" : ""}`}>
              {t("Last", "Load")}: {formatPower(load.loadW)}
              {load.maxPowerW ? ` / ${formatPower(load.maxPowerW)} (${Math.round((load.loadW / load.maxPowerW) * 100)} %)` : ""}
            </p>
          )}
        </>
      )}
      <Warnings list={warnings} />
      <TextField label={t("Seriennummer", "Serial number")} value={device.serial} onChange={(v) => setDevice({ serial: v || undefined })} max={80} />
      <TextField label={t("Notizen", "Notes")} value={device.notes} onChange={(v) => setDevice({ notes: v || undefined })} max={4000} multiline />
      <PortList board={board} item={item} device={device} setDevice={setDevice} focus={focus?.device === item.id ? focus.port : null} t={t} />
      {board.editable && (
        <details className="wb-rack-add-ports">
          <summary>{t("Ports hinzufügen", "Add ports")}</summary>
          <div className="wb-rack-row">
            <NumberField label={t("Anzahl", "Count")} min={1} max={96} value={adding.count} onChange={(count) => count && setAdding({ ...adding, count: Math.round(count) })} />
            <label className="wb-rack-field">
              <span>{t("Typ", "Type")}</span>
              <Select value={adding.type} onChange={(e) => setAdding({ ...adding, type: e.target.value as PortType })}>
                {portTypes.map((p) => (
                  <option key={p} value={p}>
                    {portTypeNames[p]}
                  </option>
                ))}
              </Select>
            </label>
          </div>
          <div className="wb-rack-row">
            <label className="wb-rack-field">
              <span>{t("Seite", "Side")}</span>
              <Select value={adding.face} onChange={(e) => setAdding({ ...adding, face: e.target.value as "front" | "rear" })}>
                <option value="front">{t("Vorne", "Front")}</option>
                <option value="rear">{t("Hinten", "Rear")}</option>
              </Select>
            </label>
            <TextField label={t("Präfix", "Prefix")} value={adding.prefix} onChange={(prefix) => setAdding({ ...adding, prefix })} max={20} placeholder="Gi1/0/" />
          </div>
          <button
            type="button"
            className="button"
            onClick={() => {
              const start = device.ports.filter((p) => p.name.startsWith(adding.prefix) && /^\d+$/.test(p.name.slice(adding.prefix.length))).length + 1;
              setDevice({ ports: addPorts(device.ports, adding.count, adding.type, adding.face, adding.prefix, start) });
            }}
          >
            <Plus size={14} aria-hidden="true" /> {t(`${adding.count} Ports hinzufügen`, `Add ${adding.count} ports`)}
          </button>
        </details>
      )}
      {board.editable && !board.guest && (
        <button
          type="button"
          className="button"
          disabled={saving}
          onClick={async () => {
            const name = prompt(t("Name des eigenen Geräts in der Bibliothek:", "Name of the own device in the library:"), item.text || kindName(device.kind, t));
            if (!name?.trim()) return;
            setSaving(true);
            try {
              await api(`/api/whiteboards/${board.pageId}/rack-templates`, { action: "save", name: name.trim(), device, ...(item.fill && /^#[0-9a-f]{6}$/i.test(item.fill) ? { fill: item.fill } : {}) });
              window.dispatchEvent(new Event("flowplan-rack-templates"));
              showToast({ text: t("In der Gerätebibliothek gespeichert", "Saved to the device library") });
            } catch (error) {
              board.onError(serverMessage((error as Error).message));
            } finally {
              setSaving(false);
            }
          }}
        >
          <FloppyDisk size={14} aria-hidden="true" /> {t("Als eigenes Gerät speichern", "Save as own device")}
        </button>
      )}
    </fieldset>
  );
}
function PortList({ board, item, device, setDevice, focus, t }: { board: BoardApi; item: WhiteboardItem; device: DeviceData; setDevice: (p: Partial<DeviceData>) => void; focus: string | null; t: T }) {
  const connections = useMemo(() => portConnections(board.items), [board.items]);
  const cables = useMemo(() => new Map(resolveCables(board.items, board.byId).map((c) => [c.item.id, c])), [board.items, board.byId]);
  const [connecting, setConnecting] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focus) return;
    list.current?.querySelector(`[data-port-row="${CSS.escape(focus)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [focus]);
  const setPort = (id: string, patch: Partial<RackPort>) => {
    const live = board.live(item.id);
    const ports = (live && deviceOf({ ...live, type: "device" })?.ports) || device.ports;
    setDevice({
      ports: ports.map((p) => {
        if (p.id !== id) return p;
        const next = { ...p, ...patch };
        for (const key of Object.keys(next) as (keyof RackPort)[]) if (next[key] === undefined || next[key] === "") if (key === "label" || key === "vlan" || key === "mac" || key === "ip") delete next[key];
        // Only network interfaces have a MAC and an IP address.
        if (!nicPort(next.type)) {
          delete next.mac;
          delete next.ip;
        }
        return next;
      }),
    });
  };
  if (!device.ports.length) return <p className="muted">{t("Dieses Gerät hat keine Ports.", "This device has no ports.")}</p>;
  return (
    <div className="wb-rack-field">
      <span>
        {t("Ports", "Ports")} ({device.ports.length})
      </span>
      <div className="wb-rack-ports" ref={list} role="list">
        {device.ports.map((port) => {
          const ids = connections.get(`${item.id}:${port.id}`) || [];
          const cable = ids[0] ? cables.get(ids[0]) : undefined;
          const other = cable ? (cable.a?.device.id === item.id && cable.a.port?.id === port.id ? cable.b : cable.a) : null;
          return (
            <div key={port.id} role="listitem" data-port-row={port.id} className={`wb-rack-port-row${focus === port.id ? " focused" : ""}`} onFocus={() => setRackFocus({ device: item.id, port: port.id })}>
              <div className="wb-rack-port-main">
                <span className={`wb-rack-port-dot ${portCategory(port.type)}`} style={cable ? { background: cableStyle(cable.cable).color } : undefined} aria-hidden="true" />
                <DraftInput aria-label={t("Portname", "Port name")} value={port.name} maxLength={40} onValue={(name) => setPort(port.id, { name: name || port.id })} />
                <Select aria-label={t("Porttyp", "Port type")} value={port.type} onChange={(e) => setPort(port.id, { type: e.target.value as PortType })}>
                  {portTypes.map((p) => (
                    <option key={p} value={p}>
                      {portTypeNames[p]}
                    </option>
                  ))}
                </Select>
                <Select aria-label={t("Seite", "Side")} value={port.face} onChange={(e) => setPort(port.id, { face: e.target.value as "front" | "rear" })}>
                  <option value="front">{t("Vorne", "Front")}</option>
                  <option value="rear">{t("Hinten", "Rear")}</option>
                </Select>
                {board.editable && (
                  <button
                    type="button"
                    className="icon"
                    aria-label={t(`Port ${port.name} entfernen`, `Remove port ${port.name}`)}
                    title={t("Port entfernen", "Remove port")}
                    onClick={() => {
                      board.transact(() => {
                        // Cables on the port keep their device, without the port.
                        for (const id of ids) {
                          const c = board.byId.get(id);
                          if (!c) continue;
                          for (const end of ["from", "to"] as const) {
                            const e = c[end];
                            if (e?.id === item.id && e.port === port.id) board.setProps(id, { [end]: { id: e.id, x: e.x, y: e.y } });
                          }
                        }
                        setDevice({ ports: device.ports.filter((p) => p.id !== port.id) });
                      });
                    }}
                  >
                    <Trash size={13} />
                  </button>
                )}
              </div>
              <div className="wb-rack-port-extra">
                <DraftInput aria-label={t("Bezeichnung", "Label")} placeholder={t("Bezeichnung", "Label")} value={port.label || ""} maxLength={80} onValue={(label) => setPort(port.id, { label })} />
                <DraftInput aria-label="VLAN" placeholder="VLAN" value={port.vlan || ""} maxLength={40} onValue={(vlan) => setPort(port.id, { vlan })} className="vlan" />
              </div>
              {nicPort(port.type) && (
                <div className="wb-rack-port-extra net">
                  <span>
                    <DraftInput
                      aria-label={t(`MAC-Adresse von ${port.name}`, `MAC address of ${port.name}`)}
                      placeholder="MAC"
                      value={port.mac || ""}
                      maxLength={17}
                      spellCheck={false}
                      autoCapitalize="off"
                      validate={macError(t)}
                      onValue={(mac) => setPort(port.id, { mac: normalizeMac(mac) ?? undefined })}
                    />
                  </span>
                  <span>
                    <DraftInput
                      aria-label={t(`IP-Adresse von ${port.name}`, `IP address of ${port.name}`)}
                      placeholder="IP"
                      value={port.ip || ""}
                      maxLength={50}
                      spellCheck={false}
                      autoCapitalize="off"
                      validate={ipError(t)}
                      onValue={(ip) => setPort(port.id, { ip: cleanIp(ip) ?? undefined })}
                    />
                  </span>
                </div>
              )}
              <div className="wb-rack-port-link">
                {cable ? (
                  <>
                    <button type="button" className="link" onClick={() => board.select([cable.item.id])}>
                      → {other ? `${other.device.text || kindName(deviceOf(other.device)!.kind, t)}${other.port ? ` · ${other.port.name}` : ""}` : t("offenes Ende", "loose end")}
                    </button>
                    {ids.length > 1 && <span className="over"> {t(`(${ids.length} Kabel!)`, `(${ids.length} cables!)`)}</span>}
                  </>
                ) : board.editable ? (
                  <button type="button" className="link" onClick={() => setConnecting(connecting === port.id ? null : port.id)}>
                    {t("Verbinden …", "Connect …")}
                  </button>
                ) : (
                  <span className="muted">{t("frei", "free")}</span>
                )}
              </div>
              {connecting === port.id && <ConnectPort board={board} item={item} port={port} onDone={() => setConnecting(null)} t={t} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
// Connecting a port without drawing: choose the other device and port.
function ConnectPort({ board, item, port, onDone, t }: { board: BoardApi; item: WhiteboardItem; port: RackPort; onDone: () => void; t: T }) {
  const devices = devicesIn(board.items).filter((d) => d.id !== item.id);
  const [target, setTarget] = useState(devices[0]?.id || "");
  const connections = portConnections(board.items);
  const targetItem = target ? board.byId.get(target) : undefined;
  const free = targetItem ? deviceOf(targetItem)!.ports.filter((p) => !connections.has(`${target}:${p.id}`)) : [];
  const compatible = free.filter((p) => portCategory(p.type) === portCategory(port.type));
  const choices = compatible.length ? compatible : free;
  const [targetPort, setTargetPort] = useState("");
  const chosen = choices.find((p) => p.id === targetPort) || choices[0];
  if (!devices.length) return <p className="muted">{t("Es gibt kein anderes Gerät auf dem Board.", "There is no other device on the board.")}</p>;
  return (
    <div className="wb-rack-connect">
      <Select aria-label={t("Gerät", "Device")} value={target} onChange={(e) => (setTarget(e.target.value), setTargetPort(""))}>
        {devices.map((d) => (
          <option key={d.id} value={d.id}>
            {d.text || kindName(deviceOf(d)!.kind, t)}
          </option>
        ))}
      </Select>
      <Select aria-label="Port" value={chosen?.id || ""} onChange={(e) => setTargetPort(e.target.value)}>
        {choices.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} · {portTypeNames[p.type]}
          </option>
        ))}
      </Select>
      <button
        type="button"
        className="button primary"
        disabled={!chosen}
        onClick={() => {
          if (!chosen || !targetItem) return;
          const a = portAnchor(item, port.id, board.byId) || { x: item.x, y: item.y },
            b = portAnchor(targetItem, chosen.id, board.byId) || { x: targetItem.x, y: targetItem.y };
          let id = "";
          board.stopCapturing();
          board.transact(() => {
            id = board.add(cableDraft({ device: item.id, port: port.id, at: a }, { device: targetItem.id, port: chosen.id, at: b }, { type: cableTypeFor(port.type, chosen.type) }));
          });
          board.stopCapturing();
          onDone();
          board.select([id]);
        }}
      >
        {t("Verbinden", "Connect")}
      </button>
    </div>
  );
}
function CableForm({ board, item, t }: { board: BoardApi; item: WhiteboardItem; t: T }) {
  const cable: CableData = item.cable || { type: "other" };
  const set = useSetter(board, item);
  const ro = !board.editable || !!item.locked;
  const setCable = (patch: Partial<CableData>) => {
    const next = { ...cable, ...patch };
    for (const key of Object.keys(next) as (keyof CableData)[]) if (next[key] === undefined || next[key] === "") delete next[key];
    set({ cable: next as CableData });
  };
  const resolved = resolveCables([item, ...board.items.filter((i) => i.type === "device")])[0];
  const issues = cableIssues(board.items);
  const doubled = issues.doubled.some((d) => d.ids.includes(item.id));
  const endText = (end: typeof resolved.a) => (end ? `${end.device.text || kindName(deviceOf(end.device)!.kind, t)}${end.port ? ` · ${end.port.name} (${portTypeNames[end.port.type]})` : ""}` : t("offenes Ende", "loose end"));
  return (
    <fieldset disabled={ro}>
      <dl className="wb-rack-ends">
        <div>
          <dt>A</dt>
          <dd>
            {resolved?.a ? (
              <button type="button" className="link" onClick={() => (board.select([resolved.a!.device.id]), resolved.a!.port && setRackFocus({ device: resolved.a!.device.id, port: resolved.a!.port.id }))}>
                {endText(resolved.a)}
              </button>
            ) : (
              endText(null)
            )}
          </dd>
        </div>
        <div>
          <dt>B</dt>
          <dd>
            {resolved?.b ? (
              <button type="button" className="link" onClick={() => (board.select([resolved.b!.device.id]), resolved.b!.port && setRackFocus({ device: resolved.b!.device.id, port: resolved.b!.port.id }))}>
                {endText(resolved.b)}
              </button>
            ) : (
              endText(null)
            )}
          </dd>
        </div>
      </dl>
      <Warnings list={doubled ? [t("Auf einem der Ports steckt noch ein anderes Kabel.", "Another cable is plugged into one of the ports.")] : []} />
      <label className="wb-rack-field">
        <span>{t("Kabeltyp", "Cable type")}</span>
        <Select value={cable.type} onChange={(e) => setCable({ type: e.target.value as CableData["type"] })}>
          {cableTypes.map((c) => (
            <option key={c} value={c}>
              {c === "power" ? t("Strom", "Power") : c === "other" ? t("Sonstiges", "Other") : cableTypeNames[c]}
            </option>
          ))}
        </Select>
      </label>
      <Swatches label={t("Farbe", "Colour")} colors={cableColors} value={cable.color} onChange={(color) => setCable({ color })} t={t} reset />
      <div className="wb-rack-row">
        <TextField label={t("Beschriftung", "Label")} value={cable.label} onChange={(label) => setCable({ label })} max={80} placeholder="K-0001" />
        <NumberField label={t("Länge", "Length")} suffix="m" step={0.1} value={cable.length} onChange={(length) => setCable({ length })} />
      </div>
      <TextField label="VLAN" value={cable.vlan} onChange={(vlan) => setCable({ vlan })} max={40} />
      <TextField label={t("Notizen", "Notes")} value={cable.notes} onChange={(notes) => setCable({ notes })} max={2000} multiline />
    </fieldset>
  );
}

// ---- style bar ----

export function RackStyleControls({ board, selected }: { board: BoardApi; selected: WhiteboardItem[] }) {
  const t = useT();
  const cables = selected.filter(isCable);
  const onlyCables = cables.length > 0 && cables.length === selected.length;
  const racks = selected.filter((i) => i.type === "rack");
  const rackish = selected.length === 1 && (selected[0].type === "rack" || selected[0].type === "device" || onlyCables);
  if (!onlyCables && !racks.length && !rackish) return null;
  const setAll = (list: WhiteboardItem[], fn: (i: WhiteboardItem) => Partial<WhiteboardItem>) => board.transact(() => list.forEach((i) => !i.locked && board.setProps(i.id, fn(i))));
  const face = racks.length ? rackOf(racks[0])!.face || "front" : null;
  return (
    <>
      <span className="wb-sep" />
      {onlyCables && (
        <>
          <Select aria-label={t("Kabeltyp", "Cable type")} title={t("Kabeltyp", "Cable type")} value={cables[0].cable?.type || "other"} onChange={(e) => setAll(cables, (c) => ({ cable: { ...(c.cable || {}), type: e.target.value as CableData["type"] } }))}>
            {cableTypes.map((c) => (
              <option key={c} value={c}>
                {c === "power" ? t("Strom", "Power") : c === "other" ? t("Sonstiges", "Other") : cableTypeNames[c]}
              </option>
            ))}
          </Select>
          {cableColors.slice(0, 8).map((c) => (
            <button key={c} className={`wb-swatch line${cables[0].cable?.color === c ? " active" : ""}`} style={{ borderColor: c }} aria-label={t(`Kabelfarbe ${c}`, `Cable colour ${c}`)} onClick={() => setAll(cables, (i) => ({ cable: { ...(i.cable || { type: "other" }), color: c } }))} />
          ))}
        </>
      )}
      {face && (
        <button
          className="wb-rack-flip"
          aria-label={face === "front" ? t("Rückseite zeigen", "Show the rear") : t("Vorderseite zeigen", "Show the front")}
          title={face === "front" ? t("Rückseite zeigen", "Show the rear") : t("Vorderseite zeigen", "Show the front")}
          onClick={() => setAll(racks, (r) => ({ rack: { ...rackOf(r)!, face: face === "front" ? "rear" : "front" } }))}
        >
          <ArrowsDownUp size={16} style={{ transform: "rotate(90deg)" }} /> {face === "front" ? t("Vorne", "Front") : t("Hinten", "Rear")}
        </button>
      )}
      {rackish && board.dock && (
        <button onClick={() => board.open({ kind: "rack-details" })} aria-label={t("Details", "Details")}>
          {t("Details", "Details")}
        </button>
      )}
    </>
  );
}

// ---- ports and cables of the board ----

type SortKey = keyof Pick<PortRow, "rack" | "device" | "port" | "type" | "connectedTo" | "cable" | "vlan">;
export function PortsAndCables({ board, onClose, title, tab: initial = "ports" }: { board: BoardApi; onClose: () => void; title: string; tab?: "ports" | "cables" }) {
  const t = useT();
  const [tab, setTab] = useState<"ports" | "cables">(initial);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<PortCategory | "">("");
  const [state, setState] = useState<"" | "connected" | "free">("");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "device", desc: false });
  const laid = board.items;
  const ports = useMemo(() => portRows(laid, t), [laid, t]);
  const cables = useMemo(() => cableRows(laid, t), [laid, t]);
  const q = query.trim().toLowerCase();
  const collator = useMemo(() => new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }), []);
  const shownPorts = ports
    .filter((p) => (!category || p.category === category) && (!state || (state === "connected" ? !!p.connectedTo : !p.connectedTo)))
    .filter((p) => !q || [p.rack, p.device, p.port, p.label, p.connectedTo, p.cable, p.vlan, p.ip, p.mac, portTypeNames[p.type]].join(" ").toLowerCase().includes(q))
    .sort((a, b) => (sort.desc ? -1 : 1) * (collator.compare(String(a[sort.key]), String(b[sort.key])) || collator.compare(a.device, b.device) || collator.compare(a.port, b.port)));
  const shownCables = cables
    .filter((c) => !category || (c.type === "power" ? "power" : ["om3", "om4", "om5", "os2", "aoc"].includes(c.type) ? "fibre" : "network") === category)
    .filter((c) => !q || [c.label, c.from, c.to, c.vlan, c.notes, cableTypeNames[c.type]].join(" ").toLowerCase().includes(q));
  const head = (key: SortKey, label: string) => (
    <th aria-sort={sort.key === key ? (sort.desc ? "descending" : "ascending") : "none"}>
      <button type="button" onClick={() => setSort({ key, desc: sort.key === key ? !sort.desc : false })}>
        {label}
        {sort.key === key ? (sort.desc ? " ↓" : " ↑") : ""}
      </button>
    </th>
  );
  const go = (id: string, port?: string) => {
    const item = board.byId.get(id);
    if (!item) return;
    board.select([id]);
    if (port) setRackFocus({ device: id, port });
    board.fit([item]);
    if (board.dock) onClose();
  };
  const csv = () => {
    const text = tab === "ports" ? portsCsv(shownPorts, t) : cablesCsv(shownCables, t);
    saveFile(new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" }), exportFileName(`${title} – ${tab === "ports" ? t("Ports", "Ports") : t("Kabel", "Cables")}`, "csv"));
  };
  return (
    <Modal open onClose={onClose} title={t("Ports und Kabel", "Ports & cables")} wide sheet className="wb-rack-table-dialog">
      <div className="wb-rack-tabs" role="tablist" aria-label={t("Ansicht", "View")}>
        <button type="button" role="tab" aria-selected={tab === "ports"} className={tab === "ports" ? "active" : ""} onClick={() => setTab("ports")}>
          {t("Ports", "Ports")} <small>{ports.length}</small>
        </button>
        <button type="button" role="tab" aria-selected={tab === "cables"} className={tab === "cables" ? "active" : ""} onClick={() => setTab("cables")}>
          {t("Kabel", "Cables")} <small>{cables.length}</small>
        </button>
      </div>
      <div className="wb-rack-filters">
        <div className="wb-lib-search">
          <MagnifyingGlass size={16} aria-hidden="true" />
          <input type="search" aria-label={t("Filtern", "Filter")} placeholder={t("Gerät, Port, VLAN, IP, MAC, Beschriftung …", "Device, port, VLAN, IP, MAC, label …")} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <Select aria-label={t("Kategorie", "Category")} value={category} onChange={(e) => setCategory(e.target.value as PortCategory | "")}>
          <option value="">{t("Alle Kategorien", "All categories")}</option>
          <option value="network">{t("Netzwerk", "Network")}</option>
          <option value="fibre">{t("Glasfaser", "Fibre")}</option>
          <option value="power">{t("Strom", "Power")}</option>
        </Select>
        {tab === "ports" && (
          <Select aria-label={t("Belegung", "Assignment")} value={state} onChange={(e) => setState(e.target.value as "" | "connected" | "free")}>
            <option value="">{t("Alle Ports", "All ports")}</option>
            <option value="connected">{t("Verbunden", "Connected")}</option>
            <option value="free">{t("Frei", "Free")}</option>
          </Select>
        )}
      </div>
      <div className="wb-rack-table-wrap">
        {tab === "ports" ? (
          shownPorts.length ? (
            <table className="wb-rack-table">
              <thead>
                <tr>
                  {head("rack", "Rack")}
                  {head("device", t("Gerät", "Device"))}
                  {head("port", "Port")}
                  {head("type", t("Typ", "Type"))}
                  {head("connectedTo", t("Verbunden mit", "Connected to"))}
                  {head("cable", t("Kabel", "Cable"))}
                  {head("vlan", "VLAN")}
                </tr>
              </thead>
              <tbody>
                {shownPorts.slice(0, 2000).map((p) => (
                  <tr key={`${p.deviceId}:${p.portId}`} tabIndex={0} onClick={() => go(p.deviceId, p.portId)} onKeyDown={(e) => e.key === "Enter" && go(p.deviceId, p.portId)}>
                    <td>{p.rack}</td>
                    <td>{p.device}</td>
                    <td>
                      {p.port}
                      {p.label && <small> · {p.label}</small>}
                      {(p.ip || p.mac) && (
                        <small className="wb-rack-table-net">
                          <bdi dir="ltr">{[p.ip, p.mac].filter(Boolean).join(" · ")}</bdi>
                        </small>
                      )}
                    </td>
                    <td>
                      <span className={`wb-rack-port-dot ${p.category}`} aria-hidden="true" /> {portTypeNames[p.type]}
                      <small> · {p.face === "front" ? t("vorne", "front") : t("hinten", "rear")}</small>
                    </td>
                    <td>{p.connectedTo || <span className="muted">{t("frei", "free")}</span>}</td>
                    <td>{p.cable}</td>
                    <td>{p.vlan}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">{ports.length ? t("Keine passenden Ports.", "No matching ports.") : t("Auf diesem Board gibt es noch keine Geräte mit Ports.", "There are no devices with ports on this board yet.")}</p>
          )
        ) : shownCables.length ? (
          <table className="wb-rack-table">
            <thead>
              <tr>
                <th>{t("Beschriftung", "Label")}</th>
                <th>{t("Typ", "Type")}</th>
                <th>{t("Von", "From")}</th>
                <th>{t("Nach", "To")}</th>
                <th>{t("Länge", "Length")}</th>
                <th>VLAN</th>
              </tr>
            </thead>
            <tbody>
              {shownCables.map((c) => (
                <tr key={c.id} tabIndex={0} onClick={() => go(c.id)} onKeyDown={(e) => e.key === "Enter" && go(c.id)}>
                  <td>
                    <span className="wb-rack-cable-chip" style={{ background: c.color }} aria-hidden="true" /> {c.label || <span className="muted">–</span>}
                  </td>
                  <td>{c.type === "power" ? t("Strom", "Power") : c.type === "other" ? t("Sonstiges", "Other") : cableTypeNames[c.type]}</td>
                  <td>{c.from}</td>
                  <td>{c.to}</td>
                  <td>{c.length !== null ? `${c.length} m` : ""}</td>
                  <td>{c.vlan}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">{cables.length ? t("Keine passenden Kabel.", "No matching cables.") : t("Noch keine Kabel. Mit dem Verbindungswerkzeug (L) von Port zu Port ziehen.", "No cables yet. Draw them with the connector tool (L) from port to port.")}</p>
        )}
      </div>
      <div className="wb-rack-table-actions">
        <button type="button" className="button" onClick={csv} disabled={tab === "ports" ? !shownPorts.length : !shownCables.length}>
          <DownloadSimple size={16} aria-hidden="true" /> {t("Als CSV exportieren", "Export as CSV")}
        </button>
        {tab === "cables" && (
          <button type="button" className="button" disabled={!shownCables.length} onClick={() => printDocument(cableLabelsHtml(shownCables, t, title, document.documentElement.lang || "de"))}>
            <Printer size={16} aria-hidden="true" /> {t("Etiketten drucken", "Print labels")}
          </button>
        )}
      </div>
    </Modal>
  );
}

// ---- NetBox ----

const NETBOX_KEY = (workspace: string) => `flowplan-netbox:${workspace}`;
export function NetboxDialog({ board, onClose }: { board: BoardApi; onClose: () => void }) {
  const workspaceKey = board.pageId;
  const t = useT();
  const saved = (() => {
    try {
      return JSON.parse(localStorage.getItem(NETBOX_KEY(workspaceKey)) || "null") as { url: string; token?: string; site?: string } | null;
    } catch {
      return null;
    }
  })();
  const [url, setUrl] = useState(saved?.url || "");
  const [token, setToken] = useState(saved?.token || "");
  const [site, setSite] = useState(saved?.site || "");
  const [racks, setRacks] = useState("");
  const [remember, setRemember] = useState(!!saved?.token);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal open onClose={onClose} title={t("Racks aus NetBox importieren", "Import racks from NetBox")} sheet>
      <form
        method="post"
        action="/api/auth/no-script"
        className="wb-rack-netbox"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            const data = await api(`/api/whiteboards/${board.pageId}/netbox`, { url, token, ...(site.trim() ? { site: site.trim() } : {}), ...(racks.trim() ? { racks: racks.trim() } : {}) });
            try {
              if (remember) localStorage.setItem(NETBOX_KEY(workspaceKey), JSON.stringify({ url, token, site }));
              else localStorage.removeItem(NETBOX_KEY(workspaceKey));
            } catch {}
            insertRacks(board, data, t);
            onClose();
          } catch (err) {
            setError(serverMessage((err as Error).message));
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="muted">
          {t(
            "Flowplan fragt NetBox einmal ab und legt Racks, Geräte, Schnittstellen, Strom-Ports und Kabel auf dieses Board. Adresse und Token werden nur für diese Abfrage verwendet und auf dem Server nicht gespeichert.",
            "Flowplan queries NetBox once and places racks, devices, interfaces, power ports and cables on this board. The address and token are used for this request only and are not stored on the server.",
          )}
        </p>
        <label>
          {t("NetBox-Adresse", "NetBox address")}
          <input type="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://netbox.example.com" autoComplete="url" />
        </label>
        <label>
          {t("API-Token (nur lesen genügt)", "API token (read-only is enough)")}
          <input type="password" required minLength={8} value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
        </label>
        <div className="wb-rack-row">
          <label>
            {t("Standort (Slug, optional)", "Site (slug, optional)")}
            <input value={site} onChange={(e) => setSite(e.target.value)} placeholder="berlin-dc1" />
          </label>
          <label>
            {t("Racks (Namen, optional)", "Racks (names, optional)")}
            <input value={racks} onChange={(e) => setRacks(e.target.value)} placeholder="R01, R02" />
          </label>
        </div>
        <label className="wb-rack-check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          {t("Adresse und Token in diesem Browser merken", "Remember the address and token in this browser")}
        </label>
        {error && (
          <p className="wb-import-error" role="alert">
            {error}
          </p>
        )}
        <div className="wb-import-actions">
          <button type="button" className="button" onClick={onClose}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button type="submit" className="button primary" disabled={busy}>
            {busy ? t("Wird importiert …", "Importing …") : t("Importieren", "Import")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---- on the board ----

// Classes of board elements: cables, and cables while they are hidden.
export const rackItemClass = (item: WhiteboardItem) => (isCable(item) ? " wb-cable" : "");
// The focused port, ringed on the board.
export function RackWorld({ board }: { board: BoardApi }) {
  const focus = useRackFocus();
  if (!focus) return null;
  const device = board.byId.get(focus.device);
  if (!device || !board.selection.has(device.id)) return null;
  const at = portAnchor(device, focus.port, board.byId);
  if (!at) return null;
  return <circle data-ui className="wb-rack-focus" cx={at.x} cy={at.y} r={7 / Math.max(0.4, board.zoom)} strokeWidth={2 / board.zoom} />;
}
// Arrow keys move devices in their rack by whole units (Alt: height).
export function rackKey(board: BoardApi, e: React.KeyboardEvent, selected: WhiteboardItem[]) {
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return false;
  const devices = selected.filter((i) => i.type === "device" && i.rackId && !i.locked);
  if (!devices.length || devices.length !== selected.length) return false;
  e.preventDefault();
  const step = e.key === "ArrowUp" ? 1 : -1;
  board.transact(() => {
    for (const d of devices) {
      const data = deviceOf(d)!;
      const rack = board.byId.get(d.rackId!);
      const units = rack ? rackOf(rack)!.u : RACK_MAX_U;
      if (e.altKey) {
        const height = Math.max(1, Math.min(units - (d.u || 1) + 1, data.height + step));
        board.setProps(d.id, { device: { ...data, height } });
      } else {
        const u = Math.max(1, Math.min(units - data.height + 1, (d.u || 1) + step * (e.shiftKey ? 5 : 1)));
        board.setProps(d.id, { u });
      }
    }
  });
  return true;
}
