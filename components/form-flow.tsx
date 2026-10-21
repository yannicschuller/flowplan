"use client";
// An ordinary form for the person answering it: questions with conditions,
// text blocks, pages with a progress bar, and – for signed-in people – a
// draft to continue later. Also the shared thank-you screen (placeholders,
// redirect) and the draft hook used by forms and surveys.
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Check } from "@phosphor-icons/react";
import { serverMessage } from "@/lib/i18n-errors";
import { useT } from "./i18n";
import FormQuestions from "./form-questions";
import { formItems, formLogicItems, validateFormValues, type FormConfig, type FormItem } from "@/lib/form-settings";
import { answersByName, evaluateLogic, fillPlaceholders, logicPages, redirectTarget } from "@/lib/form-logic";
import type { Field } from "@/lib/types";

export type Draft = { cells: Record<string, unknown>; page: number } | null;

// Save and continue later: loads the person's draft once and saves it on
// request. `enabled` is false for anonymous forms and previews.
export function useFormDraft(token: string, enabled: boolean) {
  const t = useT();
  const [state, setState] = useState<{ loaded: boolean; draft: Draft }>({ loaded: !enabled, draft: null });
  const [status, setStatus] = useState<"" | "saving" | "saved" | "failed">("");
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    fetch(`/api/forms/${token}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { draft: null }))
      .catch(() => ({ draft: null }))
      .then((data: { draft: Draft }) => live && setState({ loaded: true, draft: data.draft || null }));
    return () => {
      live = false;
    };
  }, [token, enabled]);
  const save = useCallback(
    async (values: Record<string, unknown>, page: number) => {
      setStatus("saving");
      // Files stay in the browser; they are chosen again on sending.
      const cells = Object.fromEntries(Object.entries(values).filter(([, v]) => !(Array.isArray(v) && v.some((x) => typeof File !== "undefined" && x instanceof File))));
      const response = await fetch(`/api/forms/${token}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ cells, page }) }).catch(() => null);
      setStatus(response?.ok ? "saved" : "failed");
      if (!response?.ok) {
        const data = await response?.json().catch(() => ({}));
        throw new Error(serverMessage(data?.error) || t("Entwurf konnte nicht gespeichert werden.", "The draft could not be saved."));
      }
    },
    [token, t],
  );
  return { enabled, ...state, status, save };
}

// The note and button for drafts below a form.
export function DraftControls({ status, disabled, onSave }: { status: string; disabled: boolean; onSave: () => void }) {
  const t = useT();
  return (
    <span className="form-draft">
      <button type="button" className="button" disabled={disabled || status === "saving"} onClick={onSave}>
        {t("Speichern und später weitermachen", "Save and continue later")}
      </button>
      {status === "saved" && <span className="muted small" role="status">{t("Entwurf gespeichert – du kannst später hier weitermachen.", "Draft saved – you can continue here later.")}</span>}
      {status === "failed" && <span className="error small" role="alert">{t("Entwurf konnte nicht gespeichert werden.", "The draft could not be saved.")}</span>}
    </span>
  );
}

// The thank-you screen: {Question} placeholders filled from the answers,
// then the optional redirect (https only) after the configured delay.
export function FormThanks({
  title,
  message,
  fields,
  values,
  redirect,
  preview = false,
  heading = "h2",
  survey = false,
  children,
}: {
  survey?: boolean;
  title: string;
  message: string;
  fields: Field[];
  values: Record<string, unknown>;
  redirect?: { url: string; delay: number };
  preview?: boolean;
  heading?: "h2" | "h3";
  children?: React.ReactNode;
}) {
  const t = useT();
  const answer = useMemo(() => answersByName(fields, values), [fields, values]);
  const target = redirect?.url ? redirectTarget(redirect.url, answer) : null;
  const delay = redirect?.delay ?? 3;
  useEffect(() => {
    if (!target || preview) return;
    const timer = setTimeout(() => location.assign(target), delay * 1000);
    return () => clearTimeout(timer);
  }, [target, delay, preview]);
  const Heading = heading;
  return (
    <div className={survey ? "survey-done" : "success"} role="status">
      {survey ? (
        <span className="survey-done-check">
          <Check weight="bold" />
        </span>
      ) : (
        <Check />
      )}
      <Heading>{fillPlaceholders(title, answer)}</Heading>
      {message && <p className="form-thanks-text">{fillPlaceholders(message, answer)}</p>}
      {children}
      {target && (
        <p className="muted small">
          {preview
            ? t(`Nach dem Absenden geht es in ${delay} s weiter zu:`, `After sending, people go on in ${delay} s to:`)
            : t("Du wirst gleich weitergeleitet:", "You will be redirected shortly:")}{" "}
          <a href={target} rel="noreferrer">
            {target}
          </a>
        </p>
      )}
    </div>
  );
}

