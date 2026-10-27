"use client";
// Workshop facilitation on whiteboards: private mode, planning poker, timer
// music and "Alle zu mir holen" (server: lib/whiteboard-facilitation.ts).
// components/whiteboard/whiteboard.tsx calls useFacilitation() and places
// what it returns: entries for the meeting tools, a layer in the drawing,
// banners and panels, buttons for the selection and the timer.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as Y from "yjs";
import { Cards, EyeSlash, Eye, MagnetStraight, SpeakerHigh, SpeakerSlash, X, ArrowUUpLeft, Crosshair } from "@phosphor-icons/react";
import { api } from "../ui";
import { Select } from "../select";
import { useT } from "../i18n";
import { LOCALE_TAG } from "@/lib/locale-tag";
import type { Point, WhiteboardItem, WhiteboardMeta } from "@/lib/whiteboard-model";
import type { RowCard } from "./render";
import {
  clientClocks,
  installPrivateRouting,
  newClientId,
  privateItemIds,
  privateUpdate,
  setPrivateRouting,
} from "@/lib/whiteboard-private-mode";
import { DECKS, deckOf, parseCustomDeck, type DeckKind } from "@/lib/whiteboard-estimation";
import type { FacilitationState, Gather } from "@/lib/whiteboard-facilitation";
import { MUSIC_TRACKS, isMusicTrack, timerMusic, type MusicTrack } from "./timer-music";

type Rect = { x: number; y: number; w: number; h: number };
type View = { x: number; y: number; zoom: number };
// The board's live channel (whiteboard.tsx's event stream) hands signals here.
const signalListeners = new Map<string, Set<(data: { type?: string } & Record<string, unknown>) => void>>();
export function boardSignal(pageId: string, data: { type?: string } & Record<string, unknown>) {
  for (const listener of signalListeners.get(pageId) || []) listener(data);
}
const PRIVATE_REMOTE = "remote";
const to64 = (bytes: Uint8Array) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};
const from64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const center = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const within = (r: Rect, p: Point) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
const estimable = (i: WhiteboardItem) => i.type === "sticky" || (i.type === "card" && !!i.rowId);
const readingOrder = (a: WhiteboardItem, b: WhiteboardItem) => a.y - b.y || a.x - b.x;
// Properties a value can be written into, and the one to suggest first.
type CardField = { id: string; name: string; type: string; options?: string[] };
const ESTIMATE_NAME = /punkt|point|schätz|estimat|aufwand|effort|size|größe|grösse|story/i;

export type FacilitationAction = {
  key: string;
  label: string;
  title: string;
  icon: ReactNode;
  run: () => void;
  active?: boolean;
};
export type FacilitationOptions = {
  pageId: string;
  doc: Y.Doc;
  itemsMap: Y.Map<Y.Map<unknown>>;
  editable: boolean;
  userId: string;
  items: WhiteboardItem[];
  byId: Map<string, WhiteboardItem>;
  selection: ReadonlySet<string>;
  zoom: number;
  rowCards: Map<string, RowCard>;
  visibleRect: () => Rect;
  // Glides the camera there; the board's size in screen pixels.
  moveTo: (view: View) => void;
  viewport: () => { width: number; height: number };
  change: (fn: () => void) => void;
  setProps: (id: string, props: Partial<WhiteboardItem>) => void;
  meta: WhiteboardMeta;
  setMetaValue: (key: keyof WhiteboardMeta, value: unknown) => void;
  timerRunning: boolean;
  onError: (message: string) => void;
};

