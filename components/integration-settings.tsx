"use client";
import { useT } from "./i18n";
import { LOCALE_TAG, tr } from "@/lib/locale-tag";
import { useCallback, useEffect, useState } from "react";
import { Copy, Trash } from "@phosphor-icons/react";
import { api } from "./ui";
import { Select } from "./select";

type Token = {
  id: string;
  name: string;
  scope: "read" | "write";
  prefix: string;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
};
type Hook = {
  id: string;
  url: string;
  events: string[];
  page_id: string | null;
  created_at: number;
  last: { status: number | null; error: string | null; delivered_at: number | null } | null;
};
const when = (ms: number | null) =>
  ms ? new Date(ms).toLocaleString(LOCALE_TAG, { dateStyle: "short", timeStyle: "short" }) : tr("nie", "never");

// Settings → API & Webhooks: personal tokens for everyone, webhooks for
// workspace owners (lib/api-tokens.ts, lib/webhooks.ts).
export function IntegrationSettings({
  workspaceId,
  owner,
  pages,
  onError,
}: {
  workspaceId: string;
  owner: boolean;
  pages: { id: string; title: string; kind: string }[];
  onError: (message: string) => void;
}) {
  const t = useT();
  const [tokens, setTokens] = useState<Token[]>([]),
    [tokenName, setTokenName] = useState(""),
    [scope, setScope] = useState<"read" | "write">("read"),
    [fresh, setFresh] = useState<{ label: string; value: string } | null>(null),
    [hooks, setHooks] = useState<Hook[]>([]),
    [events, setEvents] = useState<Record<string, string>>({}),
    [hookUrl, setHookUrl] = useState(""),
    [hookEvents, setHookEvents] = useState<string[]>(["row.created"]),
    [hookPage, setHookPage] = useState("");
  const load = useCallback(async () => {
    try {
      setTokens(await api<Token[]>("/api/tokens"));
      if (owner) {
        const r = await api<{ webhooks: Hook[]; events: Record<string, string> }>(
          `/api/webhooks?workspace=${workspaceId}`,
        );
        setHooks(r.webhooks);
        setEvents(r.events);
      }
    } catch (e) {
      onError((e as Error).message);
    }
  }, [owner, workspaceId, onError]);
  useEffect(() => void load(), [load]);
  const origin = typeof location === "undefined" ? "" : location.origin;
  return (
    <>
      <section className="settings-section">
        <h2>{t("Persönliche API-Tokens", "Personal API tokens")}</h2>
        <p className="muted">
          {t("Für Skripte, n8n oder Home Assistant: Anfragen mit", "For scripts, n8n or Home Assistant: requests with")}{" "}
          <code>Authorization: Bearer fp_…</code> {t("handeln mit deinen Rechten. Lese-Tokens können nichts ändern. Beispiel:", "act with your permissions. Read tokens cannot change anything. Example:")}{" "}
          <code>curl -H &quot;Authorization: Bearer fp_…&quot; {origin}/api/bootstrap</code>
        </p>
        <form
          className="integration-form"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const r = await api<{ token: string }>("/api/command", {
                action: "token.create",
                name: tokenName,
                scope,
              });
              setFresh({ label: t(`Token „${tokenName}“`, `Token “${tokenName}”`), value: r.token });
              setTokenName("");
              await load();
            } catch (error) {
              onError((error as Error).message);
            }
          }}
        >
          <input
            required
            maxLength={80}
            value={tokenName}
            onChange={(e) => setTokenName(e.target.value)}
            placeholder={t("Name, z. B. Home Assistant", "Name, e.g. Home Assistant")}
            aria-label={t("Name des Tokens", "Token name")}
          />
          <Select value={scope} onChange={(e) => setScope(e.target.value as "read" | "write")} aria-label={t("Rechte des Tokens", "Token permissions")}>
            <option value="read">{t("Nur lesen", "Read only")}</option>
            <option value="write">{t("Lesen und schreiben", "Read and write")}</option>
          </Select>
          <button className="button primary">{t("Token erstellen", "Create token")}</button>
        </form>
        {fresh && (
          <div className="integration-secret" role="status">
            <strong>{fresh.label} {t("– nur jetzt sichtbar:", "– visible only now:")}</strong>
            <code>{fresh.value}</code>
            <button
              className="button compact"
              onClick={() => void navigator.clipboard.writeText(fresh.value).catch(() => {})}
            >
              <Copy size={14} /> {t("Kopieren", "Copy")}
            </button>
          </div>
        )}
        <ul className="integration-list">
          {tokens.map((token) => (
            <li key={token.id}>
              <span>
                <strong>{token.name}</strong>
                <small>
                  {token.prefix}… · {token.scope === "read" ? t("nur lesen", "read only") : t("lesen und schreiben", "read and write")} · {t("zuletzt benutzt:", "last used:")}{" "}
                  {when(token.last_used_at)}
                </small>
              </span>
              <button
                className="icon-button"
                aria-label={t(`Token ${token.name} widerrufen`, `Revoke token ${token.name}`)}
                title={t("Widerrufen", "Revoke")}
                onClick={async () => {
                  await api("/api/command", { action: "token.revoke", id: token.id }).catch((e) =>
                    onError((e as Error).message),
                  );
                  await load();
                }}
              >
                <Trash size={16} />
              </button>
            </li>
          ))}
          {!tokens.length && <li className="muted">{t("Noch keine Tokens.", "No tokens yet.")}</li>}
        </ul>
      </section>
      {owner && (
        <section className="settings-section">
          <h2>{t("Webhooks", "Webhooks")}</h2>
          <p className="muted">
            {t("Flowplan schickt bei den gewählten Ereignissen ein JSON per POST an die Adresse. Die Kopfzeile", "On the chosen events Flowplan sends a JSON POST to the address. The header")}{" "}<code>X-Flowplan-Signature</code> {t("enthält", "contains")}{" "}
            <code>sha256=</code> {t("und die HMAC-Signatur des Inhalts mit dem geheimen Schlüssel des Webhooks. Fehlgeschlagene Zustellungen werden wiederholt.", "and the HMAC signature of the content with the webhook's secret key. Failed deliveries are retried.")}
          </p>
          <form
            className="integration-form hooks"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const r = await api<{ secret: string }>("/api/webhooks", {
                  workspaceId,
                  url: hookUrl,
                  events: hookEvents,
                  pageId: hookPage || null,
                });
                setFresh({ label: t("Geheimer Schlüssel des Webhooks", "Webhook secret key"), value: r.secret });
                setHookUrl("");
                await load();
              } catch (error) {
                onError((error as Error).message);
              }
            }}
          >
            <input
              required
              type="url"
              value={hookUrl}
              onChange={(e) => setHookUrl(e.target.value)}
              placeholder="https://n8n.example.com/webhook/…"
              aria-label={t("Adresse des Webhooks", "Webhook address")}
            />
            <Select value={hookPage} onChange={(e) => setHookPage(e.target.value)} aria-label={t("Nur für Datenbank", "Only for database")}>
              <option value="">{t("Alle Seiten und Datenbanken", "All pages and databases")}</option>
              {pages
                .filter((p) => p.kind === "database")
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {t("Nur", "Only")}{" "}{p.title || t("Ohne Titel", "Untitled")}
                  </option>
                ))}
            </Select>
            <fieldset>
              <legend>{t("Ereignisse", "Events")}</legend>
              {Object.entries(events).map(([id, label]) => (
                <label key={id} className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={hookEvents.includes(id)}
                    onChange={(e) =>
                      setHookEvents((current) =>
                        e.target.checked ? [...current, id] : current.filter((x) => x !== id),
                      )
                    }
                  />
                  {label} <code>{id}</code>
                </label>
              ))}
            </fieldset>
            <button className="button primary" disabled={!hookEvents.length}>
              {t("Webhook anlegen", "Create webhook")}
            </button>
          </form>
          <ul className="integration-list">
            {hooks.map((h) => (
              <li key={h.id}>
                <span>
                  <strong>{h.url}</strong>
                  <small>
                    {h.events.join(", ")} ·{" "}
                    {h.last
                      ? h.last.delivered_at
                        ? t(`zuletzt zugestellt ${when(h.last.delivered_at)}`, `last delivered ${when(h.last.delivered_at)}`)
                        : t(`Fehler: ${h.last.error || h.last.status}`, `Error: ${h.last.error || h.last.status}`)
                      : t("noch nichts gesendet", "nothing sent yet")}
                  </small>
                </span>
                <button
                  className="icon-button"
                  aria-label={t(`Webhook ${h.url} löschen`, `Delete webhook ${h.url}`)}
                  title={t("Löschen", "Delete")}
                  onClick={async () => {
                    await api("/api/command", { action: "webhook.delete", workspaceId, id: h.id }).catch((e) =>
                      onError((e as Error).message),
                    );
                    await load();
                  }}
                >
                  <Trash size={16} />
                </button>
              </li>
            ))}
            {!hooks.length && <li className="muted">{t("Noch keine Webhooks.", "No webhooks yet.")}</li>}
          </ul>
        </section>
      )}
    </>
  );
}
