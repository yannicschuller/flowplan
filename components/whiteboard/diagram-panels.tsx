"use client";
// The diagram features of the board in one place, so the board itself
// (components/whiteboard/whiteboard.tsx) only wires them up:
// - DiagramPanels: shape library, Mermaid/PlantUML import, prototype
//   player and timeline editor,
// - DiagramStyleControls: connector ends, "Automatisch anordnen", click
//   links and the timeline button in the style bar,
// - pasting and dropping diagram texts, "Als Mermaid kopieren".
import { useMemo, useRef, useState } from "react";
import { FlowArrow, PencilSimple, TreeStructure } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { Modal } from "../ui";
import { Select } from "../select";
import { showToast } from "../toast";
import type { WhiteboardItem } from "@/lib/whiteboard-model";
import { markerKinds, type MarkerKind } from "@/lib/whiteboard-diagram-model";
import { connectorEnds, markerProps } from "@/lib/whiteboard-connector-markers";
import { autoLayoutItems, type LayoutDirection } from "@/lib/whiteboard-autolayout";
import {
  DiagramImportError,
  boardToMermaid,
  detectDiagramSource,
  importDiagram,
  parseDiagramText,
  type DiagramSkip,
  type DiagramSource,
} from "@/lib/whiteboard-diagram-import";
import { startFrame } from "@/lib/whiteboard-prototype";
import type { BoardApi, DiagramPanel } from "./board-context";
import { ShapeLibrary } from "./shape-library";
import { PrototypeLinkSelect, PrototypePlayer } from "./prototype-player";
import { TimelineEditor } from "./timeline-item";

type T = (de: string, en: string) => string;
export const DIAGRAM_FILE = /\.(mmd|mermaid|puml|plantuml|pu|iuml|wsd)$/i;

// ---- import ----

