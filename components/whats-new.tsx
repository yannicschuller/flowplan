"use client";
// "Neu in Flowplan" (#223): the curated release notes bundled with the server
// (release-notes/, lib/release-notes.ts) – never a request to the internet.
// - After an update the bootstrap carries the versions since the person last
//   saw some (boot.updateNotes.pending, lib/user-update-notes.ts): the dialog
//   opens once on the next app load, newest version first and unfolded, the
//   older ones folded; closing it in any way marks the running version as
//   seen. What it lists follows "Neuigkeiten nach Updates" (all, only
//   breaking changes, never).
// - "Was ist neu" in the account menu, the command palette and the settings
//   opens the same view with the latest versions whatever the setting
//   (releaseNotes.list).
// A bottom sheet on phones (also in the mobile apps' web view); published
// pages never show it (only the workspace app renders it).
import { useEffect, useRef, useState, type ComponentType } from "react";
import { ArrowSquareOut, Sparkle, ShieldCheck, TrendUp, Warning, Wrench, type IconProps } from "@phosphor-icons/react";
import { useLocale, useT } from "./i18n";
import { api, Modal, reportError } from "./ui";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useWhatsNewRequests } from "@/lib/update-notes-client";
import { noteText, RELEASE_NOTE_SECTIONS, type ReleaseNotes, type ReleaseNoteSection, type UpdateNotesBoot } from "@/lib/update-notes-pref";

const ISSUES = "https://github.com/yannicschuller/flowplan/issues/";
const CHANGELOG = "https://github.com/yannicschuller/flowplan/blob/main/CHANGELOG.md";

const ICONS: Record<ReleaseNoteSection, ComponentType<IconProps>> = {
  breaking: Warning,
  security: ShieldCheck,
  features: Sparkle,
  improvements: TrendUp,
  fixes: Wrench,
};

type Shown = { versions: ReleaseNotes[]; changelog: string; after: boolean } | null;

export function WhatsNew({
  notes,
  paused,
  onSeen,
}: {
  // The bootstrap's part (the level and what is pending).
  notes: UpdateNotesBoot | undefined;
  // Another dialog comes first (the introduction): wait for it.
  paused: boolean;
  onSeen: () => Promise<unknown>;
}) {
  const t = useT();
  const [shown, setShown] = useState<Shown>(null);
  // After an update: once per app load, as soon as nothing else is open.
  const offered = useRef(false);
  useEffect(() => {
    if (offered.current || paused || !notes?.pending?.length) return;
    offered.current = true;
    setShown({ versions: notes.pending, changelog: notes.changelog || CHANGELOG, after: true });
  }, [notes, paused]);
  // "Was ist neu" from a menu or the settings.
  const requests = useWhatsNewRequests();
  const handled = useRef(requests);
  useEffect(() => {
    if (requests === handled.current) return;
    handled.current = requests;
    void api<{ versions: ReleaseNotes[]; changelog: string }>("/api/command", { action: "releaseNotes.list", limit: 5 })
      .then((r) => setShown({ versions: r.versions, changelog: r.changelog || CHANGELOG, after: false }))
      .catch((e) => reportError(e));
  }, [requests]);

  const close = (then?: () => void) => {
    const wasAfter = shown?.after;
    setShown(null);
    if (wasAfter) void onSeen().catch(() => undefined);
    then?.();
  };
  if (!shown) return null;
  const breakingOnly = shown.after && notes?.level === "breaking";
  return (
    <Modal
      open
      sheet
      wide
      className="whats-new"
      title={t("Neu in Flowplan", "New in Flowplan")}
      onClose={() => close()}
    >
      {shown.after && (
        <p className="whats-new-intro">
          {breakingOnly
            ? t(
                "Flowplan wurde aktualisiert. Wie eingestellt siehst du nur die Breaking Changes – Änderungen, auf die du dich einstellen musst.",
                "Flowplan was updated. As set, you only see the breaking changes – changes you need to adapt to.",
              )
            : t("Flowplan wurde aktualisiert. Das hat sich seit deinem letzten Besuch geändert.", "Flowplan was updated. This is what changed since your last visit.")}
        </p>
      )}
      {shown.versions.length ? (
        <div className="whats-new-versions">
          {shown.versions.map((notes, index) => (
            <VersionNotes key={notes.version} notes={notes} open={index === 0} />
          ))}
        </div>
      ) : (
        <p className="whats-new-empty">{t("Für diese Version gibt es keine Versionshinweise.", "There are no release notes for this version.")}</p>
      )}
      <div className="modal-actions whats-new-actions">
        <a className="whats-new-changelog" href={shown.changelog} target="_blank" rel="noopener">
          {t("Alle Änderungen auf GitHub", "Full changelog on GitHub")}
          <ArrowSquareOut size={14} aria-hidden />
        </a>
        <button type="button" className="button" onClick={() => close(() => (location.hash = "settings/appearance/update-notes"))}>
          {t("Einstellungen", "Settings")}
        </button>
        <button type="button" className="button primary" onClick={() => close()}>
          {t("Schließen", "Close")}
        </button>
      </div>
    </Modal>
  );
}

function VersionNotes({ notes, open }: { notes: ReleaseNotes; open: boolean }) {
  const t = useT();
  const locale = useLocale();
  const titles: Record<ReleaseNoteSection, string> = {
    breaking: t("Breaking Changes", "Breaking changes"),
    security: t("Sicherheit", "Security"),
    features: t("Neu", "New"),
    improvements: t("Verbessert", "Improved"),
    fixes: t("Fehlerbehebungen", "Bug fixes"),
  };
  const date = notes.date ? new Date(`${notes.date}T12:00:00Z`).toLocaleDateString(LOCALE_TAG, { day: "numeric", month: "long", year: "numeric" }) : "";
  const breaking = !!notes.breaking?.length;
  return (
    <details className={`whats-new-version${breaking ? " has-breaking" : ""}`} open={open}>
      <summary>
        <strong>{t(`Version ${notes.version}`, `Version ${notes.version}`)}</strong>
        {date && <span className="whats-new-date">{date}</span>}
        {breaking && (
          <span className="whats-new-flag">
            <Warning size={13} weight="bold" aria-hidden /> {t("Breaking Changes", "Breaking changes")}
          </span>
        )}
      </summary>
      {RELEASE_NOTE_SECTIONS.filter((s) => notes[s]?.length).map((s) => {
        const Icon = ICONS[s];
        return (
          <section key={s} className={`whats-new-section ${s}`}>
            <h3>
              <Icon size={16} weight={s === "breaking" ? "bold" : "regular"} aria-hidden />
              {titles[s]}
            </h3>
            <ul>
              {notes[s]!.map((item, i) => (
                <li key={i}>
                  {noteText(item, locale)}
                  {item.issues?.map((n) => (
                    <a key={n} className="whats-new-issue" href={`${ISSUES}${n}`} target="_blank" rel="noopener" title={t(`Issue #${n} auf GitHub`, `Issue #${n} on GitHub`)}>
                      #{n}
                    </a>
                  ))}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </details>
  );
}
