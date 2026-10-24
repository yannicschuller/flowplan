"use client";
// The introduction after creating an account: a few settings (language,
// appearance, workspace name, e-mail summaries, push), pages to start with,
// and a short tour of what Flowplan does. Shown once (users.onboarded_at);
// Settings → General and the command palette open it again.
import { useKeyboardHints } from "@/lib/keyboard-hints";
import { useEffect, useRef, useState } from "react";
import {
  Bell,
  BookOpen,
  CheckCircle,
  CheckSquare,
  Circle,
  CircleHalf,
  CloudArrowDown,
  FileText,
  Lightning,
  MagnifyingGlass,
  Moon,
  Notebook,
  PresentationChart,
  ShareNetwork,
  Sparkle,
  Sun,
  Table,
  UsersThree,
  type Icon,
} from "@phosphor-icons/react";
import { LANGUAGES, LOCALES, isLocale, type Locale } from "@/lib/i18n";
import type { ThemeChoice } from "@/lib/theme";
import { clearLocale, setLocale, useLocale, useT } from "./i18n";
import { Modal } from "./ui";
import { Select } from "./select";
import PushSettings from "./push-settings";

type Starter = "tasks" | "notes" | "journal" | "whiteboard";
export type OnboardingBoot = {
  user: { name: string };
  workspace: { id: string; name: string; role: string; guest?: number | boolean };
  spaces: { id: string; name: string; deleted_at?: string | null }[];
  language?: Locale | null;
  instance?: { mail?: boolean };
};

const STEPS = ["welcome", "start", "tour", "notify", "done"] as const;

export function Onboarding({
  boot,
  theme,
  chooseTheme,
  mutate,
  onOpenPage,
  onClose,
}: {
  boot: OnboardingBoot;
  theme: ThemeChoice;
  chooseTheme: (choice: ThemeChoice) => void;
  mutate: (b: Record<string, unknown>) => Promise<unknown>;
  onOpenPage: (pageId: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const keyHints = useKeyboardHints();
  const locale = useLocale();
  const owner = boot.workspace.role === "owner";
  const canCreate = boot.workspace.role !== "viewer" && !boot.workspace.guest;
  const space = boot.spaces.find((s) => !s.deleted_at);
  const [step, setStep] = useState(0);
  const [name, setName] = useState(boot.workspace.name);
  const [starters, setStarters] = useState<Starter[]>([]);
  const [email, setEmail] = useState(true);
  const [feature, setFeature] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{ id: string; title: string }[]>([]);
  const docs = (slug: string) => `https://docs.flowplan.org/${locale === "de" ? "de" : "en"}/${slug}`;
  const steps = STEPS.filter((s) => s !== "start" || canCreate || owner);
  const current = steps[step];
  // Each step starts at its heading, not at the Close button: screen readers
  // hear what the step is about first.
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [step]);

  const starterInfo: Record<Starter, { icon: Icon; title: string; text: string }> = {
    tasks: { icon: CheckSquare, title: t("Aufgaben", "Tasks"), text: t("Eine Datenbank mit Status, Fälligkeit und Board-Ansicht.", "A database with status, due date and a board view.") },
    notes: { icon: FileText, title: t("Notizen", "Notes"), text: t("Eine Datenbank für Notizen und Dokumente, jede ein ganzer Text.", "A database for notes and documents, each a full text.") },
    journal: { icon: Notebook, title: "Journal", text: t("Ein Tagebuch mit einer Seite pro Tag.", "A diary with one page per day.") },
    whiteboard: { icon: PresentationChart, title: "Whiteboard", text: t("Eine freie Fläche für Skizzen und Ideen.", "An open canvas for sketches and ideas.") },
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

  const finish = async () => {
    try {
      await mutate({ action: "profile.onboarded" });
    } catch {}
    onClose();
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
            const body =
              kind === "tasks" || kind === "notes"
                ? { kind: "database", databaseKind: kind === "tasks" ? "tasks" : "documents" }
                : { kind };
            const result = (await mutate({ action: "page.create", spaceId: space.id, title: info.title, ...body })) as { id?: string } | undefined;
            if (result?.id) made.push({ id: String(result.id), title: info.title });
          }
          setCreated((list) => [...list, ...made]);
          setStarters([]);
        }
      }
      if (current === "notify" && boot.instance?.mail) await mutate({ action: "notification.email", email });
      if (current === "done") return void (await finish());
      setStep((s) => Math.min(steps.length - 1, s + 1));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const shown = features[feature];
  return (
    <Modal
      open
      wide
      className="onboarding"
      title={t("Willkommen bei Flowplan", "Welcome to Flowplan")}
      onClose={() => void finish()}
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
                  <option value="">{`🌐 ${t("Automatisch (folgt dem Browser)", "Automatic (follows the browser)")}`}</option>
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
                <p className="muted">
                  {t(`Wir legen die gewählten Seiten im Bereich „${space.name}“ an. Du kannst auch einfach leer anfangen.`, `We create the chosen pages in the space “${space.name}”. You can also simply start empty.`)}
                </p>
                <div className="onboarding-starters" role="group" aria-label={t("Seiten zum Start", "Pages to start with")}>
                  {(Object.keys(starterInfo) as Starter[]).map((kind) => {
                    const info = starterInfo[kind];
                    const on = starters.includes(kind);
                    return (
                      <button
                        key={kind}
                        type="button"
                        className="onboarding-card"
                        aria-pressed={on}
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
              </>
            )}
          </section>
        )}
        {current === "tour" && (
          <section aria-labelledby="onboarding-tour" className="onboarding-tour">
            <h2 id="onboarding-tour" tabIndex={-1} ref={heading}>{t("Das kann Flowplan", "What Flowplan does")}</h2>
            <div className="onboarding-tour-grid">
              <div role="tablist" aria-label={t("Funktionen", "Features")} aria-orientation="vertical">
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
        {current === "done" && (
          <section aria-labelledby="onboarding-done">
            <Sparkle size={30} weight="duotone" className="onboarding-mark" aria-hidden />
            <h2 id="onboarding-done" tabIndex={-1} ref={heading}>{t("Alles bereit!", "All set!")}</h2>
            {created.length > 0 && (
              <p>
                {t("Angelegt:", "Created:")}{" "}
                {created.map((page, index) => (
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
                      {page.title}
                    </button>
                  </span>
                ))}
              </p>
            )}
            {/* Shortcuts only with a keyboard (lib/keyboard-hints.ts); "/" is typed. */}
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
          <button type="button" className="text-button" disabled={busy} onClick={() => void finish()}>
            {t("Überspringen", "Skip")}
          </button>
        )}
        {step > 0 && (
          <button type="button" className="button" disabled={busy} onClick={() => setStep((s) => s - 1)}>
            {t("Zurück", "Back")}
          </button>
        )}
        <button type="button" className="button primary" disabled={busy} onClick={() => void next()}>
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
