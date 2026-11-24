"use client";
// A plan in "KI fragen" (#462): the steps the AI proposes for an
// instruction, each with a preview and a checkbox, in the conversation of
// the panel (on phones inside its sheet). Nothing changes before
// "Ausführen"; the server checks every step again and runs it as the person
// (lib/ai/plan.ts). Steps that use what another step creates are deselected
// with it, and say why; what is not possible is greyed out with the reason.
// Right after running, "Alles rückgängig" takes the whole plan back.
// Keyboard: ↑/↓ move between the steps, Space ticks, ⌘/Ctrl+Enter runs.
// Loaded only when a plan is shown (components/ai-ask.tsx).
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  ArrowCounterClockwise,
  ArrowRight,
  ArrowSquareOut,
  ArrowsLeftRight,
  Check,
  CheckSquare,
  Database,
  FilePlus,
  LinkSimple,
  ListChecks,
  PencilSimple,
  PencilSimpleLine,
  Play,
  Table,
  Tag,
  TextAlignLeft,
  TextT,
  TreeStructure,
  Warning,
  X,
} from "@phosphor-icons/react";
import { useT } from "./i18n";
import { serverMessage } from "@/lib/server-message";
import { runAiPlan, undoAiPlan } from "@/lib/ai/client";
import { dependents, effectiveSelection, type PlanPreview, type PlanReadItem, type PlanStepResult, type PlanTokens, type PlanUndoResult } from "@/lib/ai/plan-shared";

// The plan as the conversation keeps it (session storage of the tab).
export type PlanState = {
  summary: string;
  steps: PlanPreview[];
  read: PlanReadItem[];
  tokens: PlanTokens;
  stopped?: "rounds" | "quota" | "size";
  // The AI quota is nearly used up (reading went on).
  quotaLow?: boolean;
  // What the person ticked (a dependent step shows unticked while what it needs is not).
  chosen: number[];
  phase: "preview" | "running" | "done" | "undoing" | "undone";
  results?: PlanStepResult[];
  undone?: PlanUndoResult[];
  error?: string;
};

const ICONS = {
  create_page: FilePlus,
  create_database: Database,
  create_tasks: ListChecks,
  append_text: TextAlignLeft,
  create_record: Table,
  update_record: PencilSimple,
  insert_link: LinkSimple,
  set_relation: ArrowsLeftRight,
  rename_page: TextT,
  move_page: TreeStructure,
  set_properties: Tag,
  edit_text: PencilSimpleLine,
} as const;

