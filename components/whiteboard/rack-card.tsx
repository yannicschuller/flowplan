"use client";
// The "business card" of a device on the board (#187): everything about it
// at a glance – name, kind and roles, how it is reached (host name, IP and
// MAC addresses with copy buttons), model, place in the rack, power, ports
// in use and the start of its notes. The board opens it after a short
// hover with the mouse, a long press with a finger, or I on the keyboard
// for the selected device (components/whiteboard/whiteboard.tsx).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Check, Copy, X } from "@phosphor-icons/react";
import { useT } from "../i18n";
import type { WhiteboardItem } from "@/lib/whiteboard-model";
import { deviceKindNames, deviceName, deviceOf, deviceUnits, formatPower, portConnections, zeroU } from "@/lib/whiteboard-rack";

export type CardState = { id: string; via: "hover" | "touch" | "key" } | null;
const OPEN_DELAY = 550,
  SWITCH_DELAY = 150,
  CLOSE_DELAY = 250,
  PRESS_DELAY = 550,
  PRESS_SLOP = 10;
// When the card opens and closes. `blocked`: not now (a gesture, another
// tool, a menu or dialog, presenting) – checked again when a delay ends.
export function useDeviceCard(blocked: boolean) {
  const [card, setCard] = useState<CardState>(null);
  const state = useRef({ open: 0, close: 0, press: 0, pressAt: null as { x: number; y: number; pointer: number } | null, suppressed: null as string | null, card: null as CardState, blocked });
  useEffect(() => {
    state.current.blocked = blocked;
    if (blocked) setCard((c) => (c && c.via !== "key" ? null : c));
  }, [blocked]);
  useEffect(() => {
    state.current.card = card;
  }, [card]);
  useEffect(() => {
    const s = state.current;
    return () => [s.open, s.close, s.press].forEach((n) => clearTimeout(n));
  }, []);
  const clear = (key: "open" | "close" | "press") => {
    clearTimeout(state.current[key]);
    state.current[key] = 0;
  };
  const show = useCallback((id: string, via: NonNullable<CardState>["via"]) => {
    if (via !== "key" && state.current.blocked) return;
    setCard({ id, via });
  }, []);
  const api = useMemo(
    () => ({
      open: show,
      // Closes the card; the device under the pointer waits until it is left.
      dismiss: (suppress?: string) => {
        clear("open");
        clear("close");
        clear("press");
        state.current.suppressed = suppress ?? state.current.card?.id ?? null;
        setCard(null);
      },
      // The mouse is over this device (or none).
      hover: (id: string | null) => {
        const s = state.current;
        if (id !== s.suppressed) s.suppressed = null;
        if (!id || s.blocked || id === s.suppressed) {
          clear("open");
          if (s.card?.via === "hover" && !s.close) s.close = window.setTimeout(() => ((s.close = 0), setCard((c) => (c?.via === "hover" ? null : c))), CLOSE_DELAY);
          return;
        }
        clear("close");
        if (s.card?.id === id) return clear("open");
        if (s.open) return;
        s.open = window.setTimeout(() => ((s.open = 0), show(id, "hover")), s.card ? SWITCH_DELAY : OPEN_DELAY);
      },
      // The pointer is over the card itself: it stays.
      keep: () => clear("close"),
      leave: () => {
        const s = state.current;
        if (s.card?.via === "hover") s.close = window.setTimeout(() => ((s.close = 0), setCard((c) => (c?.via === "hover" ? null : c))), CLOSE_DELAY);
      },
      // A finger rests on a device: the card after a long press.
      press: (e: { pointerType: string; pointerId: number; clientX: number; clientY: number }, id: string) => {
        if (e.pointerType !== "touch") return;
        clear("press");
        state.current.pressAt = { x: e.clientX, y: e.clientY, pointer: e.pointerId };
        state.current.press = window.setTimeout(() => {
          state.current.press = 0;
          state.current.pressAt = null;
          show(id, "touch");
        }, PRESS_DELAY);
      },
      pressMove: (e: { pointerId: number; clientX: number; clientY: number }) => {
        const at = state.current.pressAt;
        if (at && at.pointer === e.pointerId && Math.hypot(e.clientX - at.x, e.clientY - at.y) > PRESS_SLOP) {
          clear("press");
          state.current.pressAt = null;
        }
      },
      pressEnd: () => {
        clear("press");
        state.current.pressAt = null;
      },
    }),
    [show],
  );
  return { card, ...api };
}

export type ScreenBox = { left: number; top: number; right: number; bottom: number };
const GAP = 10,
  MARGIN = 8;

// Where the card goes: beside the device (the start side first: right, in
// right-to-left languages left), else above or below it, always within
// the window.
export function cardPosition(box: ScreenBox, card: { w: number; h: number }, view: { w: number; h: number }, rtl = false) {
  const room = { right: view.w - box.right - GAP - MARGIN, left: box.left - GAP - MARGIN, below: view.h - box.bottom - GAP - MARGIN, above: box.top - GAP - MARGIN };
  const clampX = (x: number) => Math.max(MARGIN, Math.min(view.w - card.w - MARGIN, x));
  const clampY = (y: number) => Math.max(MARGIN, Math.min(view.h - card.h - MARGIN, y));
  const sides = rtl ? (["left", "right"] as const) : (["right", "left"] as const);
  for (const side of sides)
    if (room[side] >= card.w) return { left: side === "right" ? box.right + GAP : box.left - GAP - card.w, top: clampY(box.top), side };
  if (room.below >= card.h || room.below >= room.above) return { left: clampX(box.left), top: clampY(box.bottom + GAP), side: "below" as const };
  return { left: clampX(box.left), top: clampY(box.top - GAP - card.h), side: "above" as const };
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="wb-device-card-copy"
      aria-label={done ? t("Kopiert", "Copied") : t(`${label} kopieren`, `Copy ${label}`)}
      title={done ? t("Kopiert", "Copied") : t("Kopieren", "Copy")}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {}
      }}
    >
      {done ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
    </button>
  );
}

