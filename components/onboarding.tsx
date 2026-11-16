"use client";
// The introduction after creating an account: a few settings (language,
// appearance), for administrators the state of the instance (mail, SSO,
// backup, AI, HTTPS), where the person comes from – with the export guide,
// the import and the tool's terms in Flowplan –, what they use Flowplan for
// with matching pages to start with and a sample space to try things, a
// short tour and notifications. Shown once (users.onboarded_at); Settings →
// Appearance & language and the command palette open it again. Finishing
// or skipping starts the checklist "Erste Schritte" (lib/getting-started.ts).
// Loaded only when shown (components/workspace-app.tsx).
import { useKeyboardHints } from "@/lib/keyboard-hints";
import { useInFlowplanApp } from "@/lib/native-app";
import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "@/lib/motion";
import {
  Bell,
  BookOpen,
  Briefcase,
  CheckCircle,
  CheckSquare,
  Circle,
  CircleHalf,
  CloudArrowDown,
  Compass,
  FileText,
  Flask,
  GraduationCap,
  HardDrives,
  Kanban,
  Lightning,
  MagnifyingGlass,
  Moon,
  Notebook,
  PresentationChart,
  ShareNetwork,
  Sparkle,
  Sun,
  Table,
  Translate,
  User,
  UsersThree,
  type Icon,
} from "@phosphor-icons/react";
import { LANGUAGES, LOCALES, isLocale, type Locale } from "@/lib/i18n";
import type { ThemeChoice } from "@/lib/theme";
import { ONBOARDING_GOALS, type OnboardingGoal, type OnboardingSource } from "@/lib/getting-started-items";
import { STARTERS, starterCommand, startersFor, type StarterId } from "@/lib/onboarding-goals";
import { migrationSource } from "@/lib/migration-sources";
import { clearLocale, setLocale, useLocale, useT } from "./i18n";
import { Modal } from "./ui";
import { Select } from "./select";
import PushSettings from "./push-settings";
import { ImportPanel, SourcePicker, TermsTable } from "./onboarding-import";
import { AdminSetup } from "./onboarding-admin";
import { OfflineOfferPanel, useOfflineOffer } from "./offline-offer";
import { readOfferAnswer, saveOfferAnswer } from "@/lib/offline-offer";
import type { ImportOutcome } from "./import-client";
import { suggestedLevel, type SettingsLevel } from "@/lib/settings-level";
import { setOwnSettingsLevel } from "@/lib/settings-level-client";

export type OnboardingBoot = {
  user: { id: string; name: string; isAdmin?: boolean; demo?: boolean };
  workspace: { id: string; name: string; role: string; guest?: number | boolean };
  spaces: { id: string; name: string; deleted_at?: string | null }[];
  pages?: { id: string; title: string }[];
  language?: Locale | null;
  instance?: { mail?: boolean };
  sampleSpace?: { spaceId: string; name: string; pages: number; trashed: boolean } | null;
  settingsLevel?: { level: string; own: boolean };
};

const STEPS = ["welcome", "setup", "source", "terms", "start", "tour", "notify", "offline", "done"] as const;
export type OnboardingStep = (typeof STEPS)[number];

