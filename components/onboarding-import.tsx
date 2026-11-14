"use client";
// The introduction's move from another tool (components/onboarding.tsx):
// "Woher kommst du?" with where to find the export in that tool, a file
// picker and the import into the person's first space (the existing
// imports, components/import-client.ts), and "So heißt das hier" – the
// tool's terms and Flowplan's (lib/migration-glossary.ts).
import { useRef, useState } from "react";
import { ArrowRight, CheckCircle, Equals, Minus, Sparkle, UploadSimple, WarningCircle } from "@phosphor-icons/react";
import { MIGRATION_SOURCES, migrationSource, type MigrationSource } from "@/lib/migration-sources";
import { MIGRATION_GLOSSARY, SHARED_HABITS, type GlossaryEntry } from "@/lib/migration-glossary";
import type { OnboardingSource } from "@/lib/getting-started-items";
import { importSourceFile, importZipFile, type ImportOutcome, type ImportProgress } from "./import-client";
import { useT } from "./i18n";

export function SourcePicker({ value, disabled, onChange }: { value: OnboardingSource | null; disabled?: boolean; onChange: (source: OnboardingSource) => void }) {
  const t = useT();
  const options: { id: OnboardingSource; name: string }[] = [...MIGRATION_SOURCES.map((s) => ({ id: s.id, name: s.name })), { id: "fresh", name: t("Neu anfangen", "Start fresh") }];
  return (
    <div className="onboarding-sources" role="radiogroup" aria-label={t("Woher kommst du?", "Where are you coming from?")}>
      {options.map((o) => (
        <label key={o.id} className="onboarding-source" data-active={value === o.id || undefined} data-fresh={o.id === "fresh" || undefined}>
          <input type="radio" name="onboarding-source" value={o.id} checked={value === o.id} disabled={disabled} onChange={() => onChange(o.id)} />
          {o.id === "fresh" && <Sparkle size={16} aria-hidden />}
          <span>{o.name}</span>
        </label>
      ))}
    </div>
  );
}

type Imported = ImportOutcome & { source: OnboardingSource };