// Pages of an ordinary form for these answers.
export function useFormPages(fields: Field[], config: FormConfig, values: Record<string, unknown>, internal: boolean) {
  const items = useMemo(() => formItems(fields, config, internal), [fields, config, internal]);
  const logic = evaluateLogic(formLogicItems(items), values);
  const pages = logicPages(items, logic).map((p) => ({ key: p.brk?.id ?? "", title: p.brk?.kind === "page" ? p.brk.title : "", items: p.shown }));
  return { items, logic, pages };
}

export function FormFlow({
  fields,
  config,
  internal = false,
  members = [],
  related = {},
  upload,
  disabled = false,
  submitLabel,
  onSubmit,
  initial = null,
  draft,
}: {
  fields: Field[];
  config: FormConfig;
  internal?: boolean;
  members?: { id: string; name: string }[];
  related?: Record<string, { id: string; cells: { title: string } }[]>;
  upload?: (file: File) => Promise<string>;
  disabled?: boolean;
  submitLabel: string;
  // Gets the answers of shown questions; throws with a message on failure.
  onSubmit: (values: Record<string, unknown>) => Promise<void>;
  initial?: Draft;
  draft?: { status: string; save: (values: Record<string, unknown>, page: number) => Promise<void> };
}) {
  const t = useT();
  const [values, setValues] = useState<Record<string, unknown>>(initial?.cells || {});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { logic, pages } = useFormPages(fields, config, values, internal);
  const [pageKey, setPageKey] = useState(() => pages[Math.min(initial?.page ?? 0, pages.length - 1)]?.key ?? "");
  const at = Math.max(0, pages.findIndex((p) => p.key === pageKey));
  const page = pages[at];
  const last = at === pages.length - 1;
  // Checks the questions of this page (the server checks everything).
  const check = () => {
    const result = validateFormValues(fields, config, values, internal);
    const here = new Set(page.items.filter((i) => i.kind === "question").map((i) => i.id));
    const mine = Object.fromEntries(Object.entries(result.errors).filter(([key]) => here.has(key)));
    setErrors(mine);
    return !Object.keys(mine).length;
  };
  const go = (index: number) => {
    setPageKey(pages[index].key);
    window.scrollTo?.({ top: 0, behavior: "smooth" });
  };
  const progress = pages.length > 1 ? Math.round((at / pages.length) * 100) : 0;
  const questions = (list: FormItem[]) =>
    list.map((item) =>
      item.kind === "question" ? (
        <FormQuestions
          key={item.id}
          only={item.id}
          fields={fields}
          config={config}
          values={values}
          errors={errors}
          disabled={disabled || busy}
          internal={internal}
          members={members}
          related={related}
          upload={upload}
          onChange={(id, value) => {
            setValues((previous) => ({ ...previous, [id]: value }));
            setErrors((previous) => ({ ...previous, [id]: "" }));
          }}
        />
      ) : item.kind === "text" ? (
        <div key={item.id} className="survey-text form-text-block">
          {item.title && <h3>{item.title}</h3>}
          {item.body && <p>{item.body}</p>}
        </div>
      ) : null,
    );
  return (
    <form
      noValidate
      className="form-flow"
      onSubmit={async (e) => {
        e.preventDefault();
        setError("");
        if (!e.currentTarget.reportValidity() || !check()) return;
        if (!last) return go(at + 1);
        setBusy(true);
        try {
          // Answers of questions hidden by conditions are not sent.
          await onSubmit(Object.fromEntries(Object.entries(values).filter(([key]) => !logic.hiddenFields.has(key))));
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {config.progress && pages.length > 1 && (
        <div className="survey-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-label={t("Fortschritt", "Progress")}>
          <span style={{ width: `${progress}%` }} />
        </div>
      )}
      {page?.title && <h2 className="survey-page-title">{page.title}</h2>}
      {questions(page?.items || [])}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="survey-nav">
        {at > 0 && (
          <button type="button" className="button" disabled={busy} onClick={() => go(at - 1)}>
            <ArrowLeft /> {t("Zurück", "Back")}
          </button>
        )}
        <button className="button primary" disabled={disabled || busy}>
          {busy ? t("Wird gesendet …", "Sending …") : last ? submitLabel : t("Weiter", "Next")}
          {!last && <ArrowRight />}
        </button>
        {draft && <DraftControls status={draft.status} disabled={disabled || busy} onSave={() => void draft.save(values, at).catch(() => {})} />}
        {pages.length > 1 && <span className="muted survey-step">{t(`Seite ${at + 1} von ${pages.length}`, `Page ${at + 1} of ${pages.length}`)}</span>}
      </div>
    </form>
  );
}