export function AiPlanCard({
  workspaceId,
  plan,
  onChange,
  onOpen,
}: {
  workspaceId: string;
  plan: PlanState;
  onChange: (next: PlanState) => void;
  onOpen: (pageId: string, rowId?: string) => void;
}) {
  const t = useT();
  const list = useRef<HTMLUListElement | null>(null);
  const [showRead, setShowRead] = useState(false);
  const { selected, blockedBy } = useMemo(() => effectiveSelection(plan.steps, plan.chosen), [plan.steps, plan.chosen]);
  const results = new Map((plan.results || []).map((r) => [r.index, r]));
  const undone = new Map((plan.undone || []).map((r) => [r.index, r]));
  const editing = plan.phase === "preview";
  const count = selected.size;

  const label = (step: PlanPreview) =>
    ({
      create_page: step.step && (step.step as { parentId?: string | null }).parentId ? t("Unterseite anlegen", "Create sub-page") : t("Seite anlegen", "Create page"),
      create_database: t("Datenbank anlegen", "Create database"),
      create_tasks: t("Aufgaben anlegen", "Create tasks"),
      append_text: t("Text anfügen", "Append text"),
      create_record: t("Eintrag anlegen", "Create record"),
      update_record: t("Eintrag ändern", "Change record"),
      insert_link: t("Link einfügen", "Insert link"),
      set_relation: t("Einträge verknüpfen", "Link records"),
      rename_page: t("Umbenennen", "Rename"),
      move_page: t("Verschieben", "Move"),
      set_properties: t("Tags und Eigenschaften", "Tags and properties"),
      edit_text: t("Text ändern (als Vorschlag)", "Change text (as suggestions)"),
    })[step.tool] || t("Schritt", "Step");

  const toggle = (index: number, on: boolean) => {
    const chosen = new Set(plan.chosen);
    if (on) chosen.add(index);
    else chosen.delete(index);
    onChange({ ...plan, chosen: [...chosen].sort((a, b) => a - b) });
  };
  const run = async () => {
    if (!editing || !count) return;
    const steps = plan.steps.filter((s) => selected.has(s.index) && s.step).map((s) => ({ index: s.index, step: s.step }));
    onChange({ ...plan, phase: "running", error: undefined });
    try {
      onChange({ ...plan, phase: "done", results: await runAiPlan(workspaceId, steps), error: undefined });
    } catch (e) {
      onChange({ ...plan, phase: "preview", error: (e as Error).message });
    }
  };
  const undoAll = async () => {
    const undo = (plan.results || []).filter((r) => r.ok && r.undo).map((r) => ({ index: r.index, undo: r.undo! }));
    if (!undo.length) return;
    onChange({ ...plan, phase: "undoing", error: undefined });
    try {
      onChange({ ...plan, phase: "undone", undone: await undoAiPlan(workspaceId, undo), error: undefined });
    } catch (e) {
      onChange({ ...plan, phase: "done", error: (e as Error).message });
    }
  };
  // ↑/↓ between the steps that can be ticked; ⌘/Ctrl+Enter runs.
  const keys = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && editing) {
      e.preventDefault();
      void run();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const boxes = [...(list.current?.querySelectorAll<HTMLInputElement>("input[type=checkbox]:not(:disabled)") || [])];
    const at = boxes.indexOf(document.activeElement as HTMLInputElement);
    if (at < 0) return;
    e.preventDefault();
    boxes[Math.max(0, Math.min(boxes.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
  };

  const ok = (plan.results || []).filter((r) => r.ok).length;
  const undoable = (plan.results || []).some((r) => r.ok && r.undo);
  const readText = (item: PlanReadItem) =>
    item.kind === "search" ? t(`Suche „${item.title}“`, `Search “${item.title}”`) : item.kind === "list" ? t(`Seiten in „${item.title}“`, `Pages in “${item.title}”`) : `„${item.title}“`;

  return (
    <section className="ai-plan" aria-label={t("Plan der KI", "The AI’s plan")} onKeyDown={keys}>
      <header className="ai-plan-head">
        <p className="ai-plan-meta">
          <strong>{plan.steps.length === 1 ? t("1 Schritt", "1 step") : t(`${plan.steps.length} Schritte`, `${plan.steps.length} steps`)}</strong>
          <span> · </span>
          <span>{t(`${(plan.tokens.input + plan.tokens.output).toLocaleString()} Tokens`, `${(plan.tokens.input + plan.tokens.output).toLocaleString()} tokens`)}</span>
          {plan.read.length > 0 && (
            <>
              <span> · </span>
              <button type="button" className="ai-plan-read-toggle" aria-expanded={showRead} onClick={() => setShowRead((v) => !v)}>
                {t(`Gelesen (${plan.read.length})`, `What the AI read (${plan.read.length})`)}
              </button>
            </>
          )}
        </p>
        {showRead && (
          <ul className="ai-plan-read">
            {plan.read.map((item, i) => (
              <li key={i}>{readText(item)}</li>
            ))}
          </ul>
        )}
        {plan.stopped === "quota" && (
          <p className="ai-plan-note">{t("Dein KI-Kontingent ist aufgebraucht – die KI hat mit dem geplant, was sie bis dahin gelesen hatte.", "Your AI quota is used up – the AI planned with what it had read so far.")}</p>
        )}
        {plan.quotaLow && plan.stopped !== "quota" && <p className="ai-plan-note">{t("Dein KI-Kontingent ist fast aufgebraucht", "Your AI quota is almost used up")}</p>}
        {editing && plan.steps.length > 0 && (
          <p className="ai-plan-note">{t("Erst „Ausführen“ ändert etwas – mit deinen Rechten. Prüfe die Schritte und wähle ab, was nicht passieren soll.", "Nothing changes before “Run” – and only with your permissions. Check the steps and untick what should not happen.")}</p>
        )}
        {!plan.steps.length && <p className="ai-plan-note">{t("Die KI hat keinen Schritt vorgeschlagen.", "The AI proposed no step.")}</p>}
      </header>
      <ul className="ai-plan-steps" ref={list}>
        {plan.steps.map((step) => {
          const Icon = ICONS[step.tool as keyof typeof ICONS] || CheckSquare;
          const waiting = blockedBy.get(step.index);
          const result = results.get(step.index);
          const back = undone.get(step.index);
          const ticked = selected.has(step.index);
          const others = dependents(plan.steps, step.index).filter((i) => plan.chosen.includes(i));
          return (
            <li key={step.index} className={`ai-plan-step${step.ok ? "" : " blocked"}${!ticked && step.ok && editing ? " off" : ""}${step.unmentioned ? " unmentioned" : ""}`}>
              <label className="ai-plan-step-head">
                <input
                  type="checkbox"
                  disabled={!step.ok || !editing || waiting !== undefined}
                  checked={step.ok && ticked}
                  aria-describedby={`plan-step-${step.index}-why`}
                  onChange={(e) => toggle(step.index, e.target.checked)}
                />
                <span className="ai-plan-number" aria-hidden="true">
                  {step.index + 1}
                </span>
                <Icon size={15} aria-hidden="true" />
                <strong>{label(step)}</strong>
                {step.view.target && <span className="ai-plan-target">{step.view.target}</span>}
              </label>
              {step.unmentioned && step.ok && (
                <p className="ai-plan-flag">
                  <Warning size={13} aria-hidden="true" /> {t("Ändert eine Seite, die du nicht genannt hast.", "Changes a page you did not name.")}
                </p>
              )}
              {step.ok && <StepPreview step={step} />}
              <div id={`plan-step-${step.index}-why`}>
                {!step.ok && <p className="ai-plan-reason">{serverMessage(step.problem || "Der Schritt ist nicht möglich.")}</p>}
                {step.ok && waiting !== undefined && editing && (
                  <p className="ai-plan-reason">
                    {t(`Hängt von Schritt ${waiting + 1} ab, der nicht ausgeführt wird.`, `Depends on step ${waiting + 1}, which will not run.`)}
                  </p>
                )}
                {step.ok && editing && !ticked && waiting === undefined && others.length > 0 && (
                  <p className="ai-plan-reason">
                    {t(
                      `Abgewählt – damit entfallen auch die Schritte ${others.map((i) => i + 1).join(", ")}.`,
                      `Unticked – steps ${others.map((i) => i + 1).join(", ")} depend on it and are left out too.`,
                    )}
                  </p>
                )}
              </div>
              {result && (
                <p className={`ai-plan-result${result.ok ? "" : " failed"}`} role="status">
                  {back ? (
                    back.ok ? (
                      <>
                        <ArrowCounterClockwise size={13} aria-hidden="true" /> {t("Zurückgenommen", "Undone")}
                      </>
                    ) : (
                      <>
                        <X size={13} aria-hidden="true" /> {serverMessage(back.error || "Der Schritt ist nicht möglich.")}
                      </>
                    )
                  ) : result.ok ? (
                    <>
                      <Check size={13} aria-hidden="true" /> {t("Erledigt", "Done")}
                      {result.pageId && (
                        <button type="button" className="ai-plan-open" onClick={() => onOpen(result.pageId!, result.rowId)}>
                          <ArrowSquareOut size={13} aria-hidden="true" /> {t("Öffnen", "Open")}
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      <X size={13} aria-hidden="true" /> {serverMessage(result.error || "Der Schritt ist nicht möglich.")}
                    </>
                  )}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {plan.error && (
        <p className="error ai-plan-error" role="alert">
          {plan.error}
        </p>
      )}
      <footer className="ai-plan-actions">
        {(plan.phase === "preview" || plan.phase === "running") && plan.steps.some((s) => s.ok) && (
          <>
            <button type="button" className="button primary compact" disabled={!count || plan.phase === "running"} onClick={() => void run()}>
              <Play size={14} aria-hidden="true" /> {plan.phase === "running" ? t("Wird ausgeführt …", "Running …") : t(`Ausführen (${count})`, `Run (${count})`)}
            </button>
            <span className="ai-plan-keys" aria-hidden="true">
              ⌘↵
            </span>
          </>
        )}
        {(plan.phase === "done" || plan.phase === "undoing") && (
          <>
            <span className="ai-plan-done" role="status">
              {t(`${ok} von ${plan.results?.length || 0} Schritten ausgeführt.`, `${ok} of ${plan.results?.length || 0} steps run.`)}
            </span>
            {undoable && (
              <button type="button" className="button compact" disabled={plan.phase === "undoing"} onClick={() => void undoAll()}>
                <ArrowCounterClockwise size={14} aria-hidden="true" /> {plan.phase === "undoing" ? t("Wird zurückgenommen …", "Undoing …") : t("Alles rückgängig", "Undo all")}
              </button>
            )}
          </>
        )}
        {plan.phase === "undone" && (
          <span className="ai-plan-done" role="status">
            {t("Der Plan ist zurückgenommen. Frühere Stände findest du im Versionsverlauf der Seiten.", "The plan is undone. Earlier states are in the pages’ version history.")}
          </span>
        )}
      </footer>
    </section>
  );
}

// What one step will do: the new page and its text, the link, from → to,
// the properties, the text changes.
function StepPreview({ step }: { step: PlanPreview }) {
  const t = useT();
  const v = step.view;
  const parts: ReactNode[] = [];
  if (v.title && step.tool !== "rename_page") parts.push(<p key="title" className="ai-plan-title">{v.title}</p>);
  if (v.from !== undefined && v.to !== undefined)
    parts.push(
      <p key="move" className="ai-plan-move">
        <span>{v.from || "–"}</span> <ArrowRight size={12} aria-label={t("zu", "to")} /> <span>{v.to}</span>
      </p>,
    );
  if (v.link)
    parts.push(
      <p key="link" className="ai-plan-move">
        <LinkSimple size={12} aria-hidden="true" /> <span>{v.link.to}</span>
        <span className="muted"> {v.link.heading ? t(`unter „${v.link.heading}“`, `under “${v.link.heading}”`) : t("am Ende", "at the end")}</span>
      </p>,
    );
  if (v.markdown) parts.push(<pre key="text" className="ai-plan-text">{v.markdown}</pre>);
  if (v.tasks)
    parts.push(
      <ul key="tasks" className="ai-plan-tasks">
        {v.tasks.map((task, i) => (
          <li key={i}>
            ☐ {task.text}
            {task.assignee && <span className="chip">@{task.assignee}</span>}
            {task.due && <span className="chip">{task.due}</span>}
          </li>
        ))}
      </ul>,
    );
  if (v.fields)
    parts.push(
      <p key="fields" className="ai-plan-fields">
        {v.fields.map((f) => f.name).join(" · ")}
        {!!v.records && <span className="muted"> · {v.records === 1 ? t("1 Beispieleintrag", "1 example record") : t(`${v.records} Beispieleinträge`, `${v.records} example records`)}</span>}
      </p>,
    );
  if (v.tags)
    parts.push(
      <p key="tags" className="ai-plan-tags">
        {v.tags.add.map((tag) => (
          <span key={`+${tag}`} className="chip">
            + {tag}
          </span>
        ))}
        {v.tags.remove.map((tag) => (
          <span key={`-${tag}`} className="chip removed">
            − {tag}
          </span>
        ))}
      </p>,
    );
  if (v.cells)
    parts.push(
      <dl key="cells" className="ai-plan-cells">
        {v.cells.map((cell, i) => (
          <div key={i}>
            <dt>{cell.name}</dt>
            <dd>{cell.value || "–"}</dd>
          </div>
        ))}
      </dl>,
    );
  if (v.diff)
    parts.push(
      <div key="diff" className="ai-plan-diff">
        {v.diff.map((d, i) => (
          <div key={i} className="ai-plan-diff-item">
            {d.before && <del>{d.before}</del>}
            {d.after && <ins>{d.after}</ins>}
          </div>
        ))}
      </div>,
    );
  return parts.length ? <div className="ai-plan-preview">{parts}</div> : null;
}
