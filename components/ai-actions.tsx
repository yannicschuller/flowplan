"use client";
// AI actions: what the AI proposes (pages, tasks, text, records) as a
// preview with checkboxes. Nothing is written before "Ausführen"; the
// server checks every action again and runs it as the person
// (lib/ai/actions.ts). Created pages and records can be moved to the trash
// right here; appended text and changed records have their version history.
import { useEffect, useRef, useState } from "react";
import { ArrowCounterClockwise, ArrowSquareOut, CheckSquare, FilePlus, ListChecks, Play, Sparkle, TextAlignLeft, Table, PencilSimple } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { Modal, api } from "./ui";
import { AiProviderFooter } from "./ai-context";
import { proposeAiActions, runAiActions, type ActionPreview, type ActionResult } from "@/lib/ai/client";
import { serverMessage } from "@/lib/i18n-errors";
import { pageLocationHash } from "@/lib/page-location";

export type AiActionsRequest = {
  instruction: string;
  // The answer, text or transcript the actions are made from.
  context?: string;
  pageId?: string | null;
  sources?: { pageId: string; rowId?: string | null }[];
  mode?: "general" | "transcript";
};

const ICONS = { create_page: FilePlus, create_tasks: ListChecks, append_text: TextAlignLeft, create_record: Table, update_record: PencilSimple } as const;