export function diagramError(e: unknown, t: T) {
  if (!(e instanceof DiagramImportError)) return (e as Error).message;
  switch (e.code) {
    case "empty":
      return t("Kein Diagramm gefunden – der Text ist leer.", "No diagram found – the text is empty.");
    case "unsupported":
      return t(`„${e.detail}“ lässt sich nicht als bearbeitbares Diagramm übernehmen.`, `“${e.detail}” cannot be imported as an editable diagram.`);
    case "too-large":
      return t(`Der Text ist zu lang (höchstens ${e.detail} Zeichen).`, `The text is too long (at most ${e.detail} characters).`);
    case "too-many":
      return t(`Das Diagramm hat zu viele Elemente (höchstens ${e.detail}).`, `The diagram has too many elements (at most ${e.detail}).`);
    default:
      return t(
        `Unbekannter Diagrammtyp${e.detail ? ` „${e.detail}“` : ""}. Unterstützt werden Mermaid (flowchart, sequenceDiagram, classDiagram, erDiagram, stateDiagram, mindmap) und PlantUML (Aktivitäts-, Sequenz-, Klassen-, Anwendungsfall-, Komponentendiagramme, Mindmaps).`,
        `Unknown diagram type${e.detail ? ` “${e.detail}”` : ""}. Supported are Mermaid (flowchart, sequenceDiagram, classDiagram, erDiagram, stateDiagram, mindmap) and PlantUML (activity, sequence, class, use case, component diagrams, mind maps).`,
      );
  }
}
export function skippedText(skipped: DiagramSkip[], t: T) {
  const list = skipped
    .slice(0, 6)
    .map((s) => t(`Zeile ${s.line}: ${s.text.slice(0, 60)}`, `Line ${s.line}: ${s.text.slice(0, 60)}`))
    .join(" · ");
  return skipped.length > 6 ? `${list} · ${t(`und ${skipped.length - 6} weitere`, `and ${skipped.length - 6} more`)}` : list;
}
const skippedCount = (n: number, t: T) => (n === 1 ? t("1 Zeile übersprungen", "1 line skipped") : t(`${n} Zeilen übersprungen`, `${n} lines skipped`));
// Puts a diagram text on the board; throws what the parser found wrong.
export function insertDiagram(board: BoardApi, text: string, t: T, source?: DiagramSource | null, at?: { x: number; y: number }) {
  const result = importDiagram(text, source);
  board.stopCapturing();
  const placed = board.insertDrafts(result.drafts, at);
  board.stopCapturing();
  if (!at) board.fit(placed);
  const shapes = placed.filter((i) => i.type !== "connector" && i.type !== "frame").length;
  showToast({
    text: t(`Diagramm übernommen: ${shapes} Elemente`, `Diagram imported: ${shapes} elements`),
    ...(result.skipped.length
      ? { detail: `${skippedCount(result.skipped.length, t)} – ${skippedText(result.skipped, t)}`, duration: 9000 }
      : {}),
  });
  return placed;
}
// Pasted text that is a Mermaid or PlantUML diagram becomes one; when it
// cannot be read the import dialog opens with it. False for other text.
export function pasteDiagram(board: BoardApi, text: string, t: T) {
  const source = detectDiagramSource(text);
  if (!source) return false;
  try {
    insertDiagram(board, text, t, source);
  } catch (e) {
    board.open({ kind: "import", text, source, error: diagramError(e, t) });
  }
  return true;
}
// A dropped .mmd / .puml file.
export async function dropDiagramFile(board: BoardApi, file: File, t: T, at?: { x: number; y: number }) {
  if (file.size > 200_000) return board.onError(t("Die Datei ist zu groß.", "The file is too large."));
  const text = await file.text();
  const source: DiagramSource | null = /\.(mmd|mermaid)$/i.test(file.name) ? "mermaid" : /\.(puml|plantuml|pu|iuml|wsd)$/i.test(file.name) ? "plantuml" : detectDiagramSource(text);
  try {
    insertDiagram(board, text, t, source, at);
  } catch (e) {
    board.open({ kind: "import", text, source: source || undefined, error: diagramError(e, t) });
  }
}
export async function copyMermaid(board: BoardApi, t: T) {
  const text = boardToMermaid(board.items, new Set(board.selection));
  if (!text) return board.onError(t("Keine Formen zum Kopieren.", "No shapes to copy."));
  try {
    await navigator.clipboard.writeText(text);
    showToast({ text: t("Als Mermaid kopiert", "Copied as Mermaid") });
  } catch {
    board.open({ kind: "import", text, source: "mermaid" });
  }
}

const EXAMPLES: Record<string, [DiagramSource, string]> = {
  flowchart: ["mermaid", "flowchart TD\n  A([Start]) --> B[Antrag prüfen]\n  B --> C{Vollständig?}\n  C -->|Ja| D[Freigeben]\n  C -->|Nein| E[Nachfragen]\n  E --> B\n  D --> F([Ende])"],
  sequence: ["mermaid", "sequenceDiagram\n  actor K as Kunde\n  participant S as Shop\n  K->>S: Bestellung\n  S-->>K: Bestätigung"],
  class: ["mermaid", "classDiagram\n  Tier <|-- Hund\n  Tier : +String name\n  Tier : +fressen()\n  Hund : +bellen()"],
  er: ["mermaid", "erDiagram\n  KUNDE ||--o{ BESTELLUNG : gibt\n  BESTELLUNG ||--|{ POSITION : enthält"],
  activity: ["plantuml", "@startuml\nstart\n:Antrag lesen;\nif (vollständig?) then (ja)\n  :freigeben;\nelse (nein)\n  :nachfragen;\nendif\nstop\n@enduml"],
};