export function Onboarding({
  boot,
  theme,
  chooseTheme,
  mutate,
  refresh,
  onOpenPage,
  onOpenHash,
  onClose,
  initialStep,
}: {
  boot: OnboardingBoot;
  theme: ThemeChoice;
  chooseTheme: (choice: ThemeChoice) => void;
  mutate: (b: Record<string, unknown>) => Promise<unknown>;
  // Loads the workspace again (after an import, which is no command).
  refresh: () => Promise<unknown>;
  onOpenPage: (pageId: string) => void;
  // An address in the app (#admin/mail …), after the introduction closed.
  onOpenHash: (hash: string) => void;
  onClose: () => void;
  initialStep?: OnboardingStep;
}) {
  const t = useT();
  const keyHints = useKeyboardHints();
  // Inside the apps "automatic" follows the device, not a browser.
  const inApp = useInFlowplanApp();
  const locale = useLocale();
  const owner = boot.workspace.role === "owner";
  const canCreate = boot.workspace.role !== "viewer" && !boot.workspace.guest;
  const space = boot.spaces.find((s) => !s.deleted_at);
  const [name, setName] = useState(boot.workspace.name);
  const [goal, setGoal] = useState<OnboardingGoal | null>(null);
  const [starters, setStarters] = useState<StarterId[]>([]);
  const [source, setSource] = useState<OnboardingSource | null>(null);
  const [imported, setImported] = useState<(ImportOutcome & { source: OnboardingSource }) | null>(null);
  const [importing, setImporting] = useState(false);
  const [email, setEmail] = useState(true);
  const [feature, setFeature] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{ id: string; title: string }[]>([]);
  const docs = (slug: string) => `https://docs.flowplan.org/${locale === "de" ? "de" : "en"}/${slug}`;
  const tool = source && source !== "fresh" ? migrationSource(source) : null;
  // Offline use on this device (#295, lib/offline-offer.ts): asked here on
  // the device the introduction runs on.
  const offerOffline = useOfflineOffer(boot.user.id, !!boot.workspace.guest, !!boot.user.demo, false);
  const steps = STEPS.filter(
    (s) =>
      (s !== "setup" || !!boot.user.isAdmin) &&
      (s !== "terms" || !!tool) &&
      (s !== "start" || canCreate || owner) &&
      (s !== "offline" || !!offerOffline),
  );
  const [step, setStep] = useState(() => Math.max(0, initialStep ? steps.indexOf(initialStep) : 0));
  const current = steps[step];
  // Each step starts at its heading, not at the Close button: screen readers
  // hear what the step is about first.
  const heading = useRef<HTMLHeadingElement>(null);
  // "Das kann Flowplan": on phones the feature tabs are one row that scrolls
  // sideways; the chosen one ("Nächste Funktion") scrolls into view – the
  // row only, not the dialog around it.
  const featureTabs = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = featureTabs.current;
    const tab = list?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (!list || !tab || list.scrollWidth <= list.clientWidth) return;
    const row = list.getBoundingClientRect(),
      box = tab.getBoundingClientRect();
    if (box.left >= row.left && box.right <= row.right) return;
    list.scrollTo({ left: list.scrollLeft + box.left - row.left - (row.width - box.width) / 2, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [feature, current]);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [step]);
  const sample = boot.sampleSpace && !boot.sampleSpace.trashed ? boot.sampleSpace : null;

  const starterInfo: Record<StarterId, { icon: Icon; title: string; text: string }> = {
    tasks: { icon: CheckSquare, title: t("Aufgaben", "Tasks"), text: t("Eine Datenbank mit Status, Fälligkeit und Board-Ansicht.", "A database with status, due date and a board view.") },
    notes: { icon: FileText, title: t("Notizen", "Notes"), text: t("Eine Datenbank für Notizen und Dokumente, jede ein ganzer Text.", "A database for notes and documents, each a full text.") },
    journal: { icon: Notebook, title: "Journal", text: t("Ein Tagebuch mit einer Seite pro Tag.", "A diary with one page per day.") },
    whiteboard: { icon: PresentationChart, title: "Whiteboard", text: t("Eine freie Fläche für Skizzen und Ideen.", "An open canvas for sketches and ideas.") },
    todo: { icon: CheckSquare, title: t("Aufgabenliste", "Task list"), text: t("Persönliche Aufgaben mit Priorität, Fälligkeit, Board und Kalender.", "Personal tasks with priority, due date, board and calendar.") },
    habits: { icon: Sparkle, title: t("Gewohnheiten-Tracker", "Habit tracker"), text: t("Ein Eintrag pro Tag, Gewohnheiten abhaken und den Anteil sehen.", "One record per day: tick off habits and see the share.") },
    reading: { icon: BookOpen, title: t("Leseliste", "Reading list"), text: t("Bücher und Artikel mit Status, Bewertung und Notizen – als Galerie.", "Books and articles with status, rating and notes – as a gallery.") },
    wiki: { icon: BookOpen, title: t("Team-Wiki", "Team wiki"), text: t("Startseite für Wissen, Abläufe und Ansprechpersonen eines Teams.", "Home page for a team's knowledge, processes and contacts.") },
    meetingLog: { icon: UsersThree, title: t("Besprechungsprotokolle", "Meeting log"), text: t("Alle Besprechungen als Datenbank – mit Kalender und Protokoll je Termin.", "All meetings as a database – with a calendar and minutes per date.") },
    decisions: { icon: Table, title: t("Entscheidungsprotokoll", "Decision log"), text: t("Wichtige Entscheidungen mit Begründung, Status und Datum nachvollziehbar sammeln.", "Collect important decisions with reasons, status and date so they stay traceable.") },
    project: { icon: Briefcase, title: t("Projektplanung", "Project plan"), text: t("Aufgaben mit Status, Zeitraum, Aufwand und Timeline für ein Projekt.", "Tasks with status, period, effort and a timeline for one project.") },
    sprint: { icon: Kanban, title: t("Sprint-Board", "Sprint board"), text: t("Kanban für zweiwöchige Sprints mit Story Points und Verantwortlichen.", "Kanban for two-week sprints with story points and assignees.") },
    roadmap: { icon: Compass, title: t("Produkt-Roadmap", "Product roadmap"), text: t("Themen nach Quartal und Status, mit Board und Timeline für die Planung.", "Topics by quarter and status, with a board and a timeline for planning.") },
    brief: { icon: FileText, title: t("Projektsteckbrief", "Project brief"), text: t("Ziel, Umfang, Beteiligte und Risiken eines Projekts auf einer Seite.", "Goal, scope, people and risks of a project on one page.") },
  };
  const goals: Record<OnboardingGoal, { icon: Icon; title: string }> = {
    personal: { icon: User, title: t("Persönlich", "Personal") },
    team: { icon: UsersThree, title: t("Team & Wissen", "Team & knowledge") },
    projects: { icon: Kanban, title: t("Projekte & Tickets", "Projects & tickets") },
    study: { icon: GraduationCap, title: t("Studium & Schreiben", "Study & writing") },
    other: { icon: Circle, title: t("Etwas anderes", "Something else") },
  };
  const features: { icon: Icon; title: string; text: string; tip: string; slug: string }[] = [
    {
      icon: FileText,
      title: t("Seiten und Blöcke", "Pages and blocks"),
      text: t("Schreibe in Seiten mit Überschriften, Listen, Tabellen, Bildern, Formeln und Diagrammen. Seiten lassen sich beliebig verschachteln.", "Write in pages with headings, lists, tables, images, formulas and diagrams. Pages nest as deep as you like."),
      tip: t("Tippe / in einer Seite für alle Blöcke.", "Type / in a page for all blocks."),
      slug: "documents",
    },
    {
      icon: Table,
      title: t("Datenbanken und Ansichten", "Databases and views"),
      text: t("Tabelle, Board, Kalender, Galerie und Zeitleiste – mit Eigenschaften, Formeln, Beziehungen und Filtern. Jeder Eintrag ist auch eine Seite.", "Table, board, calendar, gallery and timeline – with properties, formulas, relations and filters. Every record is also a page."),
      tip: t("Einträge per Markdown importieren und exportieren.", "Import and export records as Markdown."),
      slug: "databases",
    },
    {
      icon: PresentationChart,
      title: "Whiteboards",
      text: t("Formen, Notizzettel, Verbindungen und Freihand – gemeinsam und live.", "Shapes, sticky notes, connectors and freehand – together and live."),
      tip: t("Seiten lassen sich als Karte aufs Whiteboard ziehen.", "Drag pages onto the whiteboard as cards."),
      slug: "whiteboards",
    },
    {
      icon: BookOpen,
      title: "Journal",
      text: t("Eine Seite pro Tag mit Vorlage, Stimmung, Gewohnheiten und Kalender – auf Wunsch mit PIN.", "One page per day with a template, mood, habits and calendar – with a PIN if you like."),
      tip: t("Sprachnotizen werden auf dem Server in Text umgewandelt, wenn eingerichtet.", "Voice notes become text on the server, when set up."),
      slug: "journal",
    },
    {
      icon: UsersThree,
      title: t("Zusammenarbeit", "Collaboration"),
      text: t("Gemeinsam schreiben mit Cursorn, Kommentare, @-Erwähnungen, Änderungsvorschläge und ein Posteingang für alles, was dich betrifft.", "Write together with cursors, comments, @mentions, suggested changes and an inbox for everything that concerns you."),
      tip: t("Mit @ erwähnst du Personen, Seiten und Daten.", "@ mentions people, pages and dates."),
      slug: "collaboration",
    },
    {
      icon: ShareNetwork,
      title: t("Teilen und Rechte", "Sharing and permissions"),
      text: t("Bereiche für Teams oder privat, Rechte bis auf den einzelnen Eintrag, Freigabelinks, Gäste und veröffentlichte Seiten.", "Spaces for teams or private, permissions down to a single record, share links, guests and published pages."),
      tip: t("Einzelne Einträge einer Datenbank lassen sich privat stellen.", "Single records of a database can be made private."),
      slug: "sharing",
    },
    {
      icon: MagnifyingGlass,
      title: t("Suchen und erfassen", "Search and capture"),
      text: t("Volltextsuche über alles, auch in PDFs und Bildern. Schnellerfassung landet direkt in einer Datenbank deiner Wahl.", "Full-text search across everything, also in PDFs and images. Quick capture lands right in a database of your choice."),
      tip:
        keyHints.action("search") && keyHints.action("capture")
          ? t(`${keyHints.action("search")} sucht, ${keyHints.action("capture")} erfasst.`, `${keyHints.action("search")} searches, ${keyHints.action("capture")} captures.`)
          : t("Die Suche in der Seitenleiste findet alles, auch Text in PDFs.", "The search in the sidebar finds everything, text in PDFs too."),
      slug: "search-and-notifications",
    },
    {
      icon: CloudArrowDown,
      title: t("Offline und Apps", "Offline and apps"),
      text: t("Als App installierbar, Desktop-Apps für macOS, Windows und Linux, auf Wunsch offline nutzbar.", "Installable as an app, desktop apps for macOS, Windows and Linux, usable offline on request."),
      tip: t("Offline schaltest du je Gerät unter Einstellungen → Offline & Geräte ein.", "Turn offline on per device under Settings → Offline & devices."),
      slug: "offline-and-apps",
    },
  ];

  const levelFor = (g: OnboardingGoal | null): SettingsLevel | null =>
    g && g !== "other" && !boot.user.demo && !boot.settingsLevel?.own ? suggestedLevel(g) : null;
  const levelNames: Record<SettingsLevel, string> = {
    beginner: t("Einsteiger", "Beginner"),
    normal: t("Normal", "Normal"),
    expert: t("Experte", "Expert"),
  };
  const suggested = levelFor(goal);

  // Ends the introduction and starts "Erste Schritte" with the answers
  // (not when only the instance's setup was opened from the command palette).
  const finish = async () => {
    try {
      if (!boot.user.demo && initialStep !== "setup") await mutate({ action: "gettingStarted.start", goal, source, imported: !!imported });
    } catch {}
    try {
      await mutate({ action: "profile.onboarded" });
    } catch {}
    onClose();
  };
  const leaveTo = async (hash: string) => {
    await finish();
    onOpenHash(hash);
  };
  // Settings of a step are saved when going on, so skipping keeps what was set.
  const next = async () => {
    setBusy(true);
    setError("");
    try {
      if (current === "start") {
        if (owner && name.trim() && name.trim() !== boot.workspace.name) await mutate({ action: "workspace.update", name: name.trim() });
        if (space && canCreate) {
          const made: { id: string; title: string }[] = [];
          for (const kind of starters) {
            const info = starterInfo[kind];
            const result = (await mutate(starterCommand(kind, space.id, info.title))) as { id?: string } | undefined;
            if (result?.id) made.push({ id: String(result.id), title: info.title });
          }
          setCreated((list) => [...list, ...made]);
          setStarters([]);
        }
        // The goal suggests a settings level (#294) – only for someone who
        // has none of their own yet; "Sonstiges" keeps the instance default.
        const level = levelFor(goal);
        if (level) await setOwnSettingsLevel(mutate, level);
      }
      if (current === "notify" && boot.instance?.mail) await mutate({ action: "notification.email", email });
      // Going on without an answer: the card asks again on this device in a week.
      if (current === "offline" && !readOfferAnswer()) saveOfferAnswer("later");
      if (current === "done") return void (await finish());
      setStep((s) => Math.min(steps.length - 1, s + 1));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const toggleSample = async () => {
    setBusy(true);
    setError("");
    try {
      await mutate({ action: sample ? "sample.remove" : "sample.create" });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const offered = startersFor(goal);
  const title = (id: string, fallback: string) => boot.pages?.find((p) => p.id === id)?.title || fallback;
  const importedPages = imported ? imported.rootIds.slice(0, 5).map((id) => ({ id, title: title(id, t("Importierte Seite", "Imported page")) })) : [];
  const shown = features[feature];
  const stopped = busy || importing;
  return (
    <Modal
      open
      wide
      className="onboarding"
      title={t("Willkommen bei Flowplan", "Welcome to Flowplan")}
      onClose={() => !importing && void finish()}
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        heading.current?.focus({ preventScroll: true });
      }}
    >
      <ol className="onboarding-steps" aria-label={t("Schritte", "Steps")}>
        {steps.map((s, index) => (
          <li key={s} aria-current={index === step ? "step" : undefined} data-done={index < step || undefined}>
            <span className="sr-only">{t(`Schritt ${index + 1} von ${steps.length}`, `Step ${index + 1} of ${steps.length}`)}</span>
          </li>
        ))}
      </ol>
      <div className="onboarding-body">
        {current === "welcome" && (
          <section aria-labelledby="onboarding-welcome">
            <Sparkle size={30} weight="duotone" className="onboarding-mark" aria-hidden />
            <h2 id="onboarding-welcome" tabIndex={-1} ref={heading}>{t(`Hallo ${boot.user.name.split(" ")[0]}!`, `Hello ${boot.user.name.split(" ")[0]}!`)}</h2>
            <p>
              {t(
                "Flowplan ist dein Ort für Dokumente, Datenbanken, Whiteboards und ein Journal – in einem Seitenbaum, gemeinsam und live. In zwei Minuten richten wir das Wichtigste ein; alles lässt sich später in den Einstellungen ändern.",
                "Flowplan is your place for documents, databases, whiteboards and a journal – in one page tree, together and live. Let's set up the essentials in two minutes; everything can be changed later in the settings.",
              )}
            </p>
            <div className="onboarding-fields">
              <label>
                {t("Sprache", "Language")}
                <Select
                  aria-label={t("Sprache", "Language")}
                  value={boot.language ?? ""}
                  onChange={async (e) => {
                    const value = isLocale(e.target.value) ? e.target.value : null;
                    try {
                      await mutate({ action: "profile.language", language: value });
                      if (value) setLocale(value);
                      else clearLocale();
                    } catch (err) {
                      setError((err as Error).message);
                    }
                  }}
                >
                  <option value="">{`🌐 ${inApp ? t("Automatisch (folgt dem Gerät)", "Automatic (follows the device)") : t("Automatisch (folgt dem Browser)", "Automatic (follows the browser)")}`}</option>
                  {LOCALES.map((l) => (
                    <option key={l} value={l} lang={l}>{`${LANGUAGES[l].flag} ${LANGUAGES[l].name}`}</option>
                  ))}
                </Select>
              </label>
              <div>
                <span className="onboarding-label">{t("Erscheinungsbild", "Appearance")}</span>
                <div className="segmented" role="radiogroup" aria-label={t("Erscheinungsbild", "Appearance")}>
                  {(
                    [
                      ["system", CircleHalf, t("Automatisch", "Automatic")],
                      ["light", Sun, t("Hell", "Light")],
                      ["dark", Moon, t("Dunkel", "Dark")],
                    ] as const
                  ).map(([value, Glyph, label]) => (
                    <label key={value} data-active={theme === value}>
                      <input type="radio" name="onboarding-theme" checked={theme === value} onChange={() => chooseTheme(value)} />
                      <Glyph size={15} aria-hidden /> {label}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          </section>
        )}
        {current === "setup" && (
          <section aria-labelledby="onboarding-setup">
            <HardDrives size={28} weight="duotone" className="onboarding-mark" aria-hidden />
            <h2 id="onboarding-setup" tabIndex={-1} ref={heading}>{t("Instanz einrichten", "Set up the instance")}</h2>
            <p>
              {t(
                "Du bist Administrator. So steht es um die Grundlagen dieser Instanz – Rot zuerst angehen, Gelb ist optional oder einen Blick wert. Diese Übersicht findest du wieder über die Befehlspalette („Instanz einrichten“).",
                "You are an administrator. This is where the basics of this instance stand – tackle red first, yellow is optional or worth a look. You find this overview again in the command palette (“Set up the instance”).",
              )}
            </p>
            <AdminSetup onOpenSection={(hash) => void leaveTo(hash)} />
          </section>
        )}
        {current === "source" && (
          <section aria-labelledby="onboarding-source">
            <Translate size={28} weight="duotone" className="onboarding-mark" aria-hidden />
            <h2 id="onboarding-source" tabIndex={-1} ref={heading}>{t("Woher kommst du?", "Where are you coming from?")}</h2>
            <p>
              {t(
                "Wenn du schon Inhalte in einem anderen Werkzeug hast, nimm sie gleich mit: Wir zeigen dir, wo der Export steckt, und importieren ihn. Sonst fang einfach neu an.",
                "If you already have content in another tool, bring it along right away: we show you where the export is and import it. Otherwise just start fresh.",
              )}
            </p>
            <SourcePicker value={source} disabled={importing} onChange={setSource} />
            {tool && (
              <ImportPanel
                key={tool.id}
                source={tool}
                workspaceId={boot.workspace.id}
                space={space}
                canWrite={canCreate}
                imported={imported}
                onBusy={setImporting}
                onImported={async (result) => {
                  setImported(result);
                  await refresh().catch(() => {});
                }}
              />
            )}
          </section>
        )}
        {current === "terms" && tool && (
          <section aria-labelledby="onboarding-terms">
            <h2 id="onboarding-terms" tabIndex={-1} ref={heading}>{t("So heißt das hier", "What it's called here")}</h2>
            <p>{t(`Was du aus ${tool.name} kennst – und wie es in Flowplan heißt.`, `What you know from ${tool.name} – and what it is called in Flowplan.`)}</p>
            <TermsTable source={tool.id} />
          </section>
        )}
        {current === "start" && (
          <section aria-labelledby="onboarding-start">
            <h2 id="onboarding-start" tabIndex={-1} ref={heading}>{t("Womit möchtest du starten?", "What would you like to start with?")}</h2>
            {owner && (
              <label className="onboarding-name">
                {t("Name deines Arbeitsbereichs", "Name of your workspace")}
                <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder={t("z. B. Familie, Team, Verein", "e.g. Family, Team, Club")} />
              </label>
            )}
            {space && canCreate && (
              <>
                <span className="onboarding-label" id="onboarding-goal-label">{t("Wofür nutzt du Flowplan vor allem?", "What do you mainly use Flowplan for?")}</span>
                <div className="segmented onboarding-goals" role="radiogroup" aria-labelledby="onboarding-goal-label">
                  {ONBOARDING_GOALS.map((g) => {
                    const Glyph = goals[g].icon;
                    return (
                      <label key={g} data-active={goal === g}>
                        <input
                          type="radio"
                          name="onboarding-goal"
                          checked={goal === g}
                          onChange={() => {
                            setGoal(g);
                            // Choices that the new proposal still has stay chosen.
                            setStarters((list) => list.filter((k) => startersFor(g).includes(k)));
                          }}
                        />
                        <Glyph size={15} aria-hidden /> {goals[g].title}
                      </label>
                    );
                  })}
                </div>
                {suggested && (
                  <p className="muted onboarding-level-hint">
                    {t(
                      `Die Einstellungen zeigen dir danach die Stufe „${levelNames[suggested]}“. Mehr Einstellungen bekommst du jederzeit oben in den Einstellungen.`,
                      `Settings then show you the level “${levelNames[suggested]}”. You can switch to more settings any time at the top of Settings.`,
                    )}
                  </p>
                )}
                <p className="muted">
                  {t(`Wir legen die gewählten Seiten im Bereich „${space.name}“ an. Du kannst auch einfach leer anfangen.`, `We create the chosen pages in the space “${space.name}”. You can also simply start empty.`)}
                </p>
                <div className="onboarding-starters" role="group" aria-label={t("Seiten zum Start", "Pages to start with")}>
                  {offered.map((kind) => {
                    const info = starterInfo[kind];
                    const on = starters.includes(kind);
                    return (
                      <button
                        key={kind}
                        type="button"
                        className="onboarding-card"
                        aria-pressed={on}
                        data-template={STARTERS[kind].template ? "" : undefined}
                        onClick={() => setStarters((list) => (on ? list.filter((k) => k !== kind) : [...list, kind]))}
                      >
                        <info.icon size={22} weight={on ? "fill" : "regular"} aria-hidden />
                        <strong>{info.title}</strong>
                        <small>{info.text}</small>
                        {/* The cards are a multiple choice: the corner says so
                            before the first click. */}
                        <span className="onboarding-check" aria-hidden>
                          {on ? <CheckCircle size={20} weight="fill" /> : <Circle size={20} />}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {!boot.user.demo && (
                  <div className="onboarding-sample">
                    <Flask size={22} weight="duotone" aria-hidden />
                    <span>
                      <strong>{sample ? t(`„${sample.name}“ ist angelegt`, `“${sample.name}” is ready`) : t("Erst einmal ausprobieren?", "Try things out first?")}</strong>
                      <small>
                        {sample
                          ? t("Ein privater Bereich mit Beispielseiten. Entfernen nimmt genau diese Seiten wieder heraus.", "A private space with sample pages. Removing takes out exactly these pages again.")
                          : t("Ein privater Beispielbereich mit Projekt, Wiki, Besprechungsnotiz und Whiteboard – mit einem Klick wieder entfernt.", "A private sample space with a project, a wiki, a meeting note and a whiteboard – removed again with one click.")}
                      </small>
                    </span>
                    <button type="button" className="button compact" disabled={busy} onClick={() => void toggleSample()}>
                      {sample ? t("Beispielbereich entfernen", "Remove sample space") : t("Beispielbereich anlegen", "Create sample space")}
                    </button>
                  </div>
                )}
              </>
            )}
          </section>
        )}
        {current === "tour" && (
          <section aria-labelledby="onboarding-tour" className="onboarding-tour">
            <h2 id="onboarding-tour" tabIndex={-1} ref={heading}>{t("Das kann Flowplan", "What Flowplan does")}</h2>
            <div className="onboarding-tour-grid">
              <div role="tablist" aria-label={t("Funktionen", "Features")} aria-orientation="vertical" ref={featureTabs}>
                {features.map((f, index) => (
                  <button
                    key={f.slug}
                    type="button"
                    role="tab"
                    aria-selected={index === feature}
                    aria-controls="onboarding-feature"
                    onClick={() => setFeature(index)}
                  >
                    <f.icon size={18} aria-hidden /> {f.title}
                  </button>
                ))}
              </div>
              <div id="onboarding-feature" role="tabpanel" className="onboarding-feature" aria-live="polite">
                <shown.icon size={34} weight="duotone" aria-hidden />
                <h3>{shown.title}</h3>
                <p>{shown.text}</p>
                <p className="onboarding-tip">
                  <Lightning size={15} weight="fill" aria-hidden /> {shown.tip}
                </p>
                <div className="onboarding-feature-actions">
                  <a href={docs(shown.slug)} target="_blank" rel="noreferrer">
                    {t("Mehr in der Dokumentation", "More in the documentation")}
                  </a>
                  <span className="muted small">
                    {feature + 1} / {features.length}
                  </span>
                  {feature < features.length - 1 && (
                    <button type="button" className="button compact" onClick={() => setFeature((f) => f + 1)}>
                      {t("Nächste Funktion", "Next feature")}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </section>
        )}
        {current === "notify" && (
          <section aria-labelledby="onboarding-notify">
            <Bell size={28} weight="duotone" className="onboarding-mark" aria-hidden />
            <h2 id="onboarding-notify" tabIndex={-1} ref={heading}>{t("Wie möchtest du benachrichtigt werden?", "How would you like to be notified?")}</h2>
            <p className="muted">
              {t(
                "Erwähnungen, Kommentare, Fälligkeiten und Einladungen landen immer im Posteingang. Je Art lässt sich das später unter Einstellungen → Benachrichtigungen genauer einstellen.",
                "Mentions, comments, due dates and invitations always land in the inbox. You can fine-tune this per kind later under Settings → Notifications.",
              )}
            </p>
            {boot.instance?.mail && (
              <label className="checkbox-label onboarding-email">
                <input type="checkbox" checked={email} onChange={(e) => setEmail(e.target.checked)} />
                <span>
                  {t("E-Mail-Zusammenfassung ungelesener Benachrichtigungen", "E-mail summary of unread notifications")}
                  <small>{t("Kommt nur, wenn du etwas verpasst hast.", "Only arrives when you missed something.")}</small>
                </span>
              </label>
            )}
            <div className="onboarding-push">
              <PushSettings />
            </div>
          </section>
        )}
        {current === "offline" && (
          <section aria-labelledby="onboarding-offline">
            <CloudArrowDown size={28} weight="duotone" className="onboarding-mark" aria-hidden />
            <h2 id="onboarding-offline" tabIndex={-1} ref={heading}>{t("Auch ohne Verbindung arbeiten?", "Work without a connection too?")}</h2>
            <OfflineOfferPanel
              userId={boot.user.id}
              workspaceId={boot.workspace.id}
              headingId="onboarding-offline"
              onAnswered={(answer) => {
                if (answer !== "enabled") setStep((s) => Math.min(steps.length - 1, s + 1));
              }}
            />
          </section>
        )}
        {current === "done" && (
          <section aria-labelledby="onboarding-done">
            <Sparkle size={30} weight="duotone" className="onboarding-mark" aria-hidden />
            <h2 id="onboarding-done" tabIndex={-1} ref={heading}>{t("Alles bereit!", "All set!")}</h2>
            {[...created, ...importedPages].length > 0 && (
              <p>
                {t("Angelegt:", "Created:")}{" "}
                {[...created, ...importedPages].map((page, index) => (
                  <span key={page.id}>
                    {index > 0 && ", "}
                    <button
                      type="button"
                      className="text-button"
                      onClick={async () => {
                        await finish();
                        onOpenPage(page.id);
                      }}
                    >
                      {title(page.id, page.title)}
                    </button>
                  </span>
                ))}
              </p>
            )}
            {!boot.user.demo && (
              <p className="onboarding-next">
                <CheckSquare size={18} aria-hidden />
                <span>
                  {t(
                    "In der Seitenleiste wartet die Liste „Erste Schritte“: Sie hakt sich selbst ab, wenn du etwas davon erledigt hast, und lässt sich ausblenden.",
                    "The “Getting started” list waits in the sidebar: it ticks itself off as you do things, and can be hidden.",
                  )}
                </span>
              </p>
            )}
            {/* Shortcuts only with a keyboard (lib/keyboard-hints.ts); "/" is
                typed, but alone (a phone without a keyboard) it is no list. */}
            {(keyHints.action("search") || keyHints.action("capture")) && (
            <ul className="onboarding-keys">
              {keyHints.action("search") && (
                <li>
                  <kbd>{keyHints.action("search")}</kbd> {t("Suchen und Befehle", "Search and commands")}
                </li>
              )}
              <li>
                <code>/</code> {t("Blöcke in einer Seite", "Blocks in a page")}
              </li>
              {keyHints.action("capture") && (
                <li>
                  <kbd>{keyHints.action("capture")}</kbd> {t("Schnell erfassen", "Quick capture")}
                </li>
              )}
            </ul>
            )}
            <p className="muted">
              {t("Diese Einführung findest du wieder unter Einstellungen → Darstellung & Sprache.", "You find this introduction again under Settings → Appearance & language.")}
            </p>
          </section>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </div>
      <div className="modal-actions onboarding-actions">
        {current !== "done" && (
          <button type="button" className="text-button" disabled={stopped} onClick={() => void finish()}>
            {t("Überspringen", "Skip")}
          </button>
        )}
        {step > 0 && (
          <button type="button" className="button" disabled={stopped} onClick={() => setStep((s) => s - 1)}>
            {t("Zurück", "Back")}
          </button>
        )}
        <button type="button" className="button primary" disabled={stopped} onClick={() => void next()}>
          {current === "done"
            ? t("Los geht's", "Let's go")
            : current === "start" && starters.length
              ? t(`${starters.length} anlegen und weiter`, `Create ${starters.length} and continue`)
              : t("Weiter", "Continue")}
        </button>
      </div>
    </Modal>
  );
}
