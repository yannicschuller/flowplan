"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight,
  ArrowsClockwise,
  Bell,
  CalendarBlank,
  ChartBar,
  ChartBarHorizontal,
  ChatCircle,
  CheckSquare,
  ClipboardText,
  Desktop,
  FileText,
  Kanban,
  Link as LinkIcon,
  List,
  LockSimple,
  Notebook,
  PresentationChart,
  Rows,
  SquaresFour,
  Table,
  Timer,
} from "@phosphor-icons/react";
import { BrandMark } from "../brand-mark";
import s from "./landing.module.css";

type Props = {
  loginHref: string;
  registerHref: string;
  instanceName?: string;
};

const TYPES = [
  { key: "doc", label: "Dokumente", icon: FileText, page: "Projekt-Kickoff" },
  { key: "db", label: "Datenbanken", icon: Table, page: "Website-Relaunch" },
  {
    key: "board",
    label: "Whiteboards",
    icon: PresentationChart,
    page: "Workshop Q4",
  },
  { key: "journal", label: "Journal", icon: Notebook, page: "Mein Journal" },
] as const;

/* ---------- Motion helpers ---------- */

// Runs while the element is on screen; loops stop off screen.
function useInView<T extends Element>(margin = "0px") {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => setInView(entry.isIntersecting),
      { rootMargin: margin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [margin]);
  return [ref, inView] as const;
}
// A counter that advances every `ms` while `run` is true.
function useCycle(length: number, ms: number, run: boolean) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!run) return;
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (reduced) return;
    const timer = setInterval(() => setIndex((i) => (i + 1) % length), ms);
    return () => clearInterval(timer);
  }, [length, ms, run]);
  return [index, setIndex] as const;
}
// Restarts a CSS choreography by remounting it every `ms`.
function useReplay(ms: number, run: boolean) {
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!run) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = setInterval(() => setRound((r) => r + 1), ms);
    return () => clearInterval(timer);
  }, [ms, run]);
  return round;
}

/* ---------- Scenes ---------- */

function DocScene({ run }: { run: boolean }) {
  const round = useReplay(11000, run);
  return (
    <div className={s.doc} key={round} data-run={run}>
      <div className={s.docTitle}>Projekt-Kickoff</div>
      <div className={s.docMeta}>
        <span className={s.avatar} style={{ background: "#f0663a" }}>
          M
        </span>
        Mara · heute bearbeitet
      </div>
      <p className={`${s.docLine} ${s.typing}`}>
        Ziel: die neue Website bis 30. Oktober live.
      </p>
      <div className={s.slash}>
        <span className={s.slashInput}>/auf</span>
        <ul>
          <li className={s.slashActive}>
            <CheckSquare size={14} /> Aufgabenliste
          </li>
          <li>
            <Table size={14} /> Tabelle
          </li>
          <li>
            <ChartBar size={14} /> Diagramm
          </li>
        </ul>
      </div>
      <ul className={s.docTasks}>
        <li className={s.taskDone}>
          <span className={s.check} />
          Texte finalisieren
        </li>
        <li>
          <span className={s.check} />
          Bilder auswählen
        </li>
      </ul>
      <div className={s.docCols}>
        <div className={s.callout}>
          <strong>Entscheidung</strong>
          Wir starten mit Deutsch und Englisch.
        </div>
        <div className={s.formula}>
          <span>Budget</span>
          12 × 2.400 € = <b>28.800 €</b>
        </div>
      </div>
    </div>
  );
}

