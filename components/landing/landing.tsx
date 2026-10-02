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
  GithubLogo,
  Cloud,
  HardDrives,
} from "@phosphor-icons/react";
import { BrandMark } from "../brand-mark";
import { LanguageSwitch, useLocale } from "../i18n";
import { GITHUB_URL, landingCopy } from "./copy";
import s from "./landing.module.css";

// The page's texts in the reader's language.
const useCopy = () => landingCopy[useLocale()];

type Props = {
  loginHref: string;
  registerHref: string;
  instanceName?: string;
  demoEnabled?: boolean;
};

// "Demo ausprobieren": a throwaway account, deleted after leaving.
function DemoButton({ className, short = false }: { className: string; short?: boolean }) {
  const c = useCopy().demo;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <>
      <button
        type="button"
        className={className}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          const response = await fetch("/api/auth/trial", { method: "POST" });
          if (response.ok) {
            location.assign("/");
            return;
          }
          setError(((await response.json().catch(() => ({}))) as { error?: string }).error || c.failed);
          setBusy(false);
        }}
      >
        {busy ? c.busy : short ? c.short : c.try}
      </button>
      {error && (
        <span role="alert" className={s.demoError}>
          {error}
        </span>
      )}
    </>
  );
}

const TYPES = [
  { key: "doc", icon: FileText },
  { key: "db", icon: Table },
  { key: "board", icon: PresentationChart },
  { key: "journal", icon: Notebook },
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
  const c = useCopy().docScene;
  const round = useReplay(11000, run);
  return (
    <div className={s.doc} key={round} data-run={run}>
      <div className={s.docTitle}>{c.title}</div>
      <div className={s.docMeta}>
        <span className={s.avatar} style={{ background: "#f0663a" }}>
          M
        </span>
        {c.meta}
      </div>
      <p className={`${s.docLine} ${s.typing}`}>{c.line}</p>
      <div className={s.slash}>
        <span className={s.slashInput}>{c.slash}</span>
        <ul>
          <li className={s.slashActive}>
            <CheckSquare size={14} /> {c.slashItems[0]}
          </li>
          <li>
            <Table size={14} /> {c.slashItems[1]}
          </li>
          <li>
            <ChartBar size={14} /> {c.slashItems[2]}
          </li>
        </ul>
      </div>
      <ul className={s.docTasks}>
        <li className={s.taskDone}>
          <span className={s.check} />
          {c.tasks[0]}
        </li>
        <li>
          <span className={s.check} />
          {c.tasks[1]}
        </li>
      </ul>
      <div className={s.docCols}>
        <div className={s.callout}>
          <strong>{c.calloutTitle}</strong>
          {c.callout}
        </div>
        <div className={s.formula}>
          <span>{c.formulaLabel}</span>
          {c.formula}
          <b>{c.formulaResult}</b>
        </div>
      </div>
    </div>
  );
}

