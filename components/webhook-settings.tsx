"use client";
// Settings → API & Webhooks → Webhooks (lib/webhooks.ts): addresses that
// receive events as signed JSON or as chat messages for Slack, Matrix,
// Microsoft Teams or Discord, with message templates, a live preview, a
// daily digest of due records and a test message.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, PaperPlaneTilt, PencilSimple, Trash } from "@phosphor-icons/react";
import { useLocale, useT } from "./i18n";
import { api } from "./ui";
import { Select } from "./select";
import { LOCALE_TAG, tr } from "@/lib/locale-tag";
import { LANGUAGES, LOCALES, type Locale } from "@/lib/i18n";
import {
  chatFormats,
  defaultTemplate,
  eventLabel,
  messageMarkdown,
  noticeEvents,
  placeholders,
  renderPayload,
  sampleNotice,
  SLACK_POST_MESSAGE,
  TEMPLATE_MAX,
  toMatrixHtml,
  type ChatFormat,
  type HookConfig,
  type NoticeEvent,
  type Templates,
} from "@/lib/notification-templates";

type Hook = {
  id: string;
  url: string;
  events: NoticeEvent[];
  page_id: string | null;
  created_at: number;
  format: ChatFormat;
  templates: Templates;
  config: HookConfig;
  credentials: { token: boolean; signingSecret: boolean };
  repliesUrl: string | null;
  last: { status: number | null; error: string | null; delivered_at: number | null } | null;
  lastError: { error: string; at: number } | null;
};
const when = (ms: number | null) =>
  ms ? new Date(ms).toLocaleString(LOCALE_TAG, { dateStyle: "short", timeStyle: "short" }) : tr("nie", "never");
const localZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Berlin";
  } catch {
    return "Europe/Berlin";
  }
};
const formatName = (format: ChatFormat) =>
  ({ json: "JSON", slack: "Slack", matrix: "Matrix", teams: "Microsoft Teams", discord: "Discord" })[format];

type Draft = {
  url: string;
  events: NoticeEvent[];
  pageId: string;
  format: ChatFormat;
  templates: Templates;
  language: Locale;
  digestTime: string;
  timeZone: string;
  matrixRoom: string;
  slackChannel: string;
  token: string;
  signingSecret: string;
  dropCredentials: boolean;
};
const emptyDraft = (language: Locale): Draft => ({
  url: "",
  events: ["row.created"],
  pageId: "",
  format: "json",
  templates: {},
  language,
  digestTime: "08:00",
  timeZone: localZone(),
  matrixRoom: "",
  slackChannel: "",
  token: "",
  signingSecret: "",
  dropCredentials: false,
});
const draftOf = (hook: Hook): Draft => ({
  url: hook.url,
  events: hook.events,
  pageId: hook.page_id || "",
  format: hook.format,
  templates: hook.templates,
  language: hook.config.language,
  digestTime: hook.config.digestTime,
  timeZone: hook.config.timeZone,
  matrixRoom: hook.config.matrixRoom || "",
  slackChannel: hook.config.slackChannel || "",
  token: "",
  signingSecret: "",
  dropCredentials: false,
});

