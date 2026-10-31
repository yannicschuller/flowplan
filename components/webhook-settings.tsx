"use client";
// Settings → Webhooks (lib/webhooks.ts): addresses that receive events as
// signed JSON or as chat messages for Slack, Matrix, Microsoft Teams or
// Discord, with message templates, a live preview, a daily digest of due
// records and a test message. The section lists the webhooks; each one has
// its own page (#settings/webhooks/<id>, a new one #settings/webhooks/new).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Copy, PaperPlaneTilt, PencilSimple, Plus, WebhooksLogo } from "@phosphor-icons/react";
import { useLocale, useT } from "./i18n";
import { api } from "./ui";
import { Select } from "./select";
import { CONTROL, DangerZone, EmptyState, SettingGroup, SettingRow, StatusBadge, Switch, SwitchRow } from "./settings-ui";
import { FreshSecret } from "./integration-settings";
import { LOCALE_TAG, tr } from "@/lib/locale-tag";
import { LANGUAGES, LOCALES, type Locale } from "@/lib/i18n";
import { settingsHash } from "@/lib/settings-sections";
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
type Page = { id: string; title: string; kind: string };
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
// The address of the list and of one webhook's page.
export const webhookHash = (anchor?: string) => settingsHash({ area: "settings", section: "webhooks", anchor });

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

// The state of the last delivery as a badge.
function Delivery({ hook }: { hook: Hook }) {
  const t = useT();
  if (!hook.last) return <StatusBadge tone="off">{t("Noch nichts gesendet", "Nothing sent yet")}</StatusBadge>;
  if (hook.last.delivered_at) return <StatusBadge tone="ok">{t(`Zugestellt ${when(hook.last.delivered_at)}`, `Delivered ${when(hook.last.delivered_at)}`)}</StatusBadge>;
  return <StatusBadge tone="error">{t(`Fehler: ${hook.last.error || hook.last.status}`, `Error: ${hook.last.error || hook.last.status}`)}</StatusBadge>;
}

