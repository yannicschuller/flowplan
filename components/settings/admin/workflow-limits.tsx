"use client";
// Administration → Grenzen & Aufbewahrung → Workflows (docs/specs/workflows.md
// §12): the main switch and the limits of wave 1. Stored values take
// precedence, empty follows the environment (its value is the placeholder);
// beside them the current load (monitoring counters).
import { useCallback, useEffect, useId, useState } from "react";
import { useT } from "../../i18n";
import { api, reportError } from "../../ui";
import { SaveState, SettingGroup, SettingRow, Switch, useSaveState } from "../../settings-ui";
import { NumberInput } from "./parts";

type Limits = Record<string, number | boolean | string[]>;
type Answer = {
  limits: Limits;
  stored: Record<string, number | boolean | null | undefined>;
  defaults: Limits;
  monitoring: { activeWorkflows: number; runsPerMinute: number; queuedSteps: number; runningSteps: number; waitingSteps: number; failureRate: number; undispatchedEvents: number };
};

// i18n-table: 2 4 – [key, German, English, German help, English help, min, max, unit]
const NUMBERS: [string, string, string, string, string, number, number, string][] = [
  ["runsPerMinute", "Läufe je Minute und Workflow", "Runs per minute and workflow", "Mehr Ereignisse warten; ein Workflow kann eine niedrigere Grenze setzen.", "Further events wait; a workflow can set a lower limit.", 1, 1000, ""],
  ["workspaceRunsPerMinute", "Läufe je Minute und Arbeitsbereich", "Runs per minute and workspace", "Alle Workflows eines Arbeitsbereichs zusammen.", "All workflows of a workspace together.", 1, 10000, ""],
  ["stepsPerRun", "Schritte je Lauf", "Steps per run", "Danach endet ein Lauf als Fehler.", "A run ends as failed after that.", 10, 2000, ""],
  ["cascadeDepth", "Tiefe gegenseitiger Auslösung", "Depth of workflows triggering each other", "Wie oft ein Workflow einen anderen auslösen darf, bevor die Kette stoppt.", "How often a workflow may trigger another before the chain stops.", 1, 10, ""],
  ["activePerWorkspace", "Aktive Workflows je Arbeitsbereich", "Active workflows per workspace", "", "", 1, 10000, ""],
  ["parallelRuns", "Gleichzeitige Läufe je Workflow", "Simultaneous runs per workflow", "", "", 1, 100, ""],
  ["testRunsPerMinute", "Testläufe je Minute und Person", "Test runs per minute and person", "", "", 1, 1000, ""],
  ["workers", "Gleichzeitige Schritte je Instanz", "Simultaneous steps per instance", "Gilt nach einem Neustart.", "Applies after a restart.", 1, 64, ""],
  ["runDays", "Läufe aufbewahren", "Keep runs", "Ältere Läufe und ihre Schritte werden gelöscht.", "Older runs and their steps are deleted.", 1, 365, "days"],
];

export function WorkflowLimits() {
  const t = useT();
  const [data, setData] = useState<Answer | null>(null);
  const [status, run] = useSaveState();
  const load = useCallback(async () => {
    try {
      setData(await api<Answer>("/api/admin/workflows"));
    } catch (e) {
      reportError(e);
    }
  }, []);
  useEffect(() => void load(), [load]);
  const save = (patch: Record<string, number | boolean | null>) =>
    void run(async () => {
      setData(await api<Answer>("/api/command", { action: "admin.workflowLimits", limits: patch }));
    });
  const m = data?.monitoring;
  return (
    <SettingGroup
      id="workflows"
      title={t("Workflows", "Workflows")}
      description={
        m
          ? t(
              `${m.activeWorkflows} aktiv · ${m.runsPerMinute} Läufe in der letzten Minute · ${m.queuedSteps + m.runningSteps} Schritte in der Warteschlange · ${Math.round(m.failureRate * 100)} % Fehler`,
              `${m.activeWorkflows} active · ${m.runsPerMinute} runs in the last minute · ${m.queuedSteps + m.runningSteps} steps queued · ${Math.round(m.failureRate * 100)} % failed`,
            )
          : t("Grenzen für Workflows. Leer = Wert aus der Umgebung.", "Limits for workflows. Empty = value from the environment.")
      }
      actions={<SaveState status={status} />}
    >
      {data && (
        <>
          <SettingRow
            label={t("Workflows erlaubt", "Workflows allowed")}
            description={t("Aus: keine neuen Workflow-Seiten, alle Workflows pausiert.", "Off: no new workflow pages, every workflow paused.")}
          >
            <Switch checked={data.limits.enabled !== false} label={t("Workflows erlaubt", "Workflows allowed")} onChange={(on) => save({ enabled: on })} />
          </SettingRow>
          {NUMBERS.map(([key, de, en, helpDe, helpEn, min, max, unit]) => (
            <LimitRow
              key={key}
              label={t(de, en)}
              description={helpDe ? t(helpDe, helpEn) : undefined}
              value={(data.stored[key] as number | null | undefined) ?? null}
              placeholder={String(data.defaults[key] ?? "")}
              min={min}
              max={max}
              unit={unit === "days" ? t("Tage", "days") : undefined}
              onCommit={(v) => save({ [key]: v })}
            />
          ))}
        </>
      )}
    </SettingGroup>
  );
}

function LimitRow({ label, description, value, placeholder, min, max, unit, onCommit }: { label: string; description?: string; value: number | null; placeholder: string; min: number; max: number; unit?: string; onCommit: (v: number | null) => void }) {
  const id = useId();
  return (
    <SettingRow id={id} label={label} description={description}>
      <NumberInput id={id} value={value} min={min} max={max} placeholder={placeholder} unit={unit} onCommit={onCommit} />
    </SettingRow>
  );
}