export function WebhookSettings({
  workspaceId,
  pages,
  onError,
  onSecret,
}: {
  workspaceId: string;
  pages: { id: string; title: string; kind: string }[];
  onError: (message: string) => void;
  onSecret: (secret: string) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [hooks, setHooks] = useState<Hook[]>([]),
    [editing, setEditing] = useState<Hook | null>(null),
    [draft, setDraft] = useState<Draft>(() => emptyDraft(locale)),
    [templateEvent, setTemplateEvent] = useState<NoticeEvent>("row.created"),
    [busy, setBusy] = useState(false),
    [tests, setTests] = useState<Record<string, string>>({});
  const editor = useRef<HTMLTextAreaElement | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await api<{ webhooks: Hook[] }>(`/api/webhooks?workspace=${workspaceId}`);
      setHooks(r.webhooks);
    } catch (e) {
      onError((e as Error).message);
    }
  }, [workspaceId, onError]);
  useEffect(() => void load(), [load]);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const chat = draft.format !== "json";
  const storedToken = !!editing?.credentials.token && !draft.dropCredentials;
  const hasToken = !!draft.token || storedToken;
  const slackBot = draft.format === "slack" && hasToken;
  const matrixApi = draft.format === "matrix" && hasToken;
  const origin = typeof location === "undefined" ? "" : location.origin;

  // The live preview: a sample event rendered with the current settings.
  const preview = useMemo(() => {
    const notice = sampleNotice(templateEvent, draft.language, origin || undefined);
    const options = { templates: draft.templates, config: { language: draft.language, timeZone: draft.timeZone } };
    if (draft.format === "json")
      return {
        html: "",
        raw: { event: templateEvent, id: "…", createdAt: notice.at, workspaceId, data: { pageId: "…", rowId: "…", cells: {} } },
      };
    const { markdown, structured } = messageMarkdown(notice, options);
    return {
      html: toMatrixHtml(markdown),
      changes: structured ? notice.changes : [],
      header: eventLabel(templateEvent, draft.language),
      context: `${notice.actor} · ${new Date(notice.at).toLocaleString(LOCALE_TAG, { dateStyle: "short", timeStyle: "short" })}`,
      raw: renderPayload(draft.format, notice, options),
    };
  }, [draft.format, draft.language, draft.templates, draft.timeZone, templateEvent, origin, workspaceId]);

  const templateValue = draft.templates[templateEvent] ?? defaultTemplate(templateEvent, draft.language);
  const insert = (name: string) => {
    const area = editor.current;
    const token = `{${name}}`;
    const start = area?.selectionStart ?? templateValue.length,
      end = area?.selectionEnd ?? templateValue.length;
    const next = (templateValue.slice(0, start) + token + templateValue.slice(end)).slice(0, TEMPLATE_MAX);
    set("templates", { ...draft.templates, [templateEvent]: next });
    requestAnimationFrame(() => {
      area?.focus();
      area?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const submit = async () => {
    // Only templates that differ from the default are stored.
    const templates: Templates = {};
    for (const [event, text] of Object.entries(draft.templates) as [NoticeEvent, string][])
      if (text.trim() && text !== defaultTemplate(event, draft.language)) templates[event] = text;
    const credentials: { token?: string; signingSecret?: string } = {};
    if (draft.token.trim()) credentials.token = draft.token.trim();
    if (draft.signingSecret.trim()) credentials.signingSecret = draft.signingSecret.trim();
    const body = {
      workspaceId,
      url: slackBot ? SLACK_POST_MESSAGE : draft.url,
      events: draft.events,
      pageId: draft.pageId || null,
      format: draft.format,
      templates: chat ? templates : {},
      config: {
        language: draft.language,
        digestTime: draft.digestTime,
        timeZone: draft.timeZone,
        ...(draft.format === "matrix" && draft.matrixRoom.trim() ? { matrixRoom: draft.matrixRoom.trim() } : {}),
        ...(draft.format === "slack" && draft.slackChannel.trim() ? { slackChannel: draft.slackChannel.trim() } : {}),
      },
    };
    setBusy(true);
    try {
      if (editing) {
        await api("/api/webhooks/update", {
          ...body,
          id: editing.id,
          ...(draft.dropCredentials ? { credentials: null } : Object.keys(credentials).length ? { credentials } : {}),
        });
      } else {
        const r = await api<{ secret: string }>("/api/webhooks", { ...body, ...(Object.keys(credentials).length ? { credentials } : {}) });
        onSecret(r.secret);
      }
      setEditing(null);
      setDraft(emptyDraft(locale));
      await load();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async (hook: Hook) => {
    setTests((s) => ({ ...s, [hook.id]: t("Wird gesendet …", "Sending …") }));
    try {
      const r = await api<{ ok: boolean; status: number | null; error: string | null }>("/api/webhooks/test", { workspaceId, id: hook.id });
      setTests((s) => ({
        ...s,
        [hook.id]: r.ok ? t(`Testnachricht zugestellt (HTTP ${r.status}).`, `Test message delivered (HTTP ${r.status}).`) : t(`Fehler: ${r.error}`, `Error: ${r.error}`),
      }));
      await load();
    } catch (error) {
      setTests((s) => ({ ...s, [hook.id]: (error as Error).message }));
    }
  };

  const addressLabel =
    draft.format === "slack"
      ? t("Adresse des Incoming Webhooks (https://hooks.slack.com/services/…)", "Incoming Webhook address (https://hooks.slack.com/services/…)")
      : draft.format === "matrix"
        ? matrixApi
          ? t("Adresse des Homeservers (https://matrix.example.org)", "Homeserver address (https://matrix.example.org)")
          : t("Adresse des Raum-Webhooks (z. B. hookshot)", "Room webhook address (e.g. hookshot)")
        : draft.format === "teams"
          ? t("Adresse des Teams-Webhooks oder Workflows", "Teams webhook or workflow address")
          : draft.format === "discord"
            ? t("Adresse des Discord-Webhooks (https://discord.com/api/webhooks/…)", "Discord webhook address (https://discord.com/api/webhooks/…)")
            : t("Adresse des Webhooks", "Webhook address");

  return (
    <section className="settings-section">
      <h2>{t("Webhooks", "Webhooks")}</h2>
      <p className="muted">
        {t("Flowplan schickt bei den gewählten Ereignissen ein JSON per POST an die Adresse. Die Kopfzeile", "On the chosen events Flowplan sends a JSON POST to the address. The header")}{" "}
        <code>X-Flowplan-Signature</code> {t("enthält", "contains")} <code>sha256=</code>{" "}
        {t("und die HMAC-Signatur des Inhalts mit dem geheimen Schlüssel des Webhooks. Fehlgeschlagene Zustellungen werden wiederholt.", "and the HMAC signature of the content with the webhook's secret key. Failed deliveries are retried.")}{" "}
        {t("Für Slack, Matrix, Microsoft Teams und Discord kommt stattdessen eine fertige Chatnachricht an.", "For Slack, Matrix, Microsoft Teams and Discord a ready chat message arrives instead.")}
      </p>
      <form
        className="integration-form hooks"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {editing && (
          <p className="webhook-editing">
            {t("Bearbeiten:", "Editing:")} <strong>{editing.url}</strong>
          </p>
        )}
        <Select value={draft.format} onChange={(e) => set("format", e.target.value as ChatFormat)} aria-label={t("Format", "Format")}>
          {chatFormats.map((f) => (
            <option key={f} value={f}>
              {f === "json" ? t("JSON (n8n, Home Assistant, eigene Dienste)", "JSON (n8n, Home Assistant, own services)") : formatName(f)}
            </option>
          ))}
        </Select>
        {!slackBot && (
          <input
            required
            type="url"
            value={draft.url}
            onChange={(e) => set("url", e.target.value)}
            placeholder={draft.format === "json" ? "https://n8n.example.com/webhook/…" : "https://…"}
            aria-label={addressLabel}
            title={addressLabel}
          />
        )}
        <Select value={draft.pageId} onChange={(e) => set("pageId", e.target.value)} aria-label={t("Nur für Datenbank", "Only for database")}>
          <option value="">{t("Alle Seiten und Datenbanken", "All pages and databases")}</option>
          {pages
            .filter((p) => p.kind === "database")
            .map((p) => (
              <option key={p.id} value={p.id}>
                {t("Nur", "Only")} {p.title || t("Ohne Titel", "Untitled")}
              </option>
            ))}
        </Select>
        {(draft.format === "slack" || draft.format === "matrix") && (
          <fieldset>
            <legend>
              {draft.format === "slack"
                ? t("Optional: Slack-App mit Bot-Token (Antworten im Thread werden Kommentare)", "Optional: Slack app with a bot token (thread replies become comments)")
                : t("Optional: Matrix-Client-API mit Zugriffstoken", "Optional: Matrix client API with an access token")}
            </legend>
            <input
              type="password"
              autoComplete="off"
              value={draft.token}
              onChange={(e) => set("token", e.target.value)}
              placeholder={
                storedToken
                  ? t("gespeichert – leer lassen zum Behalten", "stored – leave empty to keep")
                  : draft.format === "slack"
                    ? "xoxb-…"
                    : t("Zugriffstoken des Bot-Kontos", "Access token of the bot account")
              }
              aria-label={draft.format === "slack" ? t("Bot-Token", "Bot token") : t("Zugriffstoken", "Access token")}
            />
            {draft.format === "slack" && hasToken && (
              <>
                <input
                  required
                  value={draft.slackChannel}
                  onChange={(e) => set("slackChannel", e.target.value)}
                  placeholder={t("Kanal-ID, z. B. C0123456789", "Channel ID, e.g. C0123456789")}
                  aria-label={t("Kanal-ID", "Channel ID")}
                />
                <input
                  type="password"
                  autoComplete="off"
                  value={draft.signingSecret}
                  onChange={(e) => set("signingSecret", e.target.value)}
                  placeholder={
                    editing?.credentials.signingSecret && !draft.dropCredentials
                      ? t("Signing Secret gespeichert – leer lassen zum Behalten", "Signing secret stored – leave empty to keep")
                      : t("Signing Secret (für Antworten aus Slack)", "Signing secret (for replies from Slack)")
                  }
                  aria-label={t("Signing Secret", "Signing secret")}
                />
              </>
            )}
            {draft.format === "matrix" && hasToken && (
              <input
                required
                value={draft.matrixRoom}
                onChange={(e) => set("matrixRoom", e.target.value)}
                placeholder="!raum:example.org"
                aria-label={t("Raum (!id:server oder #alias:server)", "Room (!id:server or #alias:server)")}
              />
            )}
            {editing?.credentials.token && (
              <label className="checkbox-label">
                <input type="checkbox" checked={draft.dropCredentials} onChange={(e) => set("dropCredentials", e.target.checked)} />
                {t("Gespeicherte Zugangsdaten entfernen", "Remove stored credentials")}
              </label>
            )}
          </fieldset>
        )}
        <fieldset>
          <legend>{t("Ereignisse", "Events")}</legend>
          {noticeEvents.map((id) => (
            <label key={id} className="checkbox-label">
              <input
                type="checkbox"
                checked={draft.events.includes(id)}
                onChange={(e) => set("events", e.target.checked ? [...draft.events, id] : draft.events.filter((x) => x !== id))}
              />
              {eventLabel(id, locale)} <code>{id}</code>
              {id === "digest.due" && draft.events.includes(id) && (
                <span className="webhook-digest">
                  {t("täglich um", "daily at")}{" "}
                  <input type="time" value={draft.digestTime} onChange={(e) => set("digestTime", e.target.value || "08:00")} aria-label={t("Uhrzeit der Übersicht", "Digest time")} />{" "}
                  <small>{draft.timeZone}</small>
                </span>
              )}
            </label>
          ))}
        </fieldset>
        {chat && (
          <fieldset className="webhook-template">
            <legend>{t("Nachricht", "Message")}</legend>
            <div className="webhook-template-bar">
              <Select value={templateEvent} onChange={(e) => setTemplateEvent(e.target.value as NoticeEvent)} aria-label={t("Vorlage für Ereignis", "Template for event")}>
                {noticeEvents.map((id) => (
                  <option key={id} value={id}>
                    {eventLabel(id, locale)}
                  </option>
                ))}
              </Select>
              <Select value={draft.language} onChange={(e) => set("language", e.target.value as Locale)} aria-label={t("Sprache der Nachrichten", "Language of the messages")}>
                {LOCALES.map((l) => (
                  <option key={l} value={l}>
                    {LANGUAGES[l].name}
                  </option>
                ))}
              </Select>
            </div>
            <textarea
              ref={editor}
              rows={3}
              maxLength={TEMPLATE_MAX}
              value={templateValue}
              onChange={(e) => set("templates", { ...draft.templates, [templateEvent]: e.target.value })}
              aria-label={t("Vorlage der Nachricht", "Message template")}
            />
            <div className="webhook-placeholders">
              {placeholders.map((p) => (
                <button key={p} type="button" className="button compact" onClick={() => insert(p)}>
                  {`{${p}}`}
                </button>
              ))}
              {draft.templates[templateEvent] !== undefined && (
                <button
                  type="button"
                  className="button compact"
                  onClick={() => {
                    const next = { ...draft.templates };
                    delete next[templateEvent];
                    set("templates", next);
                  }}
                >
                  {t("Standardtext", "Default text")}
                </button>
              )}
            </div>
            <small className="muted">
              {t("Markdown: **fett**, _kursiv_, `Code`, [Text](Adresse), Zeilen mit „- “ als Liste und „> “ als Zitat.", "Markdown: **bold**, _italic_, `code`, [text](address), lines starting with “- ” as a list and “> ” as a quote.")}
            </small>
          </fieldset>
        )}
        <fieldset className="webhook-preview" aria-live="polite">
          <legend>
            {t("Vorschau", "Preview")} · {eventLabel(templateEvent, locale)}
          </legend>
          {chat && "header" in preview && (
            <div className="webhook-preview-card">
              <strong>{preview.header}</strong>
              {/* Built by lib/notification-templates.ts: every text is escaped, links are http(s) only. */}
              <div dangerouslySetInnerHTML={{ __html: preview.html }} />
              {!!preview.changes?.length && (
                <dl>
                  {preview.changes.map((c) => (
                    <div key={c.name}>
                      <dt>{c.name}</dt>
                      <dd>{c.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <small className="muted">{preview.context}</small>
            </div>
          )}
          <details open={!chat}>
            <summary>{t("Gesendeter Inhalt", "Sent content")}</summary>
            <pre className="mcp-config">{JSON.stringify(preview.raw, null, 2)}</pre>
          </details>
        </fieldset>
        <button className="button primary" disabled={!draft.events.length || busy}>
          {editing ? t("Änderungen speichern", "Save changes") : t("Webhook anlegen", "Create webhook")}
        </button>
        {editing && (
          <button
            type="button"
            className="button"
            onClick={() => {
              setEditing(null);
              setDraft(emptyDraft(locale));
            }}
          >
            {t("Abbrechen", "Cancel")}
          </button>
        )}
      </form>
      <ul className="integration-list">
        {hooks.map((h) => (
          <li key={h.id}>
            <span>
              <strong>{h.url}</strong>
              <small>
                {formatName(h.format)} · {h.events.join(", ")} ·{" "}
                {h.last
                  ? h.last.delivered_at
                    ? t(`zuletzt zugestellt ${when(h.last.delivered_at)}`, `last delivered ${when(h.last.delivered_at)}`)
                    : t(`Fehler: ${h.last.error || h.last.status}`, `Error: ${h.last.error || h.last.status}`)
                  : t("noch nichts gesendet", "nothing sent yet")}
              </small>
              {h.lastError && h.last?.delivered_at && (
                <small>{t(`Letzter Fehler (${when(h.lastError.at)}): ${h.lastError.error}`, `Last error (${when(h.lastError.at)}): ${h.lastError.error}`)}</small>
              )}
              {h.repliesUrl && (
                <small>
                  {t("Request URL für Slack-Events:", "Request URL for Slack events:")} <code>{h.repliesUrl}</code>{" "}
                  <button type="button" className="icon-button" aria-label={t("Adresse kopieren", "Copy address")} onClick={() => void navigator.clipboard.writeText(h.repliesUrl!).catch(() => {})}>
                    <Copy size={12} />
                  </button>
                </small>
              )}
              {tests[h.id] && <small role="status">{tests[h.id]}</small>}
            </span>
            <span className="webhook-actions">
              <button type="button" className="button compact" onClick={() => void sendTest(h)}>
                <PaperPlaneTilt size={14} /> {t("Testnachricht senden", "Send test message")}
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={t(`Webhook ${h.url} bearbeiten`, `Edit webhook ${h.url}`)}
                title={t("Bearbeiten", "Edit")}
                onClick={() => {
                  setEditing(h);
                  setDraft(draftOf(h));
                }}
              >
                <PencilSimple size={16} />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={t(`Webhook ${h.url} löschen`, `Delete webhook ${h.url}`)}
                title={t("Löschen", "Delete")}
                onClick={async () => {
                  await api("/api/command", { action: "webhook.delete", workspaceId, id: h.id }).catch((e) => onError((e as Error).message));
                  if (editing?.id === h.id) {
                    setEditing(null);
                    setDraft(emptyDraft(locale));
                  }
                  await load();
                }}
              >
                <Trash size={16} />
              </button>
            </span>
          </li>
        ))}
        {!hooks.length && <li className="muted">{t("Noch keine Webhooks.", "No webhooks yet.")}</li>}
      </ul>
    </section>
  );
}
