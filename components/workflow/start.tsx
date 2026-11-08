"use client";
// How a workflow begins (docs/specs/workflows.md §10.6, §10.7, §11.4): on an
// empty draft the start screen offers a blank start, the template gallery,
// the AI builder and a file to import. Templates and imports ask for their
// gaps in a short assistant (a page, a database, a property, a person …);
// the AI builder shows its draft for review first. Whatever is chosen goes
// into the draft as one change (undo takes it back) – never activated.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Broadcast,
  CalendarCheck,
  ClipboardText,
  EnvelopeSimpleOpen,
  FileArrowUp,
  ListPlus,
  MagicWand,
  Newspaper,
  Plus,
  Sparkle,
  Warning,
} from "@phosphor-icons/react";
import { useLocale } from "../i18n";
import { Modal, api } from "../ui";
import { Select } from "../select";
import type { Field } from "@/lib/types";
import { checkGraph, issueMessage, type WorkflowGraph } from "@/lib/workflows/graph";
import { gapDatabase, missingGaps, workflowTemplates, type Gap, type GapAnswers, type WorkflowTemplate } from "@/lib/workflows/templates";
import { DatabaseSelect, FieldSelect, Labeled, PageSelect, useResources } from "./config-form";
import { useDatabases } from "./use-databases";
import { typeName, type T, type Workspace, useStableT } from "./model";

const ICONS: Record<string, typeof ListPlus> = { ListPlus, CalendarCheck, ClipboardText, Newspaper, EnvelopeSimpleOpen, Broadcast };

type Props = {
  pageId: string;
  ws: Workspace;
  timeZone: string;
  onBlank: () => void;
  onApply: (graph: WorkflowGraph) => void;
  onAi: () => void;
  onError: (e: unknown) => void;
};

// The start screen of an empty draft.
export function StartScreen(props: Props) {
  const t = useStableT();
  const templates = useMemo(() => workflowTemplates(t), [t]);
  const [template, setTemplate] = useState<WorkflowTemplate | null>(null);
  const [importing, setImporting] = useState<{ data: unknown; title: string | null; unresolved: Unresolved[]; mapped: Record<string, string> } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const readFile = async (f: File) => {
    try {
      if (f.size > 2_000_000) throw new Error(t("Die Datei ist zu groß.", "The file is too large."));
      const data = JSON.parse(await f.text());
      const preview = await api<{ unresolved: Unresolved[]; mapped: Record<string, string>; title: string | null }>("/api/command", { action: "workflow.import", pageId: props.pageId, data, preview: true });
      setImporting({ data, title: preview.title, unresolved: preview.unresolved, mapped: preview.mapped });
    } catch (e) {
      props.onError(e instanceof SyntaxError ? new Error(t("Keine Workflow-Datei.", "Not a workflow file.")) : e);
    }
  };
  return (
    <div className="wf-start">
      <div className="wf-start-head">
        <h2>{t("Wie soll der Workflow beginnen?", "How should the workflow start?")}</h2>
        <div className="wf-start-actions">
          <button type="button" className="button" onClick={props.onBlank}>
            <Plus aria-hidden /> {t("Leer beginnen", "Start blank")}
          </button>
          <button type="button" className="button" onClick={props.onAi}>
            <Sparkle aria-hidden /> {t("Mit KI entwerfen", "Draft with AI")}
          </button>
          <button type="button" className="button" onClick={() => file.current?.click()}>
            <FileArrowUp aria-hidden /> {t("Aus Datei importieren", "Import from a file")}
          </button>
          <input
            ref={file}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void readFile(f);
            }}
          />
        </div>
      </div>
      <h3 className="wf-start-sub">{t("Vorlagen", "Templates")}</h3>
      <div className="template-grid wf-templates" role="list">
        {templates.map((x) => {
          const Icon = ICONS[x.icon] || MagicWand;
          return (
            <button key={x.id} type="button" role="listitem" data-template={x.id} onClick={() => setTemplate(x)}>
              <Icon size={22} aria-hidden />
              <strong>{x.name}</strong>
              <small>{x.description}</small>
            </button>
          );
        })}
      </div>
      {template && (
        <GapAssistant
          title={template.name}
          intro={template.description}
          gaps={template.gaps}
          pageId={props.pageId}
          ws={props.ws}
          onClose={() => setTemplate(null)}
          onDone={async (answers, fields) => {
            props.onApply(template.build(answers, { t, timeZone: props.timeZone, fields: (id) => fields.get(id) }));
            setTemplate(null);
          }}
        />
      )}
      {importing && (
        <GapAssistant
          title={importing.title ? t(`„${importing.title}“ importieren`, `Import “${importing.title}”`) : t("Workflow importieren", "Import a workflow")}
          intro={
            importing.unresolved.length
              ? t("Diese Verweise gibt es hier nicht. Wähle, was stattdessen gilt – oder lass sie leer und ergänze sie im Entwurf.", "These references do not exist here. Choose what applies instead – or leave them empty and fill them in the draft.")
              : t("Alle Verweise sind zugeordnet. Der Workflow wird als Entwurf angelegt.", "All references are matched. The workflow is added as a draft.")
          }
          gaps={unresolvedGaps(importing.unresolved, importing.mapped, t)}
          pageId={props.pageId}
          ws={props.ws}
          optional
          onClose={() => setImporting(null)}
          onDone={async (answers) => {
            try {
              const mapping: Record<string, string> = {};
              for (const [k, v] of Object.entries(answers)) if (typeof v === "string" && v) mapping[decodeGap(k)] = v;
              await api("/api/command", { action: "workflow.import", pageId: props.pageId, data: importing.data, mapping });
              setImporting(null);
              // The draft arrives over the live sync.
            } catch (e) {
              props.onError(e);
            }
          }}
        />
      )}
    </div>
  );
}

