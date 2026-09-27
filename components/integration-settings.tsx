"use client";
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
  ms ? new Date(ms).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" }) : "nie";

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
        <h2>Persönliche API-Tokens</h2>
        <p className="muted">
          Für Skripte, n8n oder Home Assistant: Anfragen mit{" "}
          <code>Authorization: Bearer fp_…</code> handeln mit deinen Rechten.
          Lese-Tokens können nichts ändern. Beispiel:{" "}
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
              setFresh({ label: `Token „${tokenName}“`, value: r.token });
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
            placeholder="Name, z. B. Home Assistant"
            aria-label="Name des Tokens"
          />
          <Select value={scope} onChange={(e) => setScope(e.target.value as "read" | "write")} aria-label="Rechte des Tokens">
            <option value="read">Nur lesen</option>
            <option value="write">Lesen und schreiben</option>
          </Select>
          <button className="button primary">Token erstellen</button>
        </form>
        {fresh && (
          <div className="integration-secret" role="status">
            <strong>{fresh.label} – nur jetzt sichtbar:</strong>
            <code>{fresh.value}</code>
            <button
              className="button compact"
              onClick={() => void navigator.clipboard.writeText(fresh.value).catch(() => {})}
            >
              <Copy size={14} /> Kopieren
            </button>
          </div>
        )}
        <ul className="integration-list">
          {tokens.map((t) => (
            <li key={t.id}>
              <span>
                <strong>{t.name}</strong>
                <small>
                  {t.prefix}… · {t.scope === "read" ? "nur lesen" : "lesen und schreiben"} · zuletzt benutzt:{" "}
                  {when(t.last_used_at)}
                </small>
              </span>
              <button
                className="icon-button"
                aria-label={`Token ${t.name} widerrufen`}
                title="Widerrufen"
                onClick={async () => {
                  await api("/api/command", { action: "token.revoke", id: t.id }).catch((e) =>
                    onError((e as Error).message),
                  );
                  await load();
                }}
              >
                <Trash size={16} />
              </button>
            </li>
          ))}
          {!tokens.length && <li className="muted">Noch keine Tokens.</li>}
        </ul>
      </section>
      {owner && (
        <section className="settings-section">
          <h2>Webhooks</h2>
          <p className="muted">
            Flowplan schickt bei den gewählten Ereignissen ein JSON per POST an
            die Adresse. Die Kopfzeile <code>X-Flowplan-Signature</code> enthält{" "}
            <code>sha256=</code> und die HMAC-Signatur des Inhalts mit dem
            geheimen Schlüssel des Webhooks. Fehlgeschlagene Zustellungen werden
            wiederholt.
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
                setFresh({ label: "Geheimer Schlüssel des Webhooks", value: r.secret });
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
              aria-label="Adresse des Webhooks"
            />
            <Select value={hookPage} onChange={(e) => setHookPage(e.target.value)} aria-label="Nur für Datenbank">
              <option value="">Alle Seiten und Datenbanken</option>
              {pages
                .filter((p) => p.kind === "database")
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    Nur {p.title || "Ohne Titel"}
                  </option>
                ))}
            </Select>
            <fieldset>
              <legend>Ereignisse</legend>
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
              Webhook anlegen
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
                        ? `zuletzt zugestellt ${when(h.last.delivered_at)}`
                        : `Fehler: ${h.last.error || h.last.status}`
                      : "noch nichts gesendet"}
                  </small>
                </span>
                <button
                  className="icon-button"
                  aria-label={`Webhook ${h.url} löschen`}
                  title="Löschen"
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
            {!hooks.length && <li className="muted">Noch keine Webhooks.</li>}
          </ul>
        </section>
      )}
    </>
  );
}
