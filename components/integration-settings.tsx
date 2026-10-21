"use client";
import { useT } from "./i18n";
import { LOCALE_TAG, tr } from "@/lib/locale-tag";
import { useCallback, useEffect, useState } from "react";
import { Copy, Trash } from "@phosphor-icons/react";
import { api } from "./ui";
import { Select } from "./select";
import { WebhookSettings } from "./webhook-settings";

type Token = {
  id: string;
  name: string;
  scope: "read" | "write";
  prefix: string;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
};
type McpClient = "claude-code" | "claude-desktop" | "chatgpt" | "other";
// How Claude, ChatGPT and other AI clients connect (lib/mcp.ts, app/api/mcp).
function mcpConfig(client: McpClient, url: string, token: string) {
  if (client === "claude-code")
    return `claude mcp add --transport http flowplan ${url} \\\n  --header "Authorization: Bearer ${token}"`;
  if (client === "claude-desktop")
    return JSON.stringify(
      {
        mcpServers: {
          flowplan: {
            command: "npx",
            args: ["-y", "mcp-remote", url, "--header", "Authorization:${FLOWPLAN_AUTH}"],
            env: { FLOWPLAN_AUTH: `Bearer ${token}` },
          },
        },
      },
      null,
      2,
    );
  if (client === "chatgpt") return `URL: ${url}\nAuthorization: Bearer ${token}`;
  return JSON.stringify(
    { mcpServers: { flowplan: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } },
    null,
    2,
  );
}
function McpSettings({ origin, token }: { origin: string; token: string }) {
  const t = useT();
  const [client, setClient] = useState<McpClient>("claude-code");
  const url = `${origin}/api/mcp`;
  const config = mcpConfig(client, url, token || "fp_…");
  const hints: Record<McpClient, string> = {
    "claude-code": t("Im Terminal ausführen. Mit --scope user gilt die Verbindung in allen Projekten.", "Run in a terminal. With --scope user the connection works in all projects."),
    "claude-desktop": t(
      "In Claude Desktop unter Einstellungen → Entwickler → Konfiguration bearbeiten in claude_desktop_config.json eintragen und Claude neu starten (benötigt Node.js).",
      "In Claude Desktop open Settings → Developer → Edit config, add this to claude_desktop_config.json and restart Claude (needs Node.js).",
    ),
    chatgpt: t(
      "In ChatGPT (Entwicklermodus) unter Einstellungen → Apps & Konnektoren einen Konnektor mit dieser Adresse anlegen und, falls angeboten, Authentifizierung per Token wählen.",
      "In ChatGPT (developer mode) create a connector under Settings → Apps & Connectors with this address and, where offered, choose token authentication.",
    ),
    other: t(
      "Für Cursor, VS Code, Windsurf und andere Clients mit Streamable HTTP und eigenen Kopfzeilen.",
      "For Cursor, VS Code, Windsurf and other clients with Streamable HTTP and custom headers.",
    ),
  };
  return (
    <section className="settings-section mcp-settings">
      <h2>{t("KI-Assistenten (MCP)", "AI assistants (MCP)")}</h2>
      <p className="muted">
        {t(
          "Verbinde Claude, ChatGPT oder andere MCP-Clients mit deinem Flowplan. Sie suchen, lesen und – mit einem Schreib-Token – legen Seiten und Datensätze an, immer nur mit deinen Rechten. Lege dafür oben ein eigenes Token an.",
          "Connect Claude, ChatGPT or other MCP clients to your Flowplan. They search, read and – with a write token – create pages and records, always with your permissions only. Create a dedicated token above.",
        )}
      </p>
      <div className="mcp-address">
        <strong>{t("Adresse:", "Address:")}</strong>
        <code aria-label={t("MCP-Adresse", "MCP address")}>{url}</code>
        <button className="button compact" onClick={() => void navigator.clipboard.writeText(url).catch(() => {})}>
          <Copy size={14} /> {t("Kopieren", "Copy")}
        </button>
      </div>
      <div className="mcp-clients" role="tablist" aria-label={t("MCP-Client", "MCP client")}>
        {(
          [
            ["claude-code", "Claude Code"],
            ["claude-desktop", "Claude Desktop"],
            ["chatgpt", "ChatGPT"],
            ["other", t("Andere", "Other")],
          ] as [McpClient, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={client === id}
            className={`button compact${client === id ? " primary" : ""}`}
            onClick={() => setClient(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="muted">{hints[client]}</p>
      <pre className="mcp-config" aria-label={t("Beispielkonfiguration", "Example configuration")}>{config}</pre>
      <button className="button compact" onClick={() => void navigator.clipboard.writeText(config).catch(() => {})}>
        <Copy size={14} /> {t("Konfiguration kopieren", "Copy configuration")}
      </button>
      <p className="muted">
        {t(
          "Lese-Tokens bieten nur Lese-Werkzeuge. Widerrufe das Token oben, um die Verbindung sofort zu trennen. Das Token nie in eine Adresse schreiben.",
          "Read tokens only offer read tools. Revoke the token above to cut the connection at once. Never put the token into an address.",
        )}
      </p>
    </section>
  );
}
const when = (ms: number | null) =>
  ms ? new Date(ms).toLocaleString(LOCALE_TAG, { dateStyle: "short", timeStyle: "short" }) : tr("nie", "never");

// Settings → API & Webhooks: personal tokens for everyone, webhooks for
// workspace owners (lib/api-tokens.ts, components/webhook-settings.tsx).
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
    [fresh, setFresh] = useState<{ label: string; value: string } | null>(null);
  const load = useCallback(async () => {
    try {
      setTokens(await api<Token[]>("/api/tokens"));
    } catch (e) {
      onError((e as Error).message);
    }
  }, [onError]);
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
      <McpSettings origin={origin} token={fresh?.value.startsWith("fp_") ? fresh.value : ""} />
      {owner && (
        <WebhookSettings
          workspaceId={workspaceId}
          pages={pages}
          onError={onError}
          onSecret={(value) => setFresh({ label: t("Geheimer Schlüssel des Webhooks", "Webhook secret key"), value })}
        />
      )}
    </>
  );
}