/* ---------- Imports: unresolved references as gaps ---------- */

type Unresolved = { id: string; kind: string; title: string; of?: string; types?: string[] };
const encodeGap = (id: string) => `r_${id.replace(/[^a-zA-Z0-9]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`)}`;
const decodeGap = (gap: string) => gap.slice(2).replace(/_([0-9a-f]+)_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
function unresolvedGaps(list: Unresolved[], mapped: Record<string, string>, t: (de: string, en: string) => string): Gap[] {
  const out: Gap[] = [];
  for (const u of list) {
    const name = u.title ? `„${u.title}“` : t("(ohne Titel)", "(untitled)");
    if (u.kind === "database") out.push({ id: encodeGap(u.id), kind: "database", label: t(`Datenbank ${name}`, `Database ${name}`), optional: true });
    else if (u.kind === "page") out.push({ id: encodeGap(u.id), kind: "page", label: t(`Seite ${name}`, `Page ${name}`), optional: true });
    else if (u.kind === "person") out.push({ id: encodeGap(u.id), kind: "person", label: t(`Person ${name}`, `Person ${name}`), optional: true });
    else if (u.kind === "chatHook") out.push({ id: encodeGap(u.id), kind: "chatHook", label: t(`Chat-Webhook ${name}`, `Chat webhook ${name}`), optional: true });
    else if (u.kind === "field") {
      // A property of a database that was matched: picked among its properties.
      const db = u.of ? mapped[u.of] : undefined;
      if (db) out.push({ id: encodeGap(u.id), kind: "field", of: `db:${db}`, types: u.types as Field["type"][], label: t(`Eigenschaft ${name}`, `Property ${name}`), optional: true });
    } else if (u.kind === "credential")
      out.push({ id: encodeGap(u.id), kind: "toggle", label: t(`Zugangsdaten ${name} – nach dem Import im HTTP-Knoten neu verknüpfen`, `Credential ${name} – link it again in the HTTP node after the import`), optional: true, value: "info" });
    else out.push({ id: encodeGap(u.id), kind: "toggle", label: t(`${name} – im Entwurf neu wählen`, `${name} – choose it again in the draft`), optional: true, value: "info" });
  }
  return out;
}

/* ---------- The assistant ---------- */

function GapAssistant({
  title,
  intro,
  gaps,
  pageId,
  ws,
  optional,
  onClose,
  onDone,
}: {
  title: string;
  intro: string;
  gaps: Gap[];
  pageId: string;
  ws: Workspace;
  optional?: boolean;
  onClose: () => void;
  onDone: (answers: GapAnswers, fields: Map<string, Field[]>) => Promise<void> | void;
}) {
  const t = useStableT();
  const [answers, setAnswers] = useState<GapAnswers>(() => Object.fromEntries(gaps.filter((g) => g.kind === "toggle" && g.value !== "info").map((g) => [g.id, g.value ?? true])));
  const [busy, setBusy] = useState(false);
  // The databases chosen (or fixed by an import) and their properties.
  const dbOf = (g: Gap) => (g.of?.startsWith("db:") ? g.of.slice(3) : gapDatabase(gaps, g, answers));
  const dbs = useMemo(() => [...new Set(gaps.map((g) => (g.kind === "database" ? String(answers[g.id] || "") : g.of ? dbOf(g) : "")).filter(Boolean))].sort(), [gaps, answers]); // eslint-disable-line react-hooks/exhaustive-deps
  const { fields } = useDatabases(dbs);
  const missing = optional ? [] : missingGaps(gaps, answers);
  const set = (id: string, v: unknown) => setAnswers((a) => ({ ...a, [id]: v }));
  return (
    <Modal open onClose={onClose} title={title} wide>
      <div className="wf-dialog wf-assistant">
        <p className="muted">{intro}</p>
        <div className="wf-form">
          {gaps.map((g) => (
            <GapField key={g.id} gap={g} value={answers[g.id]} answers={answers} database={dbOf(g)} fields={fields} pageId={pageId} ws={ws} onChange={(v) => set(g.id, v)} t={t} />
          ))}
        </div>
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button
            type="button"
            className="button primary"
            disabled={busy || missing.length > 0}
            title={missing.length ? t(`Noch offen: ${missing.map((m) => m.label).join(", ")}`, `Still open: ${missing.map((m) => m.label).join(", ")}`) : undefined}
            onClick={async () => {
              setBusy(true);
              try {
                await onDone(answers, fields);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("Als Entwurf anlegen", "Create the draft")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function GapField({ gap: g, value, answers, database, fields, pageId, ws, onChange, t }: { gap: Gap; value: unknown; answers: GapAnswers; database: string; fields: Map<string, Field[]>; pageId: string; ws: Workspace; onChange: (v: unknown) => void; t: T }) {
  const id = useId();
  const v = typeof value === "string" ? value : "";
  const label = g.label + (g.optional || g.kind === "toggle" ? "" : " *");
  const own = database ? fields.get(database) || [] : [];
  if (g.kind === "toggle") {
    if (g.value === "info")
      return (
        <p className="wf-gap-info">
          <Warning aria-hidden /> {g.label}
        </p>
      );
    return (
      <label className="wf-check">
        <input type="checkbox" checked={value !== false} onChange={(e) => onChange(e.target.checked)} />
        <span>{g.label}</span>
      </label>
    );
  }
  if (g.kind === "page")
    return (
      <Labeled id={id} label={label}>
        <PageSelect id={id} value={v} ws={ws} disabled={false} onChange={onChange} t={t} />
        {g.help && <small className="muted">{g.help}</small>}
      </Labeled>
    );
  if (g.kind === "database")
    return (
      <Labeled id={id} label={label}>
        <DatabaseSelect id={id} value={v} ws={ws} disabled={false} onChange={onChange} t={t} />
      </Labeled>
    );
  if (g.kind === "field") {
    const fit = own.filter((f) => !g.types?.length || g.types.includes(f.type));
    return (
      <Labeled id={id} label={label}>
        <FieldSelect id={id} fields={fit} value={v} disabled={!database} onChange={onChange} t={t} empty={database ? undefined : t("Erst die Datenbank wählen", "Choose the database first")} />
      </Labeled>
    );
  }
  if (g.kind === "option") {
    const field = own.find((f) => f.id === answers[g.of || ""]);
    return (
      <Labeled id={id} label={label}>
        <Select id={id} value={v} disabled={!field} onChange={(e) => onChange(e.target.value)}>
          <option value="">{field ? t("Wert wählen …", "Choose a value …") : t("Erst die Eigenschaft wählen", "Choose the property first")}</option>
          {(field?.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
        </Select>
      </Labeled>
    );
  }
  if (g.kind === "routing") {
    const field = own.find((f) => f.id === answers[g.of || ""]);
    const routes = (value && typeof value === "object" ? value : {}) as Record<string, string>;
    return (
      <fieldset className="wf-group">
        <legend>{g.label}</legend>
        {!field && <small className="muted">{t("Erst die Kategorie wählen", "Choose the category first")}</small>}
        {(field?.options || []).slice(0, 20).map((o) => (
          <div className="wf-route" key={o}>
            <span>{o}</span>
            <Select aria-label={t(`Zuständig für ${o}`, `Responsible for ${o}`)} value={routes[o] || ""} onChange={(e) => onChange({ ...routes, [o]: e.target.value })}>
              <option value="">{t("Teamleitung entscheidet", "Team lead decides")}</option>
              {ws.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </Select>
          </div>
        ))}
      </fieldset>
    );
  }
  if (g.kind === "person")
    return (
      <Labeled id={id} label={label}>
        <Select id={id} value={v} onChange={(e) => onChange(e.target.value)}>
          <option value="">{t("Person wählen …", "Choose a person …")}</option>
          {ws.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </Select>
      </Labeled>
    );
  if (g.kind === "chatHook" || g.kind === "address") return <ResourceGap gap={g} id={id} label={label} value={v} pageId={pageId} ws={ws} onChange={onChange} t={t} />;
  return null;
}

// Chat webhooks released for workflows; inbound addresses of this workflow
// (owners create one right here).
function ResourceGap({ gap, id, label, value, pageId, ws, onChange, t }: { gap: Gap; id: string; label: string; value: string; pageId: string; ws: Workspace; onChange: (v: unknown) => void; t: T }) {
  const { res, reload } = useResources(pageId);
  const [sender, setSender] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const items: [string, string][] =
    gap.kind === "chatHook"
      ? (res?.chatHooks || []).map((h) => [h.id, h.host])
      : (res?.addresses || []).map((a) => [a.id, a.label || t("Ohne Namen", "Unnamed")]);
  // A fresh address is chosen as soon as it is there.
  const before = useRef<number | null>(null);
  useEffect(() => {
    if (gap.kind !== "address" || !res) return;
    if (before.current !== null && res.addresses.length > before.current && !value) onChange(res.addresses.at(-1)!.id);
    before.current = res.addresses.length;
  }, [res, gap.kind, value, onChange]);
  return (
    <Labeled id={id} label={label}>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{gap.kind === "chatHook" ? t("Ohne Chat-Nachricht", "Without a chat message") : t("Adresse wählen …", "Choose an address …")}</option>
        {items.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
      </Select>
      {res && !items.length && gap.kind === "chatHook" && <small className="muted">{t("Noch kein Webhook für Workflows freigegeben: Eigentümer tun das in den Einstellungen unter Webhooks.", "No webhook released for workflows yet: owners do that in the settings under Webhooks.")}</small>}
      {gap.kind === "address" && !value && (
        <div className="wf-inline-create">
          <input
            type="text"
            aria-label={t("Erlaubter Absender (Adresse oder Domain)", "Allowed sender (address or domain)")}
            placeholder={t("Erlaubter Absender, z. B. example.com", "Allowed sender, e.g. example.com")}
            value={sender}
            onChange={(e) => setSender(e.target.value)}
          />
          <button
            type="button"
            className="button compact"
            disabled={busy || !sender.trim() || !ws.workspaceId}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await api("/api/command", { action: "inbound.save", workspaceId: ws.workspaceId, pageId, label: t("Workflow", "Workflow"), senders: [sender.trim()] });
                reload();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("Adresse anlegen", "Create an address")}
          </button>
          {error && <small className="wf-error-text" role="alert">{error}</small>}
        </div>
      )}
    </Labeled>
  );
}

/* ---------- AI builder ---------- */

type AiResult = { graph: WorkflowGraph; title: string | null; explanation: string | null; dropped: string[]; gaps: { nodeId: string; key: string }[] };

// "Mit KI entwerfen": a sentence → a draft to review → into the draft.
export function AiBuilderDialog({ open, pageId, replaces, onClose, onApply, onError }: { open: boolean; pageId: string; replaces: boolean; onClose: () => void; onApply: (graph: WorkflowGraph) => void; onError: (e: unknown) => void }) {
  const t = useStableT();
  const locale = useLocale();
  const id = useId();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AiResult | null>(null);
  useEffect(() => {
    if (open) setResult(null);
  }, [open]);
  const issues = useMemo(() => (result ? checkGraph(result.graph).map((i) => ({ ...i, message: issueMessage(i, locale) })) : []), [result, locale]);
  const labels = new Map((result?.graph.nodes || []).map((n) => [n.id, n.label]));
  const gapNodes = new Set((result?.gaps || []).map((g) => g.nodeId));
  return (
    <Modal open={open} onClose={onClose} title={t("Mit KI entwerfen", "Draft with AI")} wide>
      <div className="wf-dialog wf-ai-builder">
        <Labeled id={id} label={t("Was soll der Workflow tun?", "What should the workflow do?")}>
          <textarea
            id={id}
            rows={3}
            maxLength={1000}
            value={prompt}
            placeholder={t("Wenn im Wiki unter Docker eine Seite entsteht, trage sie mit einem Satz Beschreibung auf der Übersicht ein.", "When a page is created below Docker in the wiki, add it with a one-sentence description to the overview.")}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </Labeled>
        <p className="muted wf-hint">
          {t(
            "Die KI sieht nur Namen von Datenbanken, Eigenschaften, Bereichen und Seiten, die du sehen darfst – keine Inhalte. Das Ergebnis ist ein Entwurf: prüfen, ergänzen, dann selbst aktivieren. Kostet KI-Anfragen deines persönlichen Kontingents.",
            "The AI only sees names of databases, properties, spaces and pages you may see – no contents. The result is a draft: check it, complete it, then activate it yourself. Uses AI requests of your personal allowance.",
          )}
        </p>
        {result && (
          <div className="wf-ai-result" aria-live="polite">
            {result.title && <h3>{result.title}</h3>}
            {result.explanation && <p>{result.explanation}</p>}
            <ol className="wf-ai-nodes">
              {result.graph.nodes.map((n) => (
                <li key={n.id} className={gapNodes.has(n.id) ? "has-gap" : undefined}>
                  <strong>{n.label}</strong> <span className="muted">· {typeName(n.type, t)}</span>
                  {gapNodes.has(n.id) && <span className="wf-gap-mark"> {t("– bitte ergänzen", "– please complete")}</span>}
                </li>
              ))}
            </ol>
            {result.dropped.length > 0 && <p className="muted">{t(`Weggelassen (gibt es nicht): ${result.dropped.join(", ")}`, `Left out (does not exist): ${result.dropped.join(", ")}`)}</p>}
            {issues.length > 0 && (
              <ul className="wf-issues">
                {issues.slice(0, 8).map((i, k) => (
                  <li key={k} className={`is-${i.level}`}>
                    {i.nodeId && labels.get(i.nodeId) ? <strong>{labels.get(i.nodeId)}: </strong> : null}
                    {i.message}
                  </li>
                ))}
              </ul>
            )}
            {replaces && <p className="wf-note">{t("Ersetzt den bisherigen Entwurf (mit Rückgängig zurückholbar).", "Replaces the current draft (undo brings it back).")}</p>}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button
            type="button"
            className={result ? "button" : "button primary"}
            disabled={busy || prompt.trim().length < 3}
            onClick={async () => {
              setBusy(true);
              try {
                setResult(await api<AiResult>("/api/ai/workflow/draft", { pageId, prompt: prompt.trim(), locale }));
              } catch (e) {
                onError(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Sparkle aria-hidden /> {busy ? t("Entwirft …", "Drafting …") : result ? t("Neu entwerfen", "Draft again") : t("Entwerfen", "Draft")}
          </button>
          {result && (
            <button type="button" className="button primary" onClick={() => onApply(result.graph)}>
              {t("In den Entwurf übernehmen", "Use as draft")}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