export function useFacilitation(o: FacilitationOptions) {
  const t = useT();
  const { pageId, doc, itemsMap, editable, userId } = o;
  const url = `/api/whiteboards/${pageId}/facilitation`;
  const [state, setState] = useState<FacilitationState | null>(null);
  const [panel, setPanel] = useState<"private" | "estimate" | null>(null);
  const [said, setSaid] = useState("");
  const [notice, setNotice] = useState<{ id: string; text: string; back?: Rect } | null>(null);
  const opts = useRef(o);
  opts.current = o;
  useMemo(() => installPrivateRouting(doc, itemsMap), [doc, itemsMap]);
  const say = useCallback((text: string) => {
    // A new text each time, so screen readers repeat the same words too.
    setSaid("");
    requestAnimationFrame(() => setSaid(text));
  }, []);

  // ---- state from the server ----
  const seen = useRef<{ gathers: Set<string>; reveals: Set<string>; first: boolean }>({ gathers: new Set(), reveals: new Set(), first: true });
  const jumpTo = useCallback((rect: Rect) => {
    const { width, height } = opts.current.viewport();
    const zoom = Math.max(0.1, Math.min(4, Math.min(width / rect.w, height / rect.h)));
    opts.current.moveTo({ zoom, x: rect.x + rect.w / 2 - width / 2 / zoom, y: rect.y + rect.h / 2 - height / 2 / zoom });
  }, []);
  const gathered = useCallback(
    (g: Gather) => {
      if (seen.current.gathers.has(g.id)) return;
      seen.current.gathers.add(g.id);
      if (g.by === opts.current.userId) return;
      const back = opts.current.visibleRect();
      const frame = g.frame ? opts.current.byId.get(g.frame) : undefined;
      jumpTo(frame ? { x: frame.x - 40, y: frame.y - 60, w: frame.w + 80, h: frame.h + 100 } : g.view);
      const text = t(`${g.name} hat alle hierher geholt`, `${g.name} brought everyone here`);
      setNotice({ id: g.id, text, back });
      say(text);
    },
    [jumpTo, say, t],
  );
  const load = useCallback(async () => {
    try {
      const next = await api<FacilitationState>(url);
      const s = seen.current;
      if (s.first) {
        // Whoever joins later does not jump, and hears no old news.
        s.first = false;
        if (next.gather) s.gathers.add(next.gather.id);
        if (next.revealed) s.reveals.add(next.revealed.id);
      } else {
        if (next.gather) gathered(next.gather);
        if (next.revealed && !s.reveals.has(next.revealed.id)) {
          s.reveals.add(next.revealed.id);
          const text = t(`Aufgedeckt: ${next.revealed.count} Beiträge`, `Revealed: ${next.revealed.count} contributions`);
          setNotice({ id: next.revealed.id, text });
          say(text);
        }
      }
      setState((before) => {
        if (before?.estimation && next.estimation && !before.estimation.revealed && next.estimation.revealed && before.estimation.round === next.estimation.round)
          say(t("Die Karten sind aufgedeckt.", "The cards are revealed."));
        return next;
      });
    } catch {}
  }, [url, gathered, say, t]);
  // The latest of these, for effects that must not restart with them.
  const loadRef = useRef(load);
  loadRef.current = load;
  const gatheredRef = useRef(gathered);
  gatheredRef.current = gathered;
  useEffect(() => {
    const load = () => loadRef.current();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void load();
      }, 150);
    };
    const listener = (data: { type?: string } & Record<string, unknown>) => {
      if (data.type === "gather") gatheredRef.current(data as unknown as Gather);
      else if (data.type === "facilitation") soon();
    };
    let set = signalListeners.get(pageId);
    if (!set) signalListeners.set(pageId, (set = new Set()));
    set.add(listener);
    void load();
    // Without the live channel (proxies), every few seconds.
    const poll = setInterval(() => document.visibilityState === "visible" && void load(), 5000);
    return () => {
      set.delete(listener);
      clearInterval(poll);
      if (timer) clearTimeout(timer);
    };
  }, [pageId]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 12000);
    return () => clearTimeout(timer);
  }, [notice]);
  const post = useCallback(
    async <T,>(body: Record<string, unknown>) => {
      try {
        const result = await api<T>(url, body);
        void loadRef.current();
        return result;
      } catch (e) {
        opts.current.onError((e as Error).message);
        return null;
      }
    },
    [url],
  );

  // ---- private mode ----
  const session = state?.private || null;
  const sessionId = session?.id;
  const frameId = session?.frame || null;
  useEffect(() => {
    if (!sessionId || !editable) {
      setPrivateRouting(doc, { client: null });
      return;
    }
    let alive = true,
      busy = false,
      dirty = false,
      known = -1;
    const client = newClientId(doc);
    const own = new Set<number>([client]);
    const acked = new Map<number, number>();
    const area = () => {
      const frame = frameId ? (itemsMap.get(frameId)?.toJSON() as WhiteboardItem | undefined) : undefined;
      return frame ? { x: frame.x, y: frame.y, w: frame.w, h: frame.h } : null;
    };
    const route = () => setPrivateRouting(doc, { client: alive ? client : null, own: alive ? own : [], area });
    route();
    const onUpdate = (_u: Uint8Array, origin: unknown) => {
      if (origin !== PRIVATE_REMOTE) dirty = true;
    };
    doc.on("update", onUpdate);
    const body = (withUpdate: boolean) => {
      const clocks = clientClocks(doc, own);
      const changed = [...clocks].some(([c, clock]) => clock > (acked.get(c) || 0));
      const update = withUpdate && (dirty || changed) ? privateUpdate(doc, own, acked) : null;
      return { clocks, update, data: { action: "private.sync", session: sessionId, client, known, ...(update ? { update: to64(update) } : {}) } };
    };
    const tick = async (pull: boolean) => {
      if (busy || (!dirty && !pull)) return;
      busy = true;
      const { clocks, update, data } = body(true);
      dirty = false;
      try {
        const result = await api<{ clients: number[]; rev: number; revealed: boolean; state?: string }>(url, data);
        if (update) for (const [c, clock] of clocks) acked.set(c, Math.max(acked.get(c) || 0, clock));
        for (const c of result.clients) own.add(c);
        if (alive) route();
        if (result.state) {
          const bytes = from64(result.state);
          const vector = Y.decodeStateVector(Y.encodeStateVectorFromUpdate(bytes));
          Y.applyUpdate(doc, bytes, PRIVATE_REMOTE);
          for (const [c, clock] of vector) if (own.has(c)) acked.set(c, Math.max(acked.get(c) || 0, clock));
        }
        known = result.rev;
        if (result.revealed) void loadRef.current();
      } catch (e) {
        if (update) dirty = true;
        const message = (e as Error).message;
        if (/vergeben|already taken/i.test(message)) opts.current.onError(message);
      } finally {
        busy = false;
      }
    };
    void tick(true);
    let beats = 0;
    const timer = setInterval(() => void tick(++beats % 4 === 0), 1000);
    // Leaving the page: what is not on the server yet goes along.
    const leave = () => {
      const { update, data } = body(true);
      if (!update) return;
      const text = JSON.stringify(data);
      void fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: text, keepalive: text.length < 60000 }).catch(() => {});
    };
    window.addEventListener("pagehide", leave);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("pagehide", leave);
      doc.off("update", onUpdate);
      setPrivateRouting(doc, { client: null });
      // Private mode ended (or the board closes): the rest goes up – after
      // the reveal the server adds it to the board directly.
      const { update, data } = body(true);
      if (update) void api(url, data).catch(() => {});
    };
  }, [sessionId, frameId, editable, doc, itemsMap, url]);
  const privateIds = session && editable ? privateItemIds(doc, itemsMap) : [];
  const reveal = () => {
    if (!session) return;
    void post<{ count: number }>({ action: "private.reveal", session: session.id }).then((r) => {
      if (r) setPanel(null);
    });
  };

  // ---- planning poker ----
  const estimation = state?.estimation || null;
  const currentKey = estimation?.items[estimation.index];
  const current = currentKey ? o.byId.get(currentKey) : undefined;
  const itemLabel = (item: WhiteboardItem | undefined) =>
    !item
      ? t("Element nicht mehr auf dem Whiteboard", "Element no longer on the whiteboard")
      : item.type === "card"
        ? o.rowCards.get(item.rowId || "")?.title || t("Datensatz", "Record")
        : item.text?.trim() || t("Zettel ohne Text", "Note without text");
  const targets = useMemo(() => {
    const chosen = o.items.filter((i) => o.selection.has(i.id));
    if (chosen.length === 1 && chosen[0].type === "frame") {
      const frame = chosen[0];
      return o.items.filter((i) => estimable(i) && within(frame, center(i))).sort(readingOrder);
    }
    return chosen.filter(estimable).sort(readingOrder);
  }, [o.items, o.selection]);
  const [deckKind, setDeckKind] = useState<DeckKind>("fibonacci");
  const [customDeck, setCustomDeck] = useState("1, 2, 4, 8, 16");
  const startEstimation = () => {
    const deck = deckOf(deckKind, customDeck);
    if (deck.values.length < 2) return o.onError(t("Der Kartensatz braucht mindestens zwei Werte.", "The deck needs at least two values."));
    void post({ action: "estimate.start", items: targets.map((i) => i.id), deck }).then((r) => r && setPanel(null));
  };
  const vote = (value: string) =>
    estimation && void post({ action: "estimate.vote", round: estimation.round, value: estimation.mine === value ? null : value });
  const step = (action: "estimate.reveal" | "estimate.next" | "estimate.revote", index?: number) =>
    estimation && void post({ action, round: estimation.round, ...(index === undefined ? {} : { index }) });
  // Record cards: the database's properties a value fits into.
  const [fields, setFields] = useState<{ db: string; list: CardField[] } | null>(null);
  const [field, setField] = useState("");
  const [choice, setChoice] = useState("");
  const cardDb = current?.type === "card" && current.rowId ? current.pageId || "" : "";
  useEffect(() => {
    if (!cardDb || fields?.db === cardDb) return;
    let alive = true;
    void api<{ database?: { fields: CardField[] } }>(`/api/pages/${cardDb}`)
      .then((data) => {
        if (!alive) return;
        const list = (data.database?.fields || []).slice(1).filter((f) => ["number", "select", "text"].includes(f.type));
        setFields({ db: cardDb, list });
        const best = list.find((f) => ESTIMATE_NAME.test(f.name) && f.type === "number") || list.find((f) => ESTIMATE_NAME.test(f.name)) || list.find((f) => f.type === "number") || list[0];
        setField(best?.id || "");
      })
      .catch(() => alive && setFields({ db: cardDb, list: [] }));
    return () => {
      alive = false;
    };
  }, [cardDb, fields?.db]);
  useEffect(() => {
    setChoice(estimation?.stats?.suggestion || "");
  }, [estimation?.round, estimation?.stats?.suggestion]);
  const applyResult = () => {
    if (!estimation || !current || !choice) return;
    if (current.type === "card") {
      if (!field) return o.onError(t("Diese Datenbank hat keine passende Eigenschaft (Zahl, Auswahl oder Text).", "This database has no suitable property (number, select or text)."));
      void post({ action: "estimate.result", item: current.id, value: choice, record: { pageId: current.pageId, rowId: current.rowId, fieldId: field } }).then(
        (r) => r && say(t(`Übernommen: ${choice}`, `Applied: ${choice}`)),
      );
    } else {
      o.change(() => o.setProps(current.id, { estimate: choice }));
      void post({ action: "estimate.result", item: current.id, value: choice });
      say(t(`Übernommen: ${choice}`, `Applied: ${choice}`));
    }
  };

  // ---- gather everyone ----
  const gather = (frame?: WhiteboardItem) =>
    void post<Gather>({
      action: "gather",
      view: frame ? { x: frame.x - 40, y: frame.y - 60, w: frame.w + 80, h: frame.h + 100 } : o.visibleRect(),
      ...(frame ? { frame: frame.id } : {}),
    }).then((g) => {
      if (!g) return;
      seen.current.gathers.add(g.id);
      if (frame) jumpTo(g.view);
      say(t("Alle sehen jetzt diesen Ausschnitt.", "Everyone now sees this view."));
    });

  // ---- timer music ----
  const track = isMusicTrack(o.meta.music?.track) ? o.meta.music!.track : null;
  const [, rerender] = useState(0);
  useEffect(() => timerMusic().subscribe(() => rerender((n) => n + 1)), []);
  useEffect(() => {
    if (track && o.timerRunning) void timerMusic().play(track);
    else timerMusic().stop();
  }, [track, o.timerRunning]);
  useEffect(() => () => timerMusic().stop(), []);
  const [musicOpen, setMusicOpen] = useState(false);
  const music = timerMusic();
  const settings = music.getSettings();

  // ---- what the board shows ----
  const frameItem = frameId ? o.byId.get(frameId) : undefined;
  const z = o.zoom;
  const world = (
    <g data-ui className="wb-fac-world" pointerEvents="none" aria-hidden="true">
      {session && frameItem && (
        <rect className="wb-private-area" x={frameItem.x - 6 / z} y={frameItem.y - 6 / z} width={frameItem.w + 12 / z} height={frameItem.h + 12 / z} rx={8 / z} strokeWidth={2 / z} strokeDasharray={`${8 / z} ${6 / z}`} />
      )}
      {session && frameItem && session.others > 0 && (() => {
        const shown = Math.min(session.others, 24);
        const size = Math.max(18, Math.min(48, frameItem.w / 16));
        const perRow = Math.max(1, Math.floor((frameItem.w - 24) / (size + 6)));
        return (
          <g className="wb-private-placeholders">
            {Array.from({ length: shown }, (_, i) => (
              <rect key={i} x={frameItem.x + 12 + (i % perRow) * (size + 6)} y={frameItem.y + frameItem.h - 12 - size - Math.floor(i / perRow) * (size + 6)} width={size} height={size} rx={4} />
            ))}
          </g>
        );
      })()}
      {privateIds.map((key) => {
        const item = o.byId.get(key);
        if (!item) return null;
        return (
          <g key={key} className="wb-private-mine">
            <rect x={item.x - 4 / z} y={item.y - 4 / z} width={item.w + 8 / z} height={item.h + 8 / z} rx={6 / z} strokeWidth={1.5 / z} strokeDasharray={`${5 / z} ${4 / z}`} />
            <text x={item.x + 4 / z} y={item.y - 8 / z} fontSize={12 / z}>
              {t("🔒 nur für dich", "🔒 only you")}
            </text>
          </g>
        );
      })}
      {estimation && current && (
        <rect className="wb-estimate-current" x={current.x - 8 / z} y={current.y - 8 / z} width={current.w + 16 / z} height={current.h + 16 / z} rx={10 / z} strokeWidth={3 / z} />
      )}
    </g>
  );
  const frames = o.items.filter((i) => i.type === "frame");
  const deckChoices: [DeckKind, string][] = [
    ["fibonacci", t("Fibonacci (1, 2, 3, 5, 8 …)", "Fibonacci (1, 2, 3, 5, 8 …)")],
    ["tshirt", t("T-Shirt-Größen (XS–XL)", "T-shirt sizes (XS–XL)")],
    ["custom", t("Eigene Werte", "Custom values")],
  ];
  const overlay = (
    <>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {said}
      </div>
      {(session || notice) && (
        <div className="wb-fac-stack" onPointerDown={(e) => e.stopPropagation()}>
          {session && (
            <div className="wb-private-banner" role="status">
              <EyeSlash size={16} weight="bold" aria-hidden="true" />
              <span>
                <strong>{t("Privater Modus", "Private mode")}</strong>
                {frameItem ? ` · ${t("im Rahmen", "in frame")} „${frameItem.text || t("Rahmen", "Frame")}“` : ""}
              </span>
              <span className="wb-private-count">
                {session.others > 0
                  ? t(`${session.others} verdeckte Beiträge von anderen`, `${session.others} hidden contributions from others`)
                  : t("Neue Zettel siehst nur du", "Only you see your new notes")}
              </span>
              {editable && (
                <button type="button" onClick={reveal}>
                  <Eye size={14} aria-hidden="true" /> {t("Aufdecken", "Reveal")}
                </button>
              )}
            </div>
          )}
          {notice && (
            <div className="wb-fac-notice" role="status">
              <span>{notice.text}</span>
              {notice.back && (
                <button
                  type="button"
                  onClick={() => {
                    jumpTo(notice.back!);
                    setNotice(null);
                  }}
                >
                  <ArrowUUpLeft size={14} aria-hidden="true" /> {t("Zurück", "Back")}
                </button>
              )}
              <button type="button" aria-label={t("Hinweis schließen", "Close notice")} onClick={() => setNotice(null)}>
                <X size={12} />
              </button>
            </div>
          )}
        </div>
      )}
      {panel === "private" && editable && (
        <div className="wb-panel" role="dialog" aria-label={t("Privater Modus", "Private mode")} onPointerDown={(e) => e.stopPropagation()}>
          <strong>{t("Privater Modus", "Private mode")}</strong>
          {session ? (
            <>
              <p>
                {t(`Gestartet von ${session.name}. ${session.others} Beiträge der anderen sind verdeckt.`, `Started by ${session.name}. ${session.others} contributions of others are hidden.`)}
              </p>
              <button className="button primary" onClick={reveal}>
                {t("Aufdecken und beenden", "Reveal and end")}
              </button>
            </>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const frame = (e.currentTarget.elements.namedItem("area") as HTMLSelectElement).value;
                void post({ action: "private.start", frame: frame || null }).then((r) => r && setPanel(null));
              }}
            >
              <p>{t("Alle sehen nur ihre eigenen neuen Zettel. Die der anderen bleiben verdeckt, bis jemand aufdeckt.", "Everyone sees only their own new notes. Those of the others stay hidden until someone reveals them.")}</p>
              <label>
                {t("Bereich", "Area")}
                <Select
                  name="area"
                  aria-label={t("Bereich", "Area")}
                  defaultValue={[...o.selection].find((s) => o.byId.get(s)?.type === "frame") || ""}
                >
                  <option value="">{t("Ganzes Whiteboard", "Whole whiteboard")}</option>
                  {frames.map((f) => (
                    <option key={f.id} value={f.id}>
                      {t("Rahmen", "Frame")}: {f.text || t("ohne Titel", "untitled")}
                    </option>
                  ))}
                </Select>
              </label>
              <button className="button primary">{t("Privaten Modus starten", "Start private mode")}</button>
            </form>
          )}
        </div>
      )}
      {panel === "estimate" && editable && (
        <div className="wb-panel" role="dialog" aria-label={t("Schätzen", "Estimate||action")} onPointerDown={(e) => e.stopPropagation()}>
          <strong>{t("Schätzen", "Estimate||action")}</strong>
          <p>
            {targets.length
              ? t(`${targets.length} Elemente werden nacheinander geschätzt.`, `${targets.length} elements are estimated one after another.`)
              : t("Wähle zuerst Zettel, Datensatzkarten oder einen Rahmen aus.", "First select notes, record cards or a frame.")}
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              startEstimation();
            }}
          >
            <label>
              {t("Kartensatz", "Deck")}
              <Select value={deckKind} aria-label={t("Kartensatz", "Deck")} onChange={(e) => setDeckKind(e.target.value as DeckKind)}>
                {deckChoices.map(([kind, label]) => (
                  <option key={kind} value={kind}>
                    {label}
                  </option>
                ))}
              </Select>
            </label>
            {deckKind === "custom" ? (
              <label>
                {t("Werte (durch Kommas getrennt)", "Values (separated by commas)")}
                <input value={customDeck} onChange={(e) => setCustomDeck(e.target.value)} maxLength={200} />
              </label>
            ) : (
              <p className="muted">{DECKS[deckKind].join(" · ")}</p>
            )}
            {deckKind === "custom" && <p className="muted">{parseCustomDeck(customDeck).join(" · ")}</p>}
            <button className="button primary" disabled={!targets.length}>
              {t("Schätzen starten", "Start estimating")}
            </button>
          </form>
        </div>
      )}
      {estimation && (
        <section className="wb-poker" aria-label={t("Schätzen", "Estimate||action")} onPointerDown={(e) => e.stopPropagation()}>
          <header>
            <Cards size={16} aria-hidden="true" />
            <strong>{t("Schätzen", "Estimate||action")}</strong>
            <span className="muted">
              {estimation.index + 1} {t("von", "of")} {estimation.items.length}
            </span>
            {current && (
              <button type="button" aria-label={t("Element zeigen", "Show element")} title={t("Element zeigen", "Show element")} onClick={() => jumpTo({ x: current.x - 120, y: current.y - 120, w: current.w + 240, h: current.h + 240 })}>
                <Crosshair size={14} />
              </button>
            )}
            {editable && (
              <button type="button" aria-label={t("Schätzen beenden", "End estimation")} title={t("Schätzen beenden", "End estimation")} onClick={() => void post({ action: "estimate.end" })}>
                <X size={14} />
              </button>
            )}
          </header>
          <p className="wb-poker-item">{itemLabel(current)}</p>
          {estimation.results[currentKey || ""] && (
            <p className="wb-poker-taken">
              {t("Übernommen:", "Applied:")} <strong>{estimation.results[currentKey || ""]}</strong>
            </p>
          )}
          {!estimation.revealed ? (
            <>
              <div className="wb-poker-deck" role="group" aria-label={t("Deine Karte", "Your card")}>
                {estimation.deck.values.map((value) => (
                  <button key={value} type="button" className="wb-poker-card" aria-pressed={estimation.mine === value} disabled={!editable} onClick={() => vote(value)}>
                    {value}
                  </button>
                ))}
              </div>
              <p className="wb-poker-voters" aria-live="polite">
                {estimation.votes.length
                  ? t(`${estimation.votes.length} haben geschätzt: `, `${estimation.votes.length} have estimated: `) + estimation.votes.map((v) => v.name).join(", ")
                  : t("Noch niemand hat geschätzt.", "Nobody has estimated yet.")}
              </p>
              {editable && (
                <button className="button primary" type="button" disabled={!estimation.votes.length} onClick={() => step("estimate.reveal")}>
                  {t("Karten aufdecken", "Reveal cards")}
                </button>
              )}
            </>
          ) : (
            <>
              {estimation.stats && (
                <>
                  <ul className="wb-poker-bars" aria-label={t("Verteilung", "Distribution")}>
                    {estimation.stats.distribution.map((d) => (
                      <li key={d.value}>
                        <span className="wb-poker-value">{d.value}</span>
                        <span className="wb-poker-bar" style={{ width: `${(d.count / Math.max(1, estimation.stats!.votes)) * 100}%` }} />
                        <span>{d.count}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="wb-poker-summary">
                    {estimation.stats.average !== null && (
                      <span>
                        Ø {estimation.stats.average.toLocaleString(LOCALE_TAG)}
                      </span>
                    )}
                    {estimation.stats.median !== null && (
                      <span>
                        {t("Median", "Median")}{" "}
                        {Number.isFinite(Number(estimation.stats.median)) ? Number(estimation.stats.median).toLocaleString(LOCALE_TAG) : estimation.stats.median}
                      </span>
                    )}
                    {estimation.stats.consensus ? (
                      <span className="wb-poker-consensus">{t("Konsens", "Consensus")}</span>
                    ) : (
                      estimation.stats.counted > 1 && <span>{t("Kein Konsens", "No consensus")}</span>
                    )}
                  </p>
                  <ul className="wb-poker-votes">
                    {estimation.votes.map((v) => (
                      <li key={v.userId}>
                        {v.name} <strong>{v.value}</strong>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {editable && current && (
                <form
                  className="wb-poker-apply"
                  onSubmit={(e) => {
                    e.preventDefault();
                    applyResult();
                  }}
                >
                  <Select value={choice} aria-label={t("Ergebnis", "Result")} onChange={(e) => setChoice(e.target.value)}>
                    <option value="">{t("Wert wählen", "Choose value")}</option>
                    {estimation.deck.values.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </Select>
                  {current.type === "card" && (
                    <Select value={field} aria-label={t("Eigenschaft", "Property")} onChange={(e) => setField(e.target.value)}>
                      {(fields?.list || []).map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}
                        </option>
                      ))}
                    </Select>
                  )}
                  <button className="button primary" disabled={!choice}>
                    {t("Ergebnis übernehmen", "Apply result")}
                  </button>
                </form>
              )}
              {editable && (
                <div className="wb-poker-steps">
                  <button className="button" type="button" onClick={() => step("estimate.revote")}>
                    {t("Neu schätzen", "Estimate again")}
                  </button>
                  {estimation.index < estimation.items.length - 1 ? (
                    <button className="button" type="button" onClick={() => step("estimate.next")}>
                      {t("Nächstes Element", "Next element")}
                    </button>
                  ) : (
                    <button className="button" type="button" onClick={() => void post({ action: "estimate.end" })}>
                      {t("Fertig", "Done")}
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </section>
      )}
    </>
  );
  const actions: FacilitationAction[] = editable
    ? [
        {
          key: "private",
          label: t("Privater Modus", "Private mode"),
          title: t("Privater Modus: alle sammeln verdeckt, dann gemeinsam aufdecken", "Private mode: everyone collects hidden, then reveal together"),
          icon: <EyeSlash size={18} />,
          active: !!session || panel === "private",
          run: () => setPanel((p) => (p === "private" ? null : "private")),
        },
        {
          key: "estimate",
          label: t("Schätzen", "Estimate||action"),
          title: t("Schätzen (Planning Poker) für ausgewählte Zettel, Karten oder einen Rahmen", "Estimate (planning poker) for selected notes, cards or a frame"),
          icon: <Cards size={18} />,
          active: !!estimation || panel === "estimate",
          run: () => setPanel((p) => (p === "estimate" ? null : "estimate")),
        },
        {
          key: "gather",
          label: t("Alle zu mir holen", "Bring everyone here"),
          title: t("Alle zu mir holen: alle springen einmal zu deinem Ausschnitt", "Bring everyone here: everyone jumps to your view once"),
          icon: <MagnetStraight size={18} />,
          run: () => gather(),
        },
      ]
    : [];
  const selected = o.items.filter((i) => o.selection.has(i.id));
  const singleFrame = selected.length === 1 && selected[0].type === "frame" ? selected[0] : null;
  const selectionTools =
    editable && (targets.length > 0 || singleFrame) ? (
      <>
        <span className="wb-sep" />
        {targets.length > 0 && (
          <button type="button" title={t("Schätzen", "Estimate||action")} aria-label={t("Schätzen", "Estimate||action")} onClick={() => setPanel("estimate")}>
            <Cards size={18} />
          </button>
        )}
        {singleFrame && (
          <button type="button" title={t("Alle zu diesem Rahmen holen", "Bring everyone to this frame")} aria-label={t("Alle zu diesem Rahmen holen", "Bring everyone to this frame")} onClick={() => gather(singleFrame)}>
            <MagnetStraight size={18} />
          </button>
        )}
      </>
    ) : null;
  const timerSettings = editable ? (
    <label>
      {t("Musik während des Timers", "Music while the timer runs")}
      <Select value={track || ""} aria-label={t("Musik während des Timers", "Music while the timer runs")} onChange={(e) => o.setMetaValue("music", e.target.value ? { track: e.target.value } : undefined)}>
        <option value="">{t("Keine Musik", "No music")}</option>
        {MUSIC_TRACKS.map(([id, de, en]) => (
          <option key={id} value={id}>
            {t(de, en)}
          </option>
        ))}
      </Select>
    </label>
  ) : null;
  const playing: MusicTrack | null = track && o.timerRunning ? track : null;
  const timerControls = playing ? (
    <span className="wb-music">
      {music.blocked ? (
        <button type="button" className="wb-music-unlock" onClick={() => music.unlock()}>
          <SpeakerHigh size={14} aria-hidden="true" /> {t("Ton an", "Sound on")}
        </button>
      ) : (
        <button
          type="button"
          aria-label={t("Musik: Lautstärke", "Music: volume")}
          title={t("Musik: Lautstärke", "Music: volume")}
          aria-expanded={musicOpen}
          onClick={() => setMusicOpen((v) => !v)}
        >
          {settings.muted ? <SpeakerSlash size={14} /> : <SpeakerHigh size={14} />}
        </button>
      )}
      {musicOpen && !music.blocked && (
        <span className="wb-music-pop" role="group" aria-label={t("Musik", "Music")}>
          <button type="button" aria-pressed={settings.muted} onClick={() => music.setSettings({ ...settings, muted: !settings.muted })}>
            {settings.muted ? t("Ton an", "Sound on") : t("Stumm", "Mute")}
          </button>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(settings.volume * 100)}
            aria-label={t("Lautstärke", "Volume||sound")}
            onChange={(e) => music.setSettings({ volume: Number(e.target.value) / 100, muted: false })}
          />
        </span>
      )}
    </span>
  ) : null;
  return { actions, world, overlay, selectionTools, timerSettings, timerControls };
}