export function DeviceCard({
  item,
  items,
  box,
  onClose,
  onPointerEnter,
  onPointerLeave,
  focusFirst,
}: {
  item: WhiteboardItem;
  items: WhiteboardItem[];
  box: ScreenBox;
  onClose: (refocus: boolean) => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  // Opened from the keyboard: the focus moves into the card.
  focusFirst?: boolean;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const device = deviceOf(item);
  const key = `${box.left},${box.top},${box.right},${box.bottom}`;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rtl = getComputedStyle(el).direction === "rtl";
    const at = cardPosition(box, { w: el.offsetWidth, h: el.offsetHeight }, { w: window.innerWidth, h: window.innerHeight }, rtl);
    setPlace({ left: at.left, top: at.top });
  }, [key, item]);
  // Once placed (a hidden element takes no focus).
  const placed = !!place;
  useLayoutEffect(() => {
    if (focusFirst && placed) ref.current?.focus({ preventScroll: true });
  }, [focusFirst, placed]);
  if (!device) return null;
  const name = deviceName(item, t);
  const kind = t(...deviceKindNames[device.kind]);
  const units = deviceUnits(item);
  const rack = item.rackId ? items.find((i) => i.id === item.rackId) : undefined;
  const where = units ? (zeroU(device) ? t("0 HE", "0U") : units.from === units.to ? `U${units.from}` : `U${units.from}–${units.to}`) : "";
  const connections = portConnections(items);
  const used = device.ports.filter((p) => connections.has(`${item.id}:${p.id}`)).length;
  const notes = (device.notes || "").replace(/\s+/g, " ").trim();
  const model = [device.manufacturer, device.model].filter(Boolean).join(" ");
  const addresses: { label: string; value: string }[] = [
    ...(device.hostname ? [{ label: t("Hostname", "Host name"), value: device.hostname }] : []),
    ...(device.ips || []).map((ip) => ({ label: "IP", value: ip })),
    ...(device.mac ? [{ label: "MAC", value: device.mac }] : []),
  ];
  const style: CSSProperties = place ? { left: place.left, top: place.top } : { left: box.right + GAP, top: box.top, visibility: "hidden" };
  return (
    <div
      ref={ref}
      className="wb-device-card"
      role="dialog"
      aria-label={t(`Visitenkarte: ${name}`, `Device card: ${name}`)}
      tabIndex={-1}
      style={style}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          onClose(true);
        }
      }}
    >
      <div className="wb-device-card-head">
        <span className="wb-device-card-swatch" style={item.fill ? { background: item.fill } : undefined} aria-hidden="true" />
        <div>
          <strong>{name}</strong>
          <small>
            {kind}
            {rack ? ` · ${rack.text || "Rack"}` : ""}
          </small>
        </div>
        <button type="button" className="wb-device-card-close" aria-label={t("Schließen", "Close")} onClick={() => onClose(true)}>
          <X size={13} aria-hidden="true" />
        </button>
      </div>
      {!!device.roles?.length && (
        <ul className="wb-device-card-roles" aria-label={t("Rollen", "Roles")}>
          {device.roles.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      {!!addresses.length && (
        <dl className="wb-device-card-net">
          {addresses.map((a, i) => (
            <div key={`${a.label}-${i}`}>
              <dt>{a.label}</dt>
              <dd>
                <bdi dir="ltr">{a.value}</bdi>
                <CopyButton value={a.value} label={a.label === "IP" ? t(`IP-Adresse ${a.value}`, `IP address ${a.value}`) : a.label} />
              </dd>
            </div>
          ))}
        </dl>
      )}
      <dl className="wb-device-card-facts">
        {model && (
          <div>
            <dt>{t("Modell", "Model")}</dt>
            <dd>{model}</dd>
          </div>
        )}
        <div>
          <dt>{t("Höhe", "Height")}</dt>
          <dd>
            {zeroU(device) ? t("0 HE", "0U") : `${device.height} ${t("HE", "U")}`}
            {where && !zeroU(device) ? ` · ${where}` : ""}
          </dd>
        </div>
        {!!device.powerW && (
          <div>
            <dt>{t("Leistung", "Power")}</dt>
            <dd>{formatPower(device.powerW)}</dd>
          </div>
        )}
        {!!device.ports.length && (
          <div>
            <dt>{t("Ports", "Ports")}</dt>
            <dd>{t(`${used} von ${device.ports.length} belegt`, `${used} of ${device.ports.length} in use`)}</dd>
          </div>
        )}
      </dl>
      {notes && <p className="wb-device-card-notes">{notes.length > 160 ? `${notes.slice(0, 159)}…` : notes}</p>}
    </div>
  );
}