function ImportDialog({ board, panel, onClose }: { board: BoardApi; panel: Extract<DiagramPanel, { kind: "import" }>; onClose: () => void }) {
  const t = useT();
  const [text, setText] = useState(panel.text || "");
  const [source, setSource] = useState<DiagramSource | "">(panel.source || "");
  const [error, setError] = useState(panel.error || "");
  const file = useRef<HTMLInputElement>(null);
  // What the text is, before importing.
  const preview = useMemo(() => {
    if (!text.trim()) return null;
    try {
      const parsed = parseDiagramText(text, source || null);
      const d = parsed.diagram;
      const count = d.kind === "sequence" ? d.participants.length : d.nodes.length;
      return { ok: true as const, source: parsed.source, kind: d.kind, count, skipped: parsed.skipped };
    } catch (e) {
      return { ok: false as const, message: diagramError(e, t) };
    }
  }, [text, source, t]);
  const kinds: Record<string, string> = {
    flowchart: t("Flussdiagramm", "Flowchart"),
    sequence: t("Sequenzdiagramm", "Sequence diagram"),
    class: t("Klassendiagramm", "Class diagram"),
    er: t("ER-Diagramm", "ER diagram"),
    state: t("Zustandsdiagramm", "State diagram"),
    mindmap: t("Mindmap", "Mind map"),
    activity: t("Aktivitätsdiagramm", "Activity diagram"),
    usecase: t("Anwendungsfalldiagramm", "Use case diagram"),
    component: t("Komponentendiagramm", "Component diagram"),
  };
  const run = () => {
    try {
      insertDiagram(board, text, t, source || null);
      onClose();
    } catch (e) {
      setError(diagramError(e, t));
    }
  };
  return (
    <Modal open onClose={onClose} title={t("Diagramm importieren", "Import diagram")} wide sheet>
      <div className="wb-import-diagram">
        <p className="muted">
          {t(
            "Mermaid- oder PlantUML-Text einfügen – er wird zu bearbeitbaren Formen und Verbindungslinien, automatisch angeordnet. Alles bleibt auf diesem Gerät und Server; es wird kein PlantUML-Server benutzt.",
            "Paste Mermaid or PlantUML text – it becomes editable shapes and connectors, laid out automatically. Everything stays on this device and server; no PlantUML server is used.",
          )}
        </p>
        <div className="wb-import-row">
          <label>
            {t("Format", "Format")}
            <Select value={source} onChange={(e) => setSource(e.target.value as DiagramSource | "")}>
              <option value="">{t("Automatisch erkennen", "Detect automatically")}</option>
              <option value="mermaid">Mermaid</option>
              <option value="plantuml">PlantUML</option>
            </Select>
          </label>
          <label>
            {t("Beispiel", "Example")}
            <Select
              value=""
              onChange={(e) => {
                const example = EXAMPLES[e.target.value];
                if (!example) return;
                setSource(example[0]);
                setText(example[1]);
                setError("");
              }}
            >
              <option value="">{t("Beispiel einfügen …", "Insert example …")}</option>
              <option value="flowchart">{kinds.flowchart} (Mermaid)</option>
              <option value="sequence">{kinds.sequence} (Mermaid)</option>
              <option value="class">{kinds.class} (Mermaid)</option>
              <option value="er">{kinds.er} (Mermaid)</option>
              <option value="activity">{kinds.activity} (PlantUML)</option>
            </Select>
          </label>
          <button type="button" className="button" onClick={() => file.current?.click()}>
            {t("Datei öffnen …", "Open file …")}
          </button>
          <input
            ref={file}
            type="file"
            hidden
            accept=".mmd,.mermaid,.puml,.plantuml,.pu,.iuml,.wsd,.txt,.md"
            aria-label={t("Diagrammdatei öffnen", "Open diagram file")}
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              if (f.size > 200_000) return setError(t("Die Datei ist zu groß.", "The file is too large."));
              setText(await f.text());
              if (/\.(mmd|mermaid)$/i.test(f.name)) setSource("mermaid");
              else if (/\.(puml|plantuml|pu|iuml|wsd)$/i.test(f.name)) setSource("plantuml");
              setError("");
            }}
          />
        </div>
        <textarea
          className="wb-import-text"
          aria-label={t("Diagrammtext", "Diagram text")}
          spellCheck={false}
          placeholder={"flowchart TD\n  A[Start] --> B{?}\n  B -->|Ja| C[OK]"}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError("");
          }}
        />
        <div className="wb-import-status" role="status" aria-live="polite">
          {error ? (
            <span className="wb-import-error">{error}</span>
          ) : preview?.ok ? (
            <>
              <span>
                {t("Erkannt", "Detected")}: {preview.source === "mermaid" ? "Mermaid" : "PlantUML"} · {kinds[preview.kind]} · {t(`${preview.count} Elemente`, `${preview.count} elements`)}
              </span>
              {!!preview.skipped.length && (
                <span className="wb-import-skipped">
                  {preview.skipped.length === 1 ? t("1 Zeile wird übersprungen", "1 line will be skipped") : t(`${preview.skipped.length} Zeilen werden übersprungen`, `${preview.skipped.length} lines will be skipped`)}: {skippedText(preview.skipped, t)}
                </span>
              )}
            </>
          ) : preview ? (
            <span className="wb-import-error">{preview.message}</span>
          ) : null}
        </div>
        <div className="wb-import-actions">
          <button type="button" className="button" onClick={onClose}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button type="button" className="button primary" disabled={!text.trim() || (preview !== null && !preview.ok)} onClick={run}>
            {t("Importieren", "Import")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---- the panels ----

export function DiagramPanels({ board, panel }: { board: BoardApi; panel: DiagramPanel | null }) {
  if (!panel) return null;
  if (panel.kind === "library") return <ShapeLibrary board={board} onClose={board.close} />;
  if (panel.kind === "import") return <ImportDialog key={panel.text || ""} board={board} panel={panel} onClose={board.close} />;
  if (panel.kind === "timeline") return <TimelineEditor id={panel.id} onClose={board.close} />;
  return <PrototypePlayer items={board.items} pages={board.pages} start={panel.start ?? startFrame(board.items, board.selection)} onClose={board.close} />;
}

// ---- style bar ----

// i18n-table: 1 – [German, English] names of connector ends
const markerNames: Record<MarkerKind, [string, string]> = {
  none: ["Ohne", "None"],
  arrow: ["Pfeil", "Arrow"],
  open: ["Offener Pfeil", "Open arrow"],
  triangle: ["Dreieck (Vererbung)", "Triangle (inheritance)"],
  diamond: ["Raute (Aggregation)", "Diamond (aggregation)"],
  filledDiamond: ["Gefüllte Raute (Komposition)", "Filled diamond (composition)"],
  circle: ["Kreis", "Circle"],
  dot: ["Punkt", "Dot"],
  cross: ["Kreuz", "Cross"],
  one: ["Eins", "One"],
  onlyOne: ["Genau eins", "Exactly one"],
  zeroOrOne: ["Null oder eins", "Zero or one"],
  many: ["Viele", "Many"],
  oneOrMany: ["Eins oder viele", "One or many"],
  zeroOrMany: ["Null oder viele", "Zero or many"],
};
// The menu goes away: the keyboard (undo, Esc) stays with the board.
const refocus = (e: { currentTarget: Element }) => (e.currentTarget.closest(".whiteboard") as HTMLElement | null)?.focus({ preventScroll: true });
export function runAutoLayout(board: BoardApi, direction: LayoutDirection, t: T) {
  const positions = autoLayoutItems(board.items, new Set(board.selection), direction);
  if (!positions) return board.onError(t("Zum Anordnen Formen auswählen, die mit Verbindungslinien verbunden sind.", "To arrange, select shapes that are joined by connectors."));
  board.stopCapturing();
  board.transact(() => positions.forEach((p) => board.setProps(p.id, { x: p.x, y: p.y })));
  board.stopCapturing();
}

export function DiagramStyleControls({ board, selected }: { board: BoardApi; selected: WhiteboardItem[] }) {
  const t = useT();
  const [layoutOpen, setLayoutOpen] = useState(false);
  const set = (props: Partial<WhiteboardItem>, list = selected) => board.transact(() => list.forEach((i) => !i.locked && board.setProps(i.id, props)));
  const connectors = selected.filter((i) => i.type === "connector");
  const onlyConnectors = connectors.length > 0 && connectors.length === selected.length;
  const linkable = selected.filter((i) => !["frame", "connector", "comment", "pen"].includes(i.type));
  const layoutable = selected.filter((i) => ["sticky", "text", "shape", "card", "image", "emoji", "table"].includes(i.type));
  const ids = new Set(layoutable.map((i) => i.id));
  const canLayout = layoutable.length >= 2 && board.items.some((c) => c.type === "connector" && c.from?.id && c.to?.id && ids.has(c.from.id) && ids.has(c.to.id));
  const timeline = selected.length === 1 && selected[0].type === "timeline" ? selected[0] : null;
  const first = connectors[0];
  const ends = first ? connectorEnds(first) : null;
  return (
    <>
      {onlyConnectors && ends && (
        <>
          <span className="wb-sep" />
          <Select aria-label={t("Linienanfang", "Line start")} title={t("Linienanfang", "Line start")} value={ends.start} onChange={(e) => set(markerProps("start", e.target.value as MarkerKind), connectors)}>
            {markerKinds.map((k) => (
              <option key={k} value={k}>
                {t("Anfang", "Start||line")}: {t(...markerNames[k])}
              </option>
            ))}
          </Select>
          <Select aria-label={t("Linienende", "Line end")} title={t("Linienende", "Line end")} value={ends.end} onChange={(e) => set(markerProps("end", e.target.value as MarkerKind), connectors)}>
            {markerKinds.map((k) => (
              <option key={k} value={k}>
                {t("Ende", "End||line")}: {t(...markerNames[k])}
              </option>
            ))}
          </Select>
        </>
      )}
      {canLayout && (
        <>
          <span className="wb-sep" />
          <span className="wb-arrange">
            <button aria-label={t("Automatisch anordnen", "Arrange automatically")} aria-expanded={layoutOpen} title={t("Diagramm automatisch anordnen", "Arrange the diagram automatically")} onClick={() => setLayoutOpen(!layoutOpen)}>
              <TreeStructure size={16} /> {t("Automatisch anordnen", "Arrange automatically")}
            </button>
            {layoutOpen && (
              <span className="wb-arrange-menu" role="menu">
                <button role="menuitem" onClick={(e) => (refocus(e), setLayoutOpen(false), runAutoLayout(board, "TB", t))}>
                  {t("Von oben nach unten", "Top to bottom")}
                </button>
                <button role="menuitem" onClick={(e) => (refocus(e), setLayoutOpen(false), runAutoLayout(board, "LR", t))}>
                  {t("Von links nach rechts", "Left to right")}
                </button>
              </span>
            )}
          </span>
        </>
      )}
      {linkable.length > 0 && linkable.length === selected.length && board.items.some((i) => i.type === "frame") && (
        <>
          <span className="wb-sep" />
          <span className="wb-link-select">
            <FlowArrow size={16} aria-hidden="true" />
            <PrototypeLinkSelect items={board.items} selected={linkable} onChange={(link) => set({ link }, linkable)} />
          </span>
        </>
      )}
      {timeline && (
        <>
          <span className="wb-sep" />
          <button onClick={() => board.open({ kind: "timeline", id: timeline.id })} title={t("Zeitleiste bearbeiten", "Edit timeline")}>
            <PencilSimple size={16} /> {t("Zeitleiste bearbeiten", "Edit timeline")}
          </button>
        </>
      )}
    </>
  );
}