export function AiActionsPanel({
  workspaceId,
  request,
  onClose,
  onOpen,
}: {
  workspaceId: string;
  request: AiActionsRequest | null;
  onClose: () => void;
  // Opens a created page or record (default: by the address).
  onOpen?: (pageId: string, rowId?: string) => void;
}) {
  const t = useT();
  const [phase, setPhase] = useState<"proposing" | "preview" | "running" | "done" | "error">("proposing");
  const [previews, setPreviews] = useState<ActionPreview[]>([]);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [results, setResults] = useState<ActionResult[]>([]);
  const [undone, setUndone] = useState<Set<number>>(new Set());
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);

  const toolLabel = (tool: string) =>
    ({
      create_page: t("Seite anlegen", "Create page"),
      create_tasks: t("Aufgaben anlegen", "Create tasks"),
      append_text: t("Text anfügen", "Append text"),
      create_record: t("Eintrag anlegen", "Create record"),
      update_record: t("Eintrag ändern", "Change record"),
    })[tool] || t("Aktion", "Action");

  const propose = async () => {
    if (!request) return;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setPhase("proposing");
    setError("");
    setResults([]);
    setUndone(new Set());
    try {
      const list = await proposeAiActions({ workspaceId, ...request, signal: abort.signal });
      if (controller.current !== abort) return;
      setPreviews(list);
      setChosen(new Set(list.filter((p) => p.ok).map((p) => p.index)));
      setPhase("preview");
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setError((e as Error).message);
      setPhase("error");
    }
  };
  useEffect(() => {
    if (request) void propose();
    return () => controller.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const execute = async () => {
    const picked = previews.filter((p) => p.ok && p.action && chosen.has(p.index));
    if (!picked.length) return;
    setPhase("running");
    setError("");
    try {
      const done = await runAiActions(
        workspaceId,
        picked.map((p) => p.action),
      );
      // Results come back in the order sent: map them to the previews.
      setResults(done.map((r, i) => ({ ...r, index: picked[i].index })));
      setPhase("done");
    } catch (e) {
      setError((e as Error).message);
      setPhase("preview");
    }
  };
  const undo = async (result: ActionResult) => {
    if (!result.undo) return;
    try {
      await api("/api/command", result.undo);
      setUndone((set) => new Set(set).add(result.index));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const open = (pageId: string, rowId?: string) => {
    if (onOpen) onOpen(pageId, rowId);
    else location.hash = pageLocationHash({ pageId, rowId });
    onClose();
  };

  const okCount = results.filter((r) => r.ok).length;
  return (
    <Modal open={!!request} onClose={onClose} title={t("KI-Aktionen", "AI actions")} wide className="ai-actions">
      {phase === "proposing" && (
        <p className="ai-ask-thinking" aria-live="polite">
          <Sparkle size={14} /> {t("Die KI schlägt Aktionen vor …", "The AI is proposing actions …")}
        </p>
      )}
      {phase === "error" && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {(phase === "preview" || phase === "running") && (
        <>
          <p className="muted">
            {previews.length
              ? t("Wähle, was ausgeführt werden soll. Erst „Ausführen“ ändert etwas – mit deinen Rechten.", "Choose what to run. Nothing changes before “Run” – and only with your permissions.")
              : t("Die KI hat keine Aktion vorgeschlagen.", "The AI proposed no action.")}
          </p>
          <ul className="ai-action-list">
            {previews.map((p) => {
              const Icon = ICONS[p.tool as keyof typeof ICONS] || CheckSquare;
              return (
                <li key={p.index} className={p.ok ? "" : "blocked"}>
                  <label>
                    <input
                      type="checkbox"
                      disabled={!p.ok || phase === "running"}
                      checked={p.ok && chosen.has(p.index)}
                      onChange={(e) =>
                        setChosen((set) => {
                          const next = new Set(set);
                          if (e.target.checked) next.add(p.index);
                          else next.delete(p.index);
                          return next;
                        })
                      }
                    />
                    <Icon size={16} aria-hidden />
                    <strong>{toolLabel(p.tool)}</strong>
                    {p.view.target && <span className="muted"> · {p.view.target}</span>}
                  </label>
                  {p.problem && <p className="error small">{serverMessage(p.problem)}</p>}
                  {p.view.title && <p className="ai-action-title">{p.view.title}</p>}
                  {p.view.tasks && (
                    <ul className="ai-action-tasks">
                      {p.view.tasks.map((task, i) => (
                        <li key={i}>
                          ☐ {task.text}
                          {task.assignee && <span className="chip">@{task.assignee}</span>}
                          {task.due && <span className="chip">{task.due}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                  {p.view.cells && (
                    <dl className="ai-action-cells">
                      {p.view.cells.map((cell, i) => (
                        <div key={i}>
                          <dt>{cell.name}</dt>
                          <dd>{cell.value || "–"}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  {p.view.markdown && <pre className="ai-action-text">{p.view.markdown.length > 1200 ? `${p.view.markdown.slice(0, 1200)} …` : p.view.markdown}</pre>}
                </li>
              );
            })}
          </ul>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </>
      )}
      {phase === "done" && (
        <div className="ai-action-results" role="status">
          <p>
            <strong>
              {okCount === 1 ? t("1 Aktion ausgeführt.", "1 action run.") : t(`${okCount} Aktionen ausgeführt.`, `${okCount} actions run.`)}
            </strong>{" "}
            {t(
              "Angelegte Seiten und Einträge kannst du hier oder im Papierkorb zurücknehmen; angefügter Text und geänderte Einträge stehen im Versionsverlauf.",
              "Created pages and records can be undone here or in the trash; appended text and changed records are in the version history.",
            )}
          </p>
          <ul className="ai-action-list">
            {results.map((r) => (
              <li key={r.index} className={r.ok ? "" : "blocked"}>
                <span>
                  <strong>{toolLabel(r.tool)}</strong>
                  {r.title && <span className="muted"> · {r.title}</span>}
                </span>
                {r.ok ? (
                  <span className="ai-action-buttons">
                    {r.pageId && !undone.has(r.index) && (
                      <button type="button" className="button compact" onClick={() => open(r.pageId!, r.rowId)}>
                        <ArrowSquareOut size={14} /> {t("Öffnen", "Open")}
                      </button>
                    )}
                    {r.undo &&
                      (undone.has(r.index) ? (
                        <span className="muted">{t("In den Papierkorb verschoben", "Moved to the trash")}</span>
                      ) : (
                        <button type="button" className="button compact" onClick={() => void undo(r)}>
                          <ArrowCounterClockwise size={14} /> {t("Rückgängig", "Undo")}
                        </button>
                      ))}
                  </span>
                ) : (
                  <span className="error small">{serverMessage(r.error || "Die Aktion ist nicht möglich.")}</span>
                )}
              </li>
            ))}
          </ul>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
      <div className="modal-actions">
        {phase === "done" ? (
          <button type="button" className="button primary" onClick={onClose}>
            {t("Fertig", "Done")}
          </button>
        ) : (
          <>
            <button type="button" className="button" onClick={onClose}>
              {t("Abbrechen", "Cancel")}
            </button>
            {phase === "error" && (
              <button type="button" className="button" onClick={() => void propose()}>
                {t("Erneut", "Retry")}
              </button>
            )}
            {(phase === "preview" || phase === "running") && previews.some((p) => p.ok) && (
              <button type="button" className="button primary" disabled={!chosen.size || phase === "running"} onClick={() => void execute()}>
                <Play size={14} /> {phase === "running" ? t("Wird ausgeführt …", "Running …") : t(`Ausführen (${chosen.size})`, `Run (${chosen.size})`)}
              </button>
            )}
          </>
        )}
      </div>
      <AiProviderFooter />
    </Modal>
  );
}
