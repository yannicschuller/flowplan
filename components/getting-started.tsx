"use client";
// "Erste Schritte" in the sidebar (lib/getting-started.ts): after the
// introduction a short list of first things to do. Items tick themselves
// when the server sees them happen (a page, a task, an invitation, an
// import) or the browser does (the app, the search); every item can also be
// ticked by hand. Folded or open is remembered in this browser; "Ausblenden"
// hides the list for good (the command palette shows it again). Loaded
// only when there is a list (components/workspace-app.tsx).
import { useEffect, useState } from "react";
import { ArrowRight, CaretDown, CheckCircle, Confetti, X } from "@phosphor-icons/react";
import type { ChecklistItem, ChecklistView } from "@/lib/getting-started-items";
import { useKeyboardHints } from "@/lib/keyboard-hints";
import { useT } from "./i18n";

const FOLDED = "flowplan-getting-started-folded";

export default function GettingStarted({
  state,
  sample,
  mutate,
  onAction,
}: {
  state: ChecklistView;
  sample: { name: string } | null;
  mutate: (body: Record<string, unknown>) => Promise<unknown>;
  onAction: (item: ChecklistItem) => void;
}) {
  const t = useT();
  const searchKey = useKeyboardHints().action("search");
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  // A tick shows at once; the list from the server replaces it.
  const [ticked, setTicked] = useState<Partial<Record<ChecklistItem, boolean>>>({});
  useEffect(() => setTicked({}), [state]);
  useEffect(() => {
    try {
      if (localStorage.getItem(FOLDED) === "1") setOpen(false);
    } catch {}
  }, []);
  const fold = (value: boolean) => {
    setOpen(value);
    try {
      localStorage.setItem(FOLDED, value ? "0" : "1");
    } catch {}
  };
  const text: Record<ChecklistItem, { label: string; action: string }> = {
    page: { label: t("Eine erste Seite schreiben", "Write a first page"), action: t("Neue Seite", "New page") },
    task: { label: t("Eine Aufgabe anlegen", "Create a task"), action: t("Meine Aufgaben öffnen", "Open My tasks") },
    invite: { label: t("Jemanden einladen", "Invite someone"), action: t("Mitglieder öffnen", "Open members") },
    app: { label: t("Die App installieren", "Install the app"), action: t("Apps und Geräte öffnen", "Open apps and devices") },
    search: { label: t("Suche und Befehle ausprobieren", "Try search and commands") + (searchKey ? ` (${searchKey})` : ""), action: t("Suche öffnen", "Open search") },
    import: { label: t("Inhalte importieren", "Import content"), action: t("Import öffnen", "Open import") },
  };
  const total = state.items.length;
  const all = total > 0 && state.doneCount === total;
  const run = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      await mutate(body);
    } catch {
      /* the app shows the error */
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="getting-started" aria-labelledby="getting-started-title">
      <div className="getting-started-head">
        <button type="button" className="getting-started-toggle" aria-expanded={open} aria-controls="getting-started-list" onClick={() => fold(!open)}>
          <CaretDown size={13} aria-hidden data-open={open || undefined} />
          <span id="getting-started-title">{t("Erste Schritte", "Getting started")}</span>
          <span className="getting-started-count">{t(`${state.doneCount} von ${total}`, `${state.doneCount} of ${total}`)}</span>
        </button>
        <button
          type="button"
          className="icon-button"
          title={t("Erste Schritte ausblenden", "Hide getting started")}
          aria-label={t("Erste Schritte ausblenden", "Hide getting started")}
          disabled={busy}
          onClick={() => void run({ action: "gettingStarted.hide", hidden: true })}
        >
          <X size={14} />
        </button>
      </div>
      <progress className="getting-started-progress" max={total || 1} value={state.doneCount} aria-hidden />
      {open && (
        <div id="getting-started-list">
          {all && (
            <p className="getting-started-all">
              <Confetti size={16} aria-hidden /> {t("Geschafft – du kennst dich aus!", "Done – you know your way around!")}
            </p>
          )}
          <ul>
            {state.items.map((item) => (
              <li key={item.id} data-done={(ticked[item.id] ?? item.done) || undefined}>
                <label>
                  <input
                    type="checkbox"
                    checked={ticked[item.id] ?? item.done}
                    onChange={(e) => {
                      const done = e.target.checked;
                      setTicked((all) => ({ ...all, [item.id]: done }));
                      void run({ action: "gettingStarted.mark", item: item.id, done });
                    }}
                  />
                  <span>{text[item.id].label}</span>
                </label>
                {!item.done && (
                  <button type="button" className="icon-button" title={text[item.id].action} aria-label={text[item.id].action} onClick={() => onAction(item.id)}>
                    <ArrowRight size={13} />
                  </button>
                )}
              </li>
            ))}
          </ul>
          {sample && (
            <p className="getting-started-sample">
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={async () => {
                  setNote("");
                  setBusy(true);
                  try {
                    const result = (await mutate({ action: "sample.remove" })) as { keptPages?: number } | undefined;
                    setNote(
                      result?.keptPages
                        ? t(`Beispielseiten entfernt; ${result.keptPages} eigene Seiten bleiben im Bereich.`, `Sample pages removed; ${result.keptPages} pages of your own stay in the space.`)
                        : t("Beispielbereich entfernt.", "Sample space removed."),
                    );
                  } catch {
                    /* the app shows the error */
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {t(`„${sample.name}“ entfernen`, `Remove “${sample.name}”`)}
              </button>
            </p>
          )}
          {all && (
            <button type="button" className="button compact getting-started-close" disabled={busy} onClick={() => void run({ action: "gettingStarted.hide", hidden: true })}>
              <CheckCircle size={15} aria-hidden /> {t("Liste ausblenden", "Hide the list")}
            </button>
          )}
        </div>
      )}
      <p className="sr-only" role="status">
        {note}
      </p>
    </section>
  );
}