// Positions of the example records; their titles come from the copy.
const RECORDS = [
  { st: 1, day: 1, start: 0, len: 3 },
  { st: 0, day: 3, start: 2, len: 3 },
  { st: 2, day: 0, start: 0, len: 2 },
  { st: 0, day: 4, start: 4, len: 3 },
  { st: 1, day: 2, start: 3, len: 4 },
  { st: 2, day: 4, start: 6, len: 2 },
];
const LAYOUTS = [
  { key: "table", icon: Table },
  { key: "board", icon: Kanban },
  { key: "calendar", icon: CalendarBlank },
  { key: "timeline", icon: ChartBarHorizontal },
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
  const c = useCopy().dbScene;
  const [index, setIndex] = useCycle(LAYOUTS.length, 2600, run);
  const layout = LAYOUTS[index].key;
  return (
    <div className={s.db} data-layout={layout}>
      <div className={s.dbTabs} role="tablist" aria-label={c.views}>
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
            {c.layouts[i]}
          </button>
        ))}
      </div>
      <div className={s.dbStage}>
        <div className={s.dbHeads} data-for="table">
          {c.heads.map((h) => (
            <span key={h}>{h}</span>
          ))}
        </div>
        <div className={s.dbHeads} data-for="board">
          {c.status.map((st, i) => (
            <span key={st} data-status={i}>
              {st}
            </span>
          ))}
        </div>
        <div className={s.dbHeads} data-for="calendar">
          {c.days.map((d) => (
            <span key={d}>{d}</span>
          ))}
        </div>
        <div className={s.dbHeads} data-for="timeline">
          {c.weeks.map((d) => (
            <span key={d}>{d}</span>
          ))}
        </div>
        {RECORDS.map((r, i) => {
          const p = place(layout, i);
          return (
            <div
              key={i}
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
              <span className={s.recordTitle}>{c.records[i]}</span>
              <span className={s.recordStatus}>{c.status[r.st]}</span>
              <span className={s.recordDate}>{c.date(12 + r.day)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BoardScene({ run }: { run: boolean }) {
  const c = useCopy().boardScene;
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
        {c.stickies[0]}
        <span className={s.votes}>
          <i />
          <i />
          <i />
        </span>
      </div>
      <div className={`${s.sticky} ${s.stickyB}`}>
        {c.stickies[1]}
        <span className={s.votes}>
          <i />
        </span>
      </div>
      <div className={`${s.sticky} ${s.stickyC}`}>
        {c.stickies[2]}
        <span className={s.votes}>
          <i />
          <i />
        </span>
      </div>
      <div className={s.wbRef}>
        <FileText size={13} /> {c.page}
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
  const c = useCopy().journalScene;
  const round = useReplay(8000, run);
  return (
    <div className={s.jr} key={round} data-run={run}>
      <div className={`${s.jrPage} ${s.jrFri}`}>
        <small>{c.yesterday}</small>
        <strong>{c.yesterdayDate}</strong>
        <p>{c.note}</p>
        <ul>
          <li className={s.taskDone}>
            <span className={s.check} />
            {c.done}
          </li>
          {c.open.map((task) => (
            <li key={task} className={s.jrLeaving}>
              <span className={s.check} />
              {task}
            </li>
          ))}
        </ul>
      </div>
      <div className={`${s.jrPage} ${s.jrSat}`}>
        <small>{c.today}</small>
        <strong>{c.todayDate}</strong>
        <ul>
          {c.open.map((task) => (
            <li key={task} className={s.jrArriving}>
              <span className={s.check} />
              {task}
              <ArrowsClockwise size={12} className={s.jrCarried} />
            </li>
          ))}
        </ul>
        <p className={s.jrCaret}>
          <span />
        </p>
      </div>
    </div>
  );
}

function CollabScene({ run }: { run: boolean }) {
  const c = useCopy().collabScene;
  const round = useReplay(9000, run);
  return (
    <div className={s.collab} key={round} data-run={run}>
      <div className={s.collabDoc}>
        <div className={s.collabHead}>
          <span className={s.docTitleSmall}>{c.title}</span>
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
          {c.first}
          <span className={s.liveA}>
            {c.firstLive}
            <i className={s.caret} style={{ background: "#3b3fd8" }}>
              <b style={{ background: "#3b3fd8" }}>Mara</b>
            </i>
          </span>
          .
        </p>
        <p>
          <mark className={s.commented}>{c.secondMarked}</mark>
          {c.second}
          <span className={s.liveB}>
            {c.secondLive}
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
            <b className={s.mention}>@Jonas</b> {c.comment}
          </span>
        </div>
      </div>
      <div className={s.toast}>
        <Bell size={14} weight="fill" />
        {c.toast}
      </div>
      <div className={s.share}>
        <LinkIcon size={14} />
        <span>{c.guestLink}</span>
        <span className={s.shareModes}>
          {c.modes.map((m) => (
            <i key={m}>{m}</i>
          ))}
        </span>
      </div>
    </div>
  );
}

/* ---------- Hero window ---------- */

function HeroWindow() {
  const c = useCopy();
  const [ref, inView] = useInView<HTMLDivElement>();
  const [active, setActive] = useCycle(TYPES.length, 3400, inView);
  return (
    <div className={s.window} ref={ref} aria-hidden="true">
      <div className={s.windowBar}>
        <i />
        <i />
        <i />
        <span>flowplan.org</span>
      </div>
      <div className={s.windowBody}>
        <aside className={s.windowSide}>
          <div className={s.windowBrand}>
            <BrandMark size={18} /> flowplan
          </div>
          <span className={s.sideLabel}>{c.window.team}</span>
          {TYPES.map((t, i) => (
            <button
              key={t.key}
              type="button"
              tabIndex={-1}
              className={i === active ? s.sideActive : undefined}
              onClick={() => setActive(i)}
            >
              <t.icon size={14} />
              {c.types[t.key].page}
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

function Tour() {
  const c = useCopy().tour;
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
        <span className={s.eyebrow}>{c.eyebrow}</span>
        <h2>{c.title}</h2>
      </div>
      <div className={s.tourGrid}>
        <div className={s.tourSteps}>
          {TYPES.map(({ key, icon: Icon }, i) => {
            const step = c.steps[key];
            return (
              <article
                key={key}
                id={key === "journal" ? "journal" : undefined}
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
                  <SceneFor kind={key} run={i === active} />
                </div>
              </article>
            );
          })}
        </div>
        <div className={s.tourStage} ref={stageRef} aria-hidden="true">
          <div className={s.stageCard}>
            {TYPES.map(({ key }, i) => (
              <div
                key={key}
                className={s.stageScene}
                data-active={i === active}
              >
                <SceneFor kind={key} run={stageInView && i === active} />
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

const VIEW_ICONS = [Table, Kanban, CalendarBlank, ChartBarHorizontal, SquaresFour, List, Rows, ChartBar, ClipboardText];
const PLATFORM_ICONS = [Desktop, SquaresFour, Bell, ArrowsClockwise];

/* ---------- Page ---------- */

function Reveal({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div data-reveal className={className}>
      {children}
    </div>
  );
}

export default function Landing({ loginHref, registerHref, instanceName, demoEnabled }: Props) {
  const c = useCopy();
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
  const nav = Object.entries(c.nav);
  return (
    <div className={s.root} ref={root}>
      <header className={s.header} data-scrolled={scrolled}>
        <a href="#top" className={s.brand} aria-label={c.header.home}>
          <BrandMark size={28} />
          <span>flowplan</span>
          {instanceName && <small>{instanceName}</small>}
        </a>
        <nav className={s.nav} aria-label={c.header.sections}>
          {nav.map(([id, label]) => (
            <a key={id} href={`#${id}`} data-active={section === id}>
              {label}
            </a>
          ))}
          <a href="/docs">{c.header.docs}</a>
        </nav>
        <div className={s.actions}>
          <LanguageSwitch className={s.lang} />
          {demoEnabled && <DemoButton className={s.ghost} short />}
          <a className={s.ghost} href={loginHref}>
            {c.header.login}
          </a>
          <a className={s.primary} href={registerHref}>
            {c.header.register}
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
              {c.hero.eyebrow}
            </span>
            <h1 className={s.rise} style={{ "--d": 1 } as React.CSSProperties}>
              {c.hero.title}
              <br />
              <em>{c.hero.titleEm}</em>
            </h1>
            <p className={s.rise} style={{ "--d": 2 } as React.CSSProperties}>
              {c.hero.text}
            </p>
            <div className={`${s.heroCtas} ${s.rise}`} style={{ "--d": 3 } as React.CSSProperties}>
              <a className={s.primaryLarge} href={registerHref}>
                {c.header.register} <ArrowRight size={18} />
              </a>
              <a className={s.secondaryLarge} href={loginHref}>
                {c.header.login}
              </a>
              {demoEnabled && <DemoButton className={s.secondaryLarge} />}
            </div>
            <ul className={`${s.facts} ${s.rise}`} style={{ "--d": 4 } as React.CSSProperties}>
              {c.hero.facts.map((fact) => (
                <li key={fact}>{fact}</li>
              ))}
            </ul>
          </div>
          <div className={s.heroVisual}>
            <HeroWindow />
          </div>
        </section>

        <Tour />

        <section className={s.views} id="ansichten">
          <Reveal className={s.sectionHead}>
            <span className={s.eyebrow}>{c.views.eyebrow}</span>
            <h2>{c.views.title}</h2>
            <p>{c.views.text}</p>
          </Reveal>
          <ul className={s.viewGrid}>
            {c.views.labels.map((label, i) => {
              const Icon = VIEW_ICONS[i];
              return (
                <li key={label} data-reveal style={{ "--i": i } as React.CSSProperties}>
                  <span>
                    <Icon size={26} />
                  </span>
                  {label}
                </li>
              );
            })}
          </ul>
        </section>

        <section className={s.collabSection} id="zusammenarbeit">
          <div className={s.collabGrid}>
            <Reveal className={s.collabText}>
              <span className={s.eyebrow}>{c.collab.eyebrow}</span>
              <h2>{c.collab.title}</h2>
              <p>{c.collab.text}</p>
              <ul className={s.checks}>
                {c.collab.checks.map((check) => (
                  <li key={check}>{check}</li>
                ))}
              </ul>
            </Reveal>
            <div className={s.collabStage} ref={collabRef} data-reveal>
              <CollabScene run={collabInView} />
            </div>
          </div>
        </section>

        <section className={s.index} id="funktionen">
          <Reveal className={s.sectionHead}>
            <span className={s.eyebrow}>{c.index.eyebrow}</span>
            <h2>{c.index.title}</h2>
          </Reveal>
          <div className={s.indexGrid}>
            {c.index.groups.map((group, i) => (
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
          <a className={s.docsLink} href="/docs">
            {c.index.docs} <ArrowRight size={16} />
          </a>
        </section>

        <section className={s.selfHost} id="selbst-hosten">
          <Reveal className={s.sectionHead}>
            <span className={s.eyebrow}>{c.selfHost.eyebrow}</span>
            <h2>
              {c.selfHost.title}
              <br />
              <em>{c.selfHost.titleEm}</em>
            </h2>
            <p>{c.selfHost.text}</p>
          </Reveal>
          <div className={s.hostGrid}>
            <Reveal className={s.hostCard}>
              <span className={s.hostIcon}>
                <Cloud size={22} />
              </span>
              <h3>{c.selfHost.hosted.title}</h3>
              <span className={s.hostNote}>{c.selfHost.hosted.note}</span>
              <ul className={s.checks}>
                {c.selfHost.hosted.points.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
              <a className={s.primaryLarge} href={registerHref}>
                {c.header.register} <ArrowRight size={18} />
              </a>
            </Reveal>
            <Reveal className={s.hostCard}>
              <span className={s.hostIcon}>
                <HardDrives size={22} />
              </span>
              <h3>{c.selfHost.self.title}</h3>
              <span className={s.hostNote}>{c.selfHost.self.note}</span>
              <ul className={s.checks}>
                {c.selfHost.self.points.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
              <pre className={s.hostCode}>
                <code>
                  <span>curl -O …/compose.yaml</span>
                  <span>docker compose up -d</span>
                </code>
              </pre>
              <div className={s.hostLinks}>
                <a className={s.secondaryLarge} href="/docs/installation">
                  {c.selfHost.guide}
                </a>
                <a className={s.secondaryLarge} href={GITHUB_URL} rel="noopener">
                  <GithubLogo size={18} /> {c.selfHost.github}
                </a>
              </div>
            </Reveal>
          </div>
        </section>

        <section className={s.ops} id="sicherheit">
          <div className={s.opsInner}>
            <Reveal className={s.opsText}>
              <span className={s.eyebrow}>{c.security.eyebrow}</span>
              <h2>
                {c.security.title}
                <br />
                {c.security.titleEm}
              </h2>
              <p>{c.security.text}</p>
              <div className={s.never}>
                {c.security.never.map((item) => (
                  <span key={item}>
                    <LockSimple size={16} /> {item}
                  </span>
                ))}
              </div>
              <a className={s.docsLink} href="/docs">
                {c.security.docs} <ArrowRight size={16} />
              </a>
            </Reveal>
            <Reveal className={s.terminal}>
              <div className={s.terminalBar}>
                <i />
                <i />
                <i />
                <span>{c.security.terminal}</span>
              </div>
              <pre>
                <code>
                  {c.security.rows.map(([key, value]) => (
                    <span key={key} className={s.tl}>
                      <b>{key}</b> {value}
                    </span>
                  ))}
                  <span className={`${s.tl} ${s.tlOk}`}>{c.security.ok}</span>
                </code>
              </pre>
            </Reveal>
          </div>
          <ul className={s.platforms}>
            {c.security.platforms.map((p, i) => {
              const Icon = PLATFORM_ICONS[i];
              return (
                <li key={p.label} data-reveal style={{ "--i": i } as React.CSSProperties}>
                  <Icon size={22} />
                  <strong>{p.label}</strong>
                  <span>{p.note}</span>
                </li>
              );
            })}
          </ul>
        </section>

        <section className={s.final}>
          <Reveal>
            <BrandMark size={56} />
            <h2>{c.final.title}</h2>
            <div className={s.heroCtas}>
              <a className={s.primaryLarge} href={registerHref}>
                {c.header.register} <ArrowRight size={18} />
              </a>
              <a className={s.secondaryLarge} href={loginHref}>
                {c.header.login}
              </a>
              {demoEnabled && <DemoButton className={s.secondaryLarge} />}
            </div>
          </Reveal>
        </section>
      </main>

      <footer className={s.footer}>
        <span className={s.brand}>
          <BrandMark size={20} />
          <span>flowplan</span>
        </span>
        <span>{c.footer.tagline}</span>
        <nav className={s.footerNav} aria-label={c.footer.more}>
          <a href="/docs">{c.footer.docs}</a>
          <a href="/templates">{c.footer.templates}</a>
          <a href={GITHUB_URL} rel="noopener">
            {c.footer.github}
          </a>
          <LanguageSwitch className={s.lang} />
        </nav>
      </footer>
    </div>
  );
}