// Where the export is, the file and the import with its progress.
export function ImportPanel({
  source,
  workspaceId,
  space,
  canWrite,
  imported,
  onBusy,
  onImported,
}: {
  source: MigrationSource;
  workspaceId: string;
  space: { id: string; name: string } | undefined;
  canWrite: boolean;
  imported: Imported | null;
  onBusy: (busy: boolean) => void;
  onImported: (result: Imported) => Promise<void> | void;
}) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [error, setError] = useState("");
  const run = async (file: File) => {
    if (!space) return;
    setError("");
    onBusy(true);
    try {
      let result: ImportOutcome;
      // One branch per kind of route (lib/migration-sources.ts). A source
      // without a file – the Notion API import with a token – adds its kind
      // there and renders its own panel instead of the file picker below.
      switch (source.route.kind) {
        case "zip":
          result = await importZipFile({ workspaceId, spaceId: space.id, file }, setProgress);
          break;
        case "source":
          result = await importSourceFile({ workspaceId, spaceId: space.id, source: source.route.source, file }, setProgress);
          break;
      }
      await onImported({ ...result, source: source.id });
    } catch (e) {
      const message = (e as Error).message;
      setError(message === "network" ? t("Keine Verbindung zum Server.", "No connection to the server.") : message || t("Import fehlgeschlagen.", "Import failed."));
    } finally {
      setProgress(null);
      onBusy(false);
    }
  };
  const busy = !!progress;
  const done = imported?.source === source.id ? imported : null;
  return (
    <section className="onboarding-guide" aria-labelledby="onboarding-guide-title">
      <h3 id="onboarding-guide-title">{t(`So kommst du an deinen Export aus ${source.name}`, `How to get your export from ${source.name}`)}</h3>
      <ol className="onboarding-guide-steps">
        {source.steps.map((step) => (
          <li key={step.en}>{t(step.de, step.en)}</li>
        ))}
      </ol>
      <p className="onboarding-guide-file">
        <ArrowRight size={15} aria-hidden /> <span>{t(source.file.de, source.file.en)}</span>
      </p>
      {canWrite && space ? (
        <div className="onboarding-import-row">
          <button type="button" className="button primary" disabled={busy} onClick={() => input.current?.click()}>
            <UploadSimple size={16} aria-hidden /> {done ? t("Weitere Datei importieren", "Import another file") : t("Datei auswählen und importieren", "Choose file and import")}
          </button>
          <span className="muted small">{t(`Ziel: Bereich „${space.name}“`, `Into the space “${space.name}”`)}</span>
          <input
            ref={input}
            type="file"
            hidden
            accept={source.accept}
            aria-label={t(`Export aus ${source.name} importieren`, `Import export from ${source.name}`)}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void run(file);
            }}
          />
        </div>
      ) : (
        <p className="muted">{t("Importieren dürfen nur Mitglieder mit Bearbeitungsrechten. Du kannst diesen Schritt überspringen.", "Only members who may edit can import. You can skip this step.")}</p>
      )}
      {progress && (
        <div className="import-sources-progress" role="status">
          <progress max={1} value={progress.share ?? undefined} />
          <span>
            {progress.phase === "upload"
              ? t(`Hochladen … ${Math.round((progress.share || 0) * 100)} %`, `Uploading … ${Math.round((progress.share || 0) * 100)} %`)
              : progress.share
                ? t(`Wird verarbeitet … ${Math.round(progress.share * 100)} %`, `Processing … ${Math.round(progress.share * 100)} %`)
                : t("Wird verarbeitet …", "Processing …")}
          </span>
        </div>
      )}
      {done && !busy && (
        <p className="onboarding-import-done" role="status">
          <CheckCircle size={18} weight="fill" aria-hidden />
          <span>
            {t(
              `${done.pages} Seiten, ${done.rows} Datenbankeinträge und ${done.files} Dateien importiert.`,
              `${done.pages} pages, ${done.rows} database records and ${done.files} files imported.`,
            )}
          </span>
        </p>
      )}
      {error && (
        <p className="onboarding-import-error" role="alert">
          <WarningCircle size={18} aria-hidden /> <span>{error}</span>
        </p>
      )}
      <p className="muted small">
        {t("Du kannst auch später importieren: Einstellungen → Import & Export.", "You can also import later: Settings → Import & Export.")}
      </p>
    </section>
  );
}

const MARK = { same: Equals, similar: ArrowRight, none: Minus } as const;

export function TermsTable({ source }: { source: Exclude<OnboardingSource, "fresh"> }) {
  const t = useT();
  const tool = migrationSource(source)!;
  const entries: GlossaryEntry[] = MIGRATION_GLOSSARY[tool.glossary ?? tool.id];
  const label = { same: t("gleich", "the same"), similar: t("ähnlich", "similar"), none: t("keine Entsprechung", "no counterpart") };
  return (
    <>
      <div className="onboarding-terms-wrap">
        <table className="onboarding-terms">
          <caption className="sr-only">{t(`Begriffe aus ${tool.name} und in Flowplan`, `Terms in ${tool.name} and in Flowplan`)}</caption>
          <thead>
            <tr>
              <th scope="col">{tool.name}</th>
              <th scope="col">
                <span className="sr-only">{t("Entspricht", "Matches")}</span>
              </th>
              <th scope="col">Flowplan</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const Mark = MARK[entry.match];
              return (
                <tr key={entry.theirs} data-match={entry.match}>
                  <th scope="row">{entry.theirs}</th>
                  <td className="onboarding-terms-mark">
                    <Mark size={14} aria-hidden />
                    <span className="sr-only">{label[entry.match]}</span>
                  </td>
                  <td>
                    <strong>{entry.ours ? t(entry.ours.de, entry.ours.en) : t("Gibt es nicht", "Not available")}</strong>
                    {entry.note && <small>{t(entry.note.de, entry.note.en)}</small>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ul className="onboarding-habits">
        {SHARED_HABITS.map((habit) => (
          <li key={habit.en}>{t(habit.de, habit.en)}</li>
        ))}
      </ul>
    </>
  );
}