const RECORDS = [
  { t: "Startseite gestalten", st: 1, day: 1, start: 0, len: 3 },
  { t: "Texte schreiben", st: 0, day: 3, start: 2, len: 3 },
  { t: "Bilder auswählen", st: 2, day: 0, start: 0, len: 2 },
  { t: "Übersetzungen", st: 0, day: 4, start: 4, len: 3 },
  { t: "Launch planen", st: 1, day: 2, start: 3, len: 4 },
  { t: "Feedback sammeln", st: 2, day: 4, start: 6, len: 2 },
];
const STATUS = ["Offen", "In Arbeit", "Erledigt"];
const LAYOUTS = [
  { key: "table", label: "Tabelle", icon: Table },
  { key: "board", label: "Board", icon: Kanban },
  { key: "calendar", label: "Kalender", icon: CalendarBlank },
  { key: "timeline", label: "Zeitleiste", icon: ChartBarHorizontal },
] as const;
type Layout = (typeof LAYOUTS)[number]["key"];
// Where each record sits in each view: left/width in %, top/height in px.
function place(layout: Layout, i: number) {
  const r = RECORDS[i];
  if (layout === "table")
    return { left: 0, width: 100, top: 34 + i * 38, height: 32 };
  if (layout === "board") {
    const idx = RECORDS.slice(0, i).filter((x) => x.st === r.st).length;
    return { left: r.st * 34, width: 32, top: 34 + idx * 58, height: 50 };
  }
  if (layout === "calendar") {
    const idx = RECORDS.slice(0, i).filter((x) => x.day === r.day).length;
    return { left: r.day * 20 + 0.5, width: 19, top: 58 + idx * 34, height: 28 };
  }
  return { left: r.start * 12.5, width: r.len * 12.5 - 1, top: 34 + i * 38, height: 28 };
}
function DbScene({ run }: { run: boolean }) {
  const [index, setIndex] = useCycle(LAYOUTS.length, 2600, run);
  const layout = LAYOUTS[index].key;
  return (
    <div className={s.db} data-layout={layout}>
      <div className={s.dbTabs} role="tablist" aria-label="Ansicht">
        {LAYOUTS.map((l, i) => (
          <button
            key={l.key}
            type="button"
            role="tab"
            aria-selected={i === index}
            className={i === index ? s.dbTabActive : undefined}
            onClick={() => setIndex(i)}
          >
            <l.icon size={14} />
            {l.label}
          </button>
        ))}
      </div>
      <div className={s.dbStage}>
        <div className={s.dbHeads} data-for="table">
          <span>Aufgabe</span>
          <span>Status</span>
          <span>Fällig</span>
        </div>
        <div className={s.dbHeads} data-for="board">
          {STATUS.map((st, i) => (
            <span key={st} data-status={i}>
              {st}
            </span>
          ))}
        </div>
        <div className={s.dbHeads} data-for="calendar">
          {["Mo 12", "Di 13", "Mi 14", "Do 15", "Fr 16"].map((d) => (
            <span key={d}>{d}</span>
          ))}
        </div>
        <div className={s.dbHeads} data-for="timeline">
          {["KW 42", "KW 43", "KW 44", "KW 45"].map((d) => (
            <span key={d}>{d}</span>
          ))}
        </div>
        {RECORDS.map((r, i) => {
          const p = place(layout, i);
          return (
            <div
              key={r.t}
              className={s.record}
              data-status={r.st}
              style={{
                left: `${p.left}%`,
                width: `${p.width}%`,
                top: p.top,
                height: p.height,
                transitionDelay: `${i * 35}ms`,
              }}
            >
              <span className={s.recordTitle}>{r.t}</span>
              <span className={s.recordStatus}>{STATUS[r.st]}</span>
              <span className={s.recordDate}>{12 + r.day}. Okt.</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BoardScene({ run }: { run: boolean }) {
  const round = useReplay(9000, run);
  const [seconds, setSeconds] = useState(300);
  useEffect(() => {
    if (!run) return;
    setSeconds(300);
    const t = setInterval(() => setSeconds((v) => (v > 0 ? v - 1 : 300)), 1000);
    return () => clearInterval(t);
  }, [run, round]);
  return (
    <div className={s.wb} key={round} data-run={run}>
      <div className={s.wbGrid} />
      <svg className={s.wbLinks} viewBox="0 0 400 260" aria-hidden="true">
        <path d="M118 78 C 170 78, 170 150, 222 150" />
        <path d="M280 120 C 320 90, 330 70, 330 58" />
      </svg>
      <div className={`${s.sticky} ${s.stickyA}`}>
        Onboarding kürzen
        <span className={s.votes}>
          <i />
          <i />
          <i />
        </span>
      </div>
      <div className={`${s.sticky} ${s.stickyB}`}>
        Demo-Video
        <span className={s.votes}>
          <i />
        </span>
      </div>
      <div className={`${s.sticky} ${s.stickyC}`}>
        Preise klarer
        <span className={s.votes}>
          <i />
          <i />
        </span>
      </div>
      <div className={s.wbRef}>
        <FileText size={13} /> Projekt-Kickoff
      </div>
      <div className={s.wbPin}>
        <ChatCircle size={13} weight="fill" /> 2
      </div>
      <div className={s.wbTimer}>
        <Timer size={14} />
        {String(Math.floor(seconds / 60)).padStart(2, "0")}:
        {String(seconds % 60).padStart(2, "0")}
      </div>
      <div className={`${s.cursor} ${s.cursorA}`}>
        <Pointer color="#3b3fd8" />
        <span style={{ background: "#3b3fd8" }}>Mara</span>
      </div>
      <div className={`${s.cursor} ${s.cursorB}`}>
        <Pointer color="#f0663a" />
        <span style={{ background: "#f0663a" }}>Jonas</span>
      </div>
    </div>
  );
}
function Pointer({ color }: { color: string }) {
  return (
    <svg width="16" height="18" viewBox="0 0 16 18" aria-hidden="true">
      <path
        d="M1 1 L1 15 L5 11 L8 17 L10.5 16 L7.5 10 L13 10 Z"
        fill={color}
        stroke="#fff"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function JournalScene({ run }: { run: boolean }) {
  const round = useReplay(8000, run);
  return (
    <div className={s.jr} key={round} data-run={run}>
      <div className={`${s.jrPage} ${s.jrFri}`}>
        <small>Freitag</small>
        <strong>16. Oktober</strong>
        <p>Guter Termin mit dem Kunden, Entwurf ist abgenommen.</p>
        <ul>
          <li className={s.taskDone}>
            <span className={s.check} />
            Entwurf präsentieren
          </li>
          <li className={s.jrLeaving}>
            <span className={s.check} />
            Rechnung schreiben
          </li>
          <li className={s.jrLeaving}>
            <span className={s.check} />
            Mails beantworten
          </li>
        </ul>
      </div>
      <div className={`${s.jrPage} ${s.jrSat}`}>
        <small>Heute</small>
        <strong>Samstag, 17. Oktober</strong>
        <ul>
          <li className={s.jrArriving}>
            <span className={s.check} />
            Rechnung schreiben
            <ArrowsClockwise size={12} className={s.jrCarried} />
          </li>
          <li className={s.jrArriving}>
            <span className={s.check} />
            Mails beantworten
            <ArrowsClockwise size={12} className={s.jrCarried} />
          </li>
        </ul>
        <p className={s.jrCaret}>
          <span />
        </p>
      </div>
    </div>
  );
}

function CollabScene({ run }: { run: boolean }) {
  const round = useReplay(9000, run);
  return (
    <div className={s.collab} key={round} data-run={run}>
      <div className={s.collabDoc}>
        <div className={s.collabHead}>
          <span className={s.docTitleSmall}>Pressemitteilung</span>
          <span className={s.faces}>
            <span className={s.avatar} style={{ background: "#3b3fd8" }}>
              M
            </span>
            <span className={s.avatar} style={{ background: "#f0663a" }}>
              J
            </span>
            <span className={s.avatar} style={{ background: "#2f9e6e" }}>
              A
            </span>
          </span>
        </div>
        <p>
          Ab Montag gibt es die neue Website
          <span className={s.liveA}>
            {" "}
            in zwei Sprachen
            <i className={s.caret} style={{ background: "#3b3fd8" }}>
              <b style={{ background: "#3b3fd8" }}>Mara</b>
            </i>
          </span>
          .
        </p>
        <p>
          <mark className={s.commented}>Alle Preise</mark> stehen direkt auf
          der Startseite
          <span className={s.liveB}>
            , ohne Formular
            <i className={s.caret} style={{ background: "#f0663a" }}>
              <b style={{ background: "#f0663a" }}>Jonas</b>
            </i>
          </span>
          .
        </p>
      </div>
      <div className={s.thread}>
        <span className={s.avatar} style={{ background: "#2f9e6e" }}>
          A
        </span>
        <div>
          <strong>Aylin</strong>
          <span>
            <b className={s.mention}>@Jonas</b> auch die Jahrespreise?
          </span>
        </div>
      </div>
      <div className={s.toast}>
        <Bell size={14} weight="fill" />
        Aylin hat dich in „Pressemitteilung“ erwähnt
      </div>
      <div className={s.share}>
        <LinkIcon size={14} />
        <span>Gastlink</span>
        <span className={s.shareModes}>
          <i>Lesen</i>
          <i>Kommentieren</i>
          <i>Live bearbeiten</i>
        </span>
      </div>
    </div>
  );
}

/* ---------- Hero window ---------- */

function HeroWindow() {
  const [ref, inView] = useInView<HTMLDivElement>();
  const [active, setActive] = useCycle(TYPES.length, 3400, inView);
  return (
    <div className={s.window} ref={ref} aria-hidden="true">
      <div className={s.windowBar}>
        <i />
        <i />
        <i />
        <span>flowplan.firma.de</span>
      </div>
      <div className={s.windowBody}>
        <aside className={s.windowSide}>
          <div className={s.windowBrand}>
            <BrandMark size={18} /> flowplan
          </div>
          <span className={s.sideLabel}>Team</span>
          {TYPES.map((t, i) => (
            <button
              key={t.key}
              type="button"
              tabIndex={-1}
              className={i === active ? s.sideActive : undefined}
              onClick={() => setActive(i)}
            >
              <t.icon size={14} />
              {t.page}
            </button>
          ))}
          <span className={s.sideGhost} />
          <span className={s.sideGhost} style={{ width: "58%" }} />
        </aside>
        <div className={s.windowMain}>
          {TYPES.map((t, i) => (
            <div
              key={t.key}
              className={s.screen}
              data-active={i === active}
            >
              {t.key === "doc" && <DocScene run={inView && i === active} />}
              {t.key === "db" && <DbScene run={inView && i === active} />}
              {t.key === "board" && (
                <BoardScene run={inView && i === active} />
              )}
              {t.key === "journal" && (
                <JournalScene run={inView && i === active} />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------- Page types (sticky tour) ---------- */

const STEPS: {
  key: (typeof TYPES)[number]["key"];
  title: string;
  lead: string;
  points: string[];
}[] = [
  {
    key: "doc",
    title: "Dokumente",
    lead: "Schreiben in Blöcken: Text, Aufgaben, Tabellen, Formeln und Diagramme auf einer Seite.",
    points: [
      "Befehle mit „/“, Blöcke per Griff verschieben",
      "Spalten, Hinweise, Aufklapper, Code und Mermaid",
      "Formeln mit KaTeX, Bilder, Einbettungen, Linkkarten",
      "Versionen jeder Seite zum Zurückholen",
    ],
  },
  {
    key: "db",
    title: "Datenbanken",
    lead: "Dieselben Einträge als Tabelle, Board, Kalender oder Zeitleiste – umschalten, nichts kopieren.",
    points: [
      "Filter in Gruppen, Sortierung, drei Gruppierungsebenen",
      "Formeln, Relationen und Rollups",
      "Wiederkehrende Einträge und Erinnerungen",
      "Jeder Eintrag ist auch eine eigene Seite",
    ],
  },
  {
    key: "board",
    title: "Whiteboards",
    lead: "Eine unendliche Fläche für Workshops: Notizen, Formen, Verbindungen und Verweise auf eure Seiten.",
    points: [
      "Abstimmungen und Timer für die Moderation",
      "Kommentar-Pins direkt am Objekt",
      "Tabellen, Rahmen, Freihand und Bilder",
      "In Dokumente einbetten, live gemeinsam",
    ],
  },
  {
    key: "journal",
    title: "Journal",
    lead: "Jeden Tag eine neue Seite. Was gestern offen blieb, steht heute oben.",
    points: [
      "Offene Aufgaben wandern automatisch in den neuen Tag",
      "Tage ohne Eintrag verschwinden wieder",
      "Tagebuch, Arbeitsprotokoll oder Aufgabenliste",
    ],
  },
];
function Tour() {
  const [active, setActive] = useState(0);
  const [stageRef, stageInView] = useInView<HTMLDivElement>();
  const steps = useRef<(HTMLElement | null)[]>([]);
  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting)
            setActive(Number((entry.target as HTMLElement).dataset.step));
      },
      { rootMargin: "-45% 0px -45% 0px" },
    );
    steps.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, []);
  return (
    <section className={s.tour} id="seitentypen">
      <div className={s.sectionHead} data-reveal>
        <span className={s.eyebrow}>Vier Seitentypen, ein Seitenbaum</span>
        <h2>Jede Idee bekommt die Form, die sie braucht.</h2>
      </div>
      <div className={s.tourGrid}>
        <div className={s.tourSteps}>
          {STEPS.map((step, i) => {
            const Icon = TYPES[i].icon;
            return (
              <article
                key={step.key}
                id={step.key === "journal" ? "journal" : undefined}
                ref={(el) => {
                  steps.current[i] = el;
                }}
                data-step={i}
                className={s.step}
                data-active={i === active}
              >
                <span className={s.stepIcon}>
                  <Icon size={20} />
                </span>
                <h3>{step.title}</h3>
                <p>{step.lead}</p>
                <ul>
                  {step.points.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
                <div className={s.stepScene}>
                  <SceneFor kind={step.key} run={i === active} />
                </div>
              </article>
            );
          })}
        </div>
        <div className={s.tourStage} ref={stageRef} aria-hidden="true">
          <div className={s.stageCard}>
            {STEPS.map((step, i) => (
              <div
                key={step.key}
                className={s.stageScene}
                data-active={i === active}
              >
                <SceneFor kind={step.key} run={stageInView && i === active} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
function SceneFor({
  kind,
  run,
}: {
  kind: (typeof TYPES)[number]["key"];
  run: boolean;
}) {
  if (kind === "doc") return <DocScene run={run} />;
  if (kind === "db") return <DbScene run={run} />;
  if (kind === "board") return <BoardScene run={run} />;
  return <JournalScene run={run} />;
}

/* ---------- Views strip ---------- */

const VIEWS = [
  { icon: Table, label: "Tabelle" },
  { icon: Kanban, label: "Board" },
  { icon: CalendarBlank, label: "Kalender" },
  { icon: ChartBarHorizontal, label: "Zeitleiste" },
  { icon: SquaresFour, label: "Galerie" },
  { icon: List, label: "Liste" },
  { icon: Rows, label: "Feed" },
  { icon: ChartBar, label: "Diagramm" },
  { icon: ClipboardText, label: "Formular" },
];

/* ---------- Feature index ---------- */

const INDEX: { title: string; items: string[] }[] = [
  {
    title: "Dokumente",
    items: [
      "Blockeditor mit „/“-Befehlen",
      "Aufgabenlisten, Hinweise, Aufklapper",
      "Spalten bis drei nebeneinander",
      "Code mit Hervorhebung, Mermaid-Diagramme",
      "Formeln mit KaTeX",
      "Bilder, Dateien, Einbettungen, Linkkarten",
      "Erwähnungen von Personen und Seiten",
      "Versionen und Wiederherstellung",
      "Symbol, Cover, Serif- oder Mono-Schrift",
      "Seiten sperren",
    ],
  },
  {
    title: "Datenbanken",
    items: [
      "Neun Ansichten auf dieselben Daten",
      "19 Feldtypen, darunter Formel, Relation, Rollup",
      "Filtergruppen und Sortierung",
      "Gruppen in drei Ebenen, Swimlanes",
      "Berechnungen je Spalte",
      "Wiederholungen und Erinnerungen",
      "Datensatzseiten mit eigenem Layout",
      "Rechte pro Datensatz",
      "Formulare, auch für Gäste",
      "CSV-Import und -Export",
    ],
  },
  {
    title: "Whiteboards",
    items: [
      "Notizen, Formen, Text, Freihand",
      "Verbindungen, Rahmen, Tabellen",
      "Verweise und Links auf Seiten",
      "Abstimmungen und Timer",
      "Kommentar-Pins",
      "Vorlagen für Workshops",
      "Vollbild und Einbetten in Dokumente",
    ],
  },
  {
    title: "Journal",
    items: [
      "Automatisch eine Seite pro Tag",
      "Offene Aufgaben wandern mit",
      "Leere Tage verschwinden",
      "Übersicht nach Monaten",
    ],
  },
  {
    title: "Zusammenarbeit",
    items: [
      "Gleichzeitig bearbeiten mit Live-Cursorn",
      "Kommentare am Text und an Einträgen",
      "Posteingang und Push-Benachrichtigungen",
      "Gastlinks: lesen, kommentieren, live bearbeiten",
      "Öffentliche Seiten, auch zum Kopieren",
      "Vorlagengalerie",
    ],
  },
  {
    title: "Ordnung",
    items: [
      "Arbeitsbereiche und Bereiche",
      "Gruppen und Seitenrechte",
      "Suche, auch in Dateien und Scans",
      "Gespeicherte Suchen",
      "Favoriten und Papierkorb",
      "Markdown-Export",
    ],
  },
  {
    title: "Betrieb",
    items: [
      "Ein Container, eine SQLite-Datei",
      "Anmeldung über euren OIDC-Anbieter",
      "Administration mit Protokoll",
      "Sicherungen und Wiederherstellung",
      "Archiv-Export und -Import",
      "Offline-Modus, Web-App fürs iPhone",
      "Desktop-Apps für macOS und Windows",
    ],
  },
];

/* ---------- Page ---------- */

function Reveal({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div data-reveal className={className}>
      {children}
    </div>
  );
}

export default function Landing({ loginHref, registerHref, instanceName }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  const [section, setSection] = useState("");
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    el.dataset.js = "true";
    // Scroll progress of the hero drives the layered backdrop.
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const y = window.scrollY;
        setScrolled(y > 8);
        el.style.setProperty(
          "--hero",
          String(Math.min(1, y / Math.max(1, window.innerHeight))),
        );
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    const reveal = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) {
            (entry.target as HTMLElement).dataset.in = "true";
            reveal.unobserve(entry.target);
          }
      },
      { rootMargin: "0px 0px -10% 0px" },
    );
    el.querySelectorAll("[data-reveal]").forEach((n) => reveal.observe(n));
    const nav = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) setSection(entry.target.id);
      },
      { rootMargin: "-40% 0px -55% 0px" },
    );
    el.querySelectorAll("section[id]").forEach((n) => nav.observe(n));
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      reveal.disconnect();
      nav.disconnect();
    };
  }, []);
  const [collabRef, collabInView] = useInView<HTMLDivElement>();
  const nav = [
    ["seitentypen", "Seitentypen"],
    ["ansichten", "Ansichten"],
    ["zusammenarbeit", "Zusammenarbeit"],
    ["funktionen", "Alle Funktionen"],
    ["betrieb", "Betrieb"],
  ];
  return (
    <div className={s.root} ref={root}>
      <header className={s.header} data-scrolled={scrolled}>
        <a href="#top" className={s.brand} aria-label="Flowplan, nach oben">
          <BrandMark size={28} />
          <span>flowplan</span>
          {instanceName && <small>{instanceName}</small>}
        </a>
        <nav className={s.nav} aria-label="Abschnitte">
          {nav.map(([id, label]) => (
            <a key={id} href={`#${id}`} data-active={section === id}>
              {label}
            </a>
          ))}
        </nav>
        <div className={s.actions}>
          <a className={s.ghost} href={loginHref}>
            Anmelden
          </a>
          <a className={s.primary} href={registerHref}>
            Registrieren
          </a>
        </div>
      </header>

      <main id="top">
        <section className={s.hero}>
          <div className={s.planes} aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
          <div className={s.heroText}>
            <span className={`${s.eyebrow} ${s.rise}`} style={{ "--d": 0 } as React.CSSProperties}>
              Dokumente · Datenbanken · Whiteboards · Journal
            </span>
            <h1 className={s.rise} style={{ "--d": 1 } as React.CSSProperties}>
              Alles, woran ihr arbeitet.
              <br />
              <em>Auf eurem Server.</em>
            </h1>
            <p className={s.rise} style={{ "--d": 2 } as React.CSSProperties}>
              Flowplan verbindet Dokumente, Datenbanken, Whiteboards und ein
              tägliches Journal in einem Seitenbaum. Ihr bearbeitet alles
              gleichzeitig, die Daten bleiben bei euch.
            </p>
            <div className={`${s.heroCtas} ${s.rise}`} style={{ "--d": 3 } as React.CSSProperties}>
              <a className={s.primaryLarge} href={registerHref}>
                Registrieren <ArrowRight size={18} />
              </a>
              <a className={s.secondaryLarge} href={loginHref}>
                Anmelden
              </a>
            </div>
            <ul className={`${s.facts} ${s.rise}`} style={{ "--d": 4 } as React.CSSProperties}>
              <li>Selbst gehostet</li>
              <li>Anmeldung per SSO</li>
              <li>Keine KI</li>
              <li>Kein Tracking</li>
            </ul>
          </div>
          <div className={s.heroVisual}>
            <HeroWindow />
          </div>
        </section>

        <Tour />

        <section className={s.views} id="ansichten">
          <Reveal className={s.sectionHead}>
            <span className={s.eyebrow}>Datenbanken</span>
            <h2>Neun Ansichten. Dieselben Daten.</h2>
            <p>
              Jede Ansicht hat eigene Filter, Sortierung und Gruppen. Eine
              Änderung im Board steht sofort auch im Kalender.
            </p>
          </Reveal>
          <ul className={s.viewGrid}>
            {VIEWS.map((v, i) => (
              <li key={v.label} data-reveal style={{ "--i": i } as React.CSSProperties}>
                <span>
                  <v.icon size={26} />
                </span>
                {v.label}
              </li>
            ))}
          </ul>
        </section>

        <section className={s.collabSection} id="zusammenarbeit">
          <div className={s.collabGrid}>
            <Reveal className={s.collabText}>
              <span className={s.eyebrow}>Zusammenarbeit</span>
              <h2>Gemeinsam an derselben Zeile.</h2>
              <p>
                Mehrere Personen schreiben gleichzeitig, jede mit eigenem
                Cursor. Kommentare hängen am Text, Erwähnungen landen im
                Posteingang und als Push auf dem Handy.
              </p>
              <ul className={s.checks}>
                <li>Live-Bearbeitung in Dokumenten, Datenbanken und Whiteboards</li>
                <li>Kommentare, Reaktionen und Erwähnungen</li>
                <li>Gastlinks zum Lesen, Kommentieren oder Mitbearbeiten</li>
                <li>Öffentliche Seiten und Formulare ohne Konto</li>
              </ul>
            </Reveal>
            <div className={s.collabStage} ref={collabRef} data-reveal>
              <CollabScene run={collabInView} />
            </div>
          </div>
        </section>

        <section className={s.index} id="funktionen">
          <Reveal className={s.sectionHead}>
            <span className={s.eyebrow}>Alle Funktionen</span>
            <h2>Was drin ist.</h2>
          </Reveal>
          <div className={s.indexGrid}>
            {INDEX.map((group, i) => (
              <div
                key={group.title}
                className={s.indexGroup}
                data-reveal
                style={{ "--i": i } as React.CSSProperties}
              >
                <h3>{group.title}</h3>
                <ul>
                  {group.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        <section className={s.ops} id="betrieb">
          <div className={s.opsInner}>
            <Reveal className={s.opsText}>
              <span className={s.eyebrow}>Betrieb</span>
              <h2>
                Euer Server.
                <br />
                Eure Daten.
              </h2>
              <p>
                Flowplan läuft als ein Container mit einer SQLite-Datei.
                Angemeldet wird über euren bestehenden OIDC-Anbieter, die
                Admin-Gruppe verwaltet Konten, Speicher und Sicherungen.
              </p>
              <div className={s.never}>
                <span>
                  <LockSimple size={16} /> Keine KI-Funktionen
                </span>
                <span>
                  <LockSimple size={16} /> Kein Tracking
                </span>
                <span>
                  <LockSimple size={16} /> Keine Cloud des Herstellers
                </span>
              </div>
            </Reveal>
            <Reveal className={s.terminal}>
              <div className={s.terminalBar}>
                <i />
                <i />
                <i />
                <span>.env</span>
              </div>
              <pre>
                <code>
                  <span className={s.tl}>
                    <b>APP_URL</b>=https://flowplan.firma.de
                  </span>
                  <span className={s.tl}>
                    <b>OIDC_ISSUER</b>=https://login.firma.de
                  </span>
                  <span className={s.tl}>
                    <b>OIDC_CLIENT_ID</b>=flowplan
                  </span>
                  <span className={s.tl}>
                    <b>FLOWPLAN_DATA_DIR</b>=/data
                  </span>
                  <span className={`${s.tl} ${s.tlOk}`}>
                    ✓ Bereit auf Port 3000
                  </span>
                </code>
              </pre>
            </Reveal>
          </div>
          <ul className={s.platforms}>
            {[
              { icon: Desktop, label: "macOS und Windows", note: "Desktop-App" },
              { icon: SquaresFour, label: "Browser", note: "Desktop und Mobil" },
              { icon: Bell, label: "iPhone", note: "Web-App mit Push" },
              { icon: ArrowsClockwise, label: "Offline", note: "pro Gerät zuschaltbar" },
            ].map((p, i) => (
              <li key={p.label} data-reveal style={{ "--i": i } as React.CSSProperties}>
                <p.icon size={22} />
                <strong>{p.label}</strong>
                <span>{p.note}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className={s.final}>
          <Reveal>
            <BrandMark size={56} />
            <h2>Fang mit einer leeren Seite an.</h2>
            <div className={s.heroCtas}>
              <a className={s.primaryLarge} href={registerHref}>
                Registrieren <ArrowRight size={18} />
              </a>
              <a className={s.secondaryLarge} href={loginHref}>
                Anmelden
              </a>
            </div>
          </Reveal>
        </section>
      </main>

      <footer className={s.footer}>
        <span className={s.brand}>
          <BrandMark size={20} />
          <span>flowplan</span>
        </span>
        <span>Dokumente, Datenbanken, Whiteboards und Journal. Selbst gehostet.</span>
      </footer>
    </div>
  );
}