export function WebhookSettings({
  workspaceId,
  pages,
  onError,
  view,
}: {
  workspaceId: string;
  pages: Page[];
  onError: (message: string) => void;
  // null: the list; "new": a new webhook; else the id of the webhook shown.
  view: string | null;
}) {
  const t = useT();
  const locale = useLocale();
  const [hooks, setHooks] = useState<Hook[] | null>(null),
    [tests, setTests] = useState<Record<string, string>>({}),
    [secret, setSecret] = useState("");
  const load = useCallback(async () => {
    try {
      const r = await api<{ webhooks: Hook[] }>(`/api/webhooks?workspace=${workspaceId}`);
      setHooks(r.webhooks);
    } catch (e) {
      onError((e as Error).message);
    }
  }, [workspaceId, onError]);
  useEffect(() => void load(), [load]);
  // The secret belongs to the webhook just created; it goes with the next page.
  useEffect(() => {
    if (view) setSecret("");
  }, [view]);

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

  if (view) {
    if (!hooks)
      return (
        <p className="settings-loading" role="status">
          {t("Wird geladen …", "Loading …")}
        </p>
      );
    const hook = view === "new" ? null : hooks.find((h) => h.id === view);
    if (hook === undefined)
      return (
        <EmptyState icon={<WebhooksLogo size={20} />} title={t("Diesen Webhook gibt es nicht mehr", "This webhook no longer exists")} action={<a className="button" href={webhookHash()}>{t("Alle Webhooks", "All webhooks")}</a>} />
      );
    return (
      <WebhookEditor
        key={view}
        anchor={view}
        hook={hook}
        workspaceId={workspaceId}
        pages={pages}
        locale={locale}
        test={tests[view]}
        onTest={sendTest}
        onError={onError}
        onDone={async (created) => {
          await load();
          location.hash = webhookHash();
          if (created) setSecret(created);
        }}
      />
    );
  }

  return (
    <SettingGroup
      id="list"
      title={t("Webhooks des Arbeitsbereichs", "Webhooks of the workspace")}
      description={
        <>
          {t("Flowplan schickt bei den gewählten Ereignissen ein JSON per POST an die Adresse. Die Kopfzeile", "On the chosen events Flowplan sends a JSON POST to the address. The header")} <code>X-Flowplan-Signature</code> {t("enthält", "contains")} <code>sha256=</code>{" "}
          {t("und die HMAC-Signatur des Inhalts mit dem geheimen Schlüssel des Webhooks. Fehlgeschlagene Zustellungen werden wiederholt.", "and the HMAC signature of the content with the webhook's secret key. Failed deliveries are retried.")}{" "}
          {t("Für Slack, Matrix, Microsoft Teams und Discord kommt stattdessen eine fertige Chatnachricht an.", "For Slack, Matrix, Microsoft Teams and Discord a ready chat message arrives instead.")}
        </>
      }
      actions={
        hooks?.length ? (
          <a className="button primary" href={webhookHash("new")}>
            <Plus size={16} aria-hidden /> {t("Webhook anlegen", "Create webhook")}
          </a>
        ) : undefined
      }
    >
      {secret && (
        <div className="setting-row wide">
          <FreshSecret label={t("Geheimer Schlüssel des Webhooks", "Webhook secret key")} value={secret} />
        </div>
      )}
      {!hooks ? (
        <p className="setting-note settings-loading" role="status">
          {t("Wird geladen …", "Loading …")}
        </p>
      ) : !hooks.length ? (
        <div className="setting-row wide">
          <EmptyState
            icon={<WebhooksLogo size={20} />}
            title={t("Noch keine Webhooks", "No webhooks yet")}
            action={
              <a className="button primary" href={webhookHash("new")}>
                <Plus size={16} aria-hidden /> {t("Webhook anlegen", "Create webhook")}
              </a>
            }
          >
            {t("Zum Beispiel für n8n, Home Assistant oder einen Chat-Kanal.", "For example for n8n, Home Assistant or a chat channel.")}
          </EmptyState>
        </div>
      ) : (
        <ul className="webhook-list">
          {hooks.map((h) => (
            <li key={h.id} className="webhook-item">
              <div className="webhook-item-main">
                <a className="webhook-url" href={webhookHash(h.id)}>
                  {h.url}
                </a>
                <span className="webhook-meta">
                  <StatusBadge tone="info">{formatName(h.format)}</StatusBadge>
                  <Delivery hook={h} />
                </span>
                <small>{h.events.map((e) => eventLabel(e, locale)).join(" · ")}</small>
                {h.lastError && h.last?.delivered_at && <small className="error">{t(`Letzter Fehler (${when(h.lastError.at)}): ${h.lastError.error}`, `Last error (${when(h.lastError.at)}): ${h.lastError.error}`)}</small>}
                {tests[h.id] && <small role="status">{tests[h.id]}</small>}
              </div>
              <div className="webhook-actions">
                <button type="button" className="button" onClick={() => void sendTest(h)}>
                  <PaperPlaneTilt size={15} aria-hidden /> {t("Testnachricht senden", "Send test message")}
                </button>
                <a className="button" href={webhookHash(h.id)} aria-label={t(`Webhook ${h.url} bearbeiten`, `Edit webhook ${h.url}`)}>
                  <PencilSimple size={15} aria-hidden /> {t("Bearbeiten", "Edit")}
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}
    </SettingGroup>
  );
}

// One webhook's page: target, events, message, preview, delivery and – for
// an existing one – deleting it.
function WebhookEditor({
  anchor,
  hook,
  workspaceId,
  pages,
  locale,
  test,
  onTest,
  onError,
  onDone,
}: {
  anchor: string;
  hook: Hook | null;
  workspaceId: string;
  pages: Page[];
  locale: Locale;
  test?: string;
  onTest: (hook: Hook) => Promise<void>;
  onError: (message: string) => void;
  onDone: (createdSecret?: string) => Promise<void>;
}) {
  const t = useT();
  const [draft, setDraft] = useState<Draft>(() => (hook ? draftOf(hook) : emptyDraft(locale))),
    [templateEvent, setTemplateEvent] = useState<NoticeEvent>("row.created"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const editor = useRef<HTMLTextAreaElement | null>(null);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const chat = draft.format !== "json";
  const storedToken = !!hook?.credentials.token && !draft.dropCredentials;
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
    setError("");
    try {
      if (hook) {
        await api("/api/webhooks/update", {
          ...body,
          id: hook.id,
          ...(draft.dropCredentials ? { credentials: null } : Object.keys(credentials).length ? { credentials } : {}),
        });
        await onDone();
      } else {
        const r = await api<{ secret: string }>("/api/webhooks", { ...body, ...(Object.keys(credentials).length ? { credentials } : {}) });
        await onDone(r.secret);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!hook || !confirm(t("Webhook löschen? Es werden keine Ereignisse mehr an die Adresse gesendet.", "Delete the webhook? No more events are sent to the address."))) return;
    try {
      await api("/api/command", { action: "webhook.delete", workspaceId, id: hook.id });
      await onDone();
    } catch (e) {
      onError((e as Error).message);
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
    <div className="webhook-editor" id={anchor}>
      <div className="webhook-editor-head">
        <a className="button" href={webhookHash()}>
          <ArrowLeft size={16} aria-hidden /> {t("Alle Webhooks", "All webhooks")}
        </a>
        <h2>{hook ? hook.url : t("Neuer Webhook", "New webhook")}</h2>
      </div>
      <form
        method="post"
        action="/api/auth/no-script"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <SettingGroup id="target" title={t("Ziel", "Target")} description={t("Wohin Flowplan die Ereignisse schickt und in welchem Format.", "Where Flowplan sends the events and in which format.")}>
          <SettingRow id="webhook-format" label={t("Format", "Format")}>
            <Select id="webhook-format" className={CONTROL.lg} value={draft.format} onChange={(e) => set("format", e.target.value as ChatFormat)}>
              {chatFormats.map((f) => (
                <option key={f} value={f}>
                  {f === "json" ? t("JSON (n8n, Home Assistant, eigene Dienste)", "JSON (n8n, Home Assistant, own services)") : formatName(f)}
                </option>
              ))}
            </Select>
          </SettingRow>
          {!slackBot && (
            <SettingRow id="webhook-url" label={t("Adresse", "Address")} description={addressLabel}>
              <input id="webhook-url" className={CONTROL.lg} required type="url" value={draft.url} onChange={(e) => set("url", e.target.value)} placeholder={draft.format === "json" ? "https://n8n.example.com/webhook/…" : "https://…"} />
            </SettingRow>
          )}
          <SettingRow id="webhook-page" label={t("Nur für Datenbank", "Only for database")} description={t("Ohne Auswahl: Ereignisse aller Seiten und Datenbanken.", "Without a choice: events of all pages and databases.")}>
            <Select id="webhook-page" className={CONTROL.lg} value={draft.pageId} onChange={(e) => set("pageId", e.target.value)}>
              <option value="">{t("Alle Seiten und Datenbanken", "All pages and databases")}</option>
              {pages
                .filter((p) => p.kind === "database")
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {t("Nur", "Only")} {p.title || t("Ohne Titel", "Untitled")}
                  </option>
                ))}
            </Select>
          </SettingRow>
          {(draft.format === "slack" || draft.format === "matrix") && (
            <>
              <SettingRow
                id="webhook-token"
                label={draft.format === "slack" ? t("Bot-Token", "Bot token") : t("Zugriffstoken", "Access token")}
                description={
                  draft.format === "slack"
                    ? t("Optional: Slack-App mit Bot-Token (Antworten im Thread werden Kommentare)", "Optional: Slack app with a bot token (thread replies become comments)")
                    : t("Optional: Matrix-Client-API mit Zugriffstoken", "Optional: Matrix client API with an access token")
                }
              >
                <input
                  id="webhook-token"
                  className={CONTROL.lg}
                  type="password"
                  autoComplete="off"
                  value={draft.token}
                  onChange={(e) => set("token", e.target.value)}
                  placeholder={storedToken ? t("gespeichert – leer lassen zum Behalten", "stored – leave empty to keep") : draft.format === "slack" ? "xoxb-…" : ""}
                />
              </SettingRow>
              {draft.format === "slack" && hasToken && (
                <>
                  <SettingRow id="webhook-channel" label={t("Kanal-ID", "Channel ID")} description={t("Zum Beispiel C0123456789.", "For example C0123456789.")}>
                    <input id="webhook-channel" className={CONTROL.lg} required value={draft.slackChannel} onChange={(e) => set("slackChannel", e.target.value)} />
                  </SettingRow>
                  <SettingRow id="webhook-signing" label={t("Signing Secret", "Signing secret")} description={t("Für Antworten aus Slack.", "For replies from Slack.")}>
                    <input
                      id="webhook-signing"
                      className={CONTROL.lg}
                      type="password"
                      autoComplete="off"
                      value={draft.signingSecret}
                      onChange={(e) => set("signingSecret", e.target.value)}
                      placeholder={hook?.credentials.signingSecret && !draft.dropCredentials ? t("gespeichert – leer lassen zum Behalten", "stored – leave empty to keep") : ""}
                    />
                  </SettingRow>
                </>
              )}
              {draft.format === "matrix" && hasToken && (
                <SettingRow id="webhook-room" label={t("Raum", "Room")} description={t("!id:server oder #alias:server", "!id:server or #alias:server")}>
                  <input id="webhook-room" className={CONTROL.lg} required value={draft.matrixRoom} onChange={(e) => set("matrixRoom", e.target.value)} placeholder="!raum:example.org" />
                </SettingRow>
              )}
              {hook?.credentials.token && <SwitchRow label={t("Gespeicherte Zugangsdaten entfernen", "Remove stored credentials")} checked={draft.dropCredentials} onChange={(on) => set("dropCredentials", on)} />}
            </>
          )}
        </SettingGroup>

        <SettingGroup id="events" title={t("Ereignisse", "Events")} description={t("Bei welchen Ereignissen eine Nachricht kommt. Mindestens eines.", "Which events send a message. At least one.")}>
          {noticeEvents.map((id) => (
            <div className="setting-row webhook-event" key={id}>
              <div className="setting-text">
                <span className="setting-label">{eventLabel(id, locale)}</span>
                <small>
                  <code>{id}</code>
                  {id === "digest.due" && draft.events.includes(id) && (
                    <span className="webhook-digest">
                      {" "}
                      {t("täglich um", "daily at")} <input type="time" value={draft.digestTime} onChange={(e) => set("digestTime", e.target.value || "08:00")} aria-label={t("Uhrzeit der Übersicht", "Digest time")} /> {draft.timeZone}
                    </span>
                  )}
                </small>
              </div>
              <div className="setting-control">
                <Switch label={eventLabel(id, locale)} checked={draft.events.includes(id)} onChange={(on) => set("events", on ? [...draft.events, id] : draft.events.filter((x) => x !== id))} />
              </div>
            </div>
          ))}
        </SettingGroup>

        {chat && (
          <SettingGroup id="message" title={t("Nachricht", "Message")} description={t("Der Text je Ereignis, mit Platzhaltern. Ohne Änderung gilt der Standardtext.", "The text per event, with placeholders. Unchanged, the default text applies.")}>
            <SettingRow id="webhook-template-event" label={t("Vorlage für Ereignis", "Template for event")}>
              <Select id="webhook-template-event" className={CONTROL.md} value={templateEvent} onChange={(e) => setTemplateEvent(e.target.value as NoticeEvent)}>
                {noticeEvents.map((id) => (
                  <option key={id} value={id}>
                    {eventLabel(id, locale)}
                  </option>
                ))}
              </Select>
            </SettingRow>
            <SettingRow id="webhook-language" label={t("Sprache der Nachrichten", "Language of the messages")}>
              <Select id="webhook-language" className={CONTROL.md} value={draft.language} onChange={(e) => set("language", e.target.value as Locale)}>
                {LOCALES.map((l) => (
                  <option key={l} value={l}>
                    {LANGUAGES[l].name}
                  </option>
                ))}
              </Select>
            </SettingRow>
            <SettingRow
              wide
              id="webhook-template"
              label={t("Vorlage der Nachricht", "Message template")}
              description={t("Markdown: **fett**, _kursiv_, `Code`, [Text](Adresse), Zeilen mit „- “ als Liste und „> “ als Zitat.", "Markdown: **bold**, _italic_, `code`, [text](address), lines starting with “- ” as a list and “> ” as a quote.")}
            >
              <div className="webhook-template">
                <textarea id="webhook-template" ref={editor} rows={3} maxLength={TEMPLATE_MAX} value={templateValue} onChange={(e) => set("templates", { ...draft.templates, [templateEvent]: e.target.value })} />
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
              </div>
            </SettingRow>
          </SettingGroup>
        )}

        <SettingGroup id="preview" title={`${t("Vorschau", "Preview")} · ${eventLabel(templateEvent, locale)}`}>
          <div className="setting-row wide webhook-preview" aria-live="polite">
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
          </div>
        </SettingGroup>

        {hook && (
          <SettingGroup id="delivery" title={t("Zustellung", "Delivery")}>
            <SettingRow label={t("Letzte Zustellung", "Last delivery")} description={test || (hook.lastError && hook.last?.delivered_at ? t(`Letzter Fehler (${when(hook.lastError.at)}): ${hook.lastError.error}`, `Last error (${when(hook.lastError.at)}): ${hook.lastError.error}`) : undefined)}>
              <Delivery hook={hook} />
              <button type="button" className="button" onClick={() => void onTest(hook)}>
                <PaperPlaneTilt size={15} aria-hidden /> {t("Testnachricht senden", "Send test message")}
              </button>
            </SettingRow>
            {hook.repliesUrl && (
              <SettingRow label={t("Request URL für Slack-Events", "Request URL for Slack events")} description={<code>{hook.repliesUrl}</code>}>
                <button type="button" className="button" onClick={() => void navigator.clipboard.writeText(hook.repliesUrl!).catch(() => {})}>
                  <Copy size={14} aria-hidden /> {t("Adresse kopieren", "Copy address")}
                </button>
              </SettingRow>
            )}
          </SettingGroup>
        )}

        <div className="webhook-editor-actions">
          {error && (
            <span role="alert" className="save-state error">
              {error}
            </span>
          )}
          <a className="button" href={webhookHash()}>
            {t("Abbrechen", "Cancel")}
          </a>
          <button className="button primary" disabled={!draft.events.length || busy}>
            {hook ? t("Änderungen speichern", "Save changes") : t("Webhook anlegen", "Create webhook")}
          </button>
        </div>
      </form>

      {hook && (
        <DangerZone id="delete">
          <SettingRow label={t("Webhook löschen", "Delete webhook")} description={t("Es werden keine Ereignisse mehr an diese Adresse gesendet.", "No more events are sent to this address.")}>
            <button type="button" className="button danger" onClick={() => void remove()}>
              {t("Webhook löschen …", "Delete webhook …")}
            </button>
          </SettingRow>
        </DangerZone>
      )}
    </div>
  );
}
