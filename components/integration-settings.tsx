"use client";
// Settings → API & KI-Assistenten: personal API tokens (lib/api-tokens.ts)
// and how AI assistants connect over MCP (lib/mcp.ts). The workspace's
// webhooks have their own section (components/webhook-settings.tsx).
import { useT } from "./i18n";
import { LOCALE_TAG, tr } from "@/lib/locale-tag";
import { useCallback, useEffect, useState } from "react";
import { Copy, Key, Trash } from "@phosphor-icons/react";
import { api } from "./ui";
import { Select } from "./select";
import { CONTROL, EmptyState, ResponsiveTable, SettingGroup, SettingRow, StatusBadge, type Tone } from "./settings-ui";

type Token = {
  id: string;
  name: string;
  scope: "read" | "write" | "clipper";
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
    <SettingGroup
      id="mcp"
      title={t("KI-Assistenten (MCP)", "AI assistants (MCP)")}
      description={t(
        "Verbinde Claude, ChatGPT oder andere MCP-Clients mit deinem Flowplan. Sie suchen, lesen und – mit einem Schreib-Token – legen Seiten und Datensätze an, immer nur mit deinen Rechten. Lege dafür oben ein eigenes Token an.",
        "Connect Claude, ChatGPT or other MCP clients to your Flowplan. They search, read and – with a write token – create pages and records, always with your permissions only. Create a dedicated token above.",
      )}
    >
      <SettingRow label={t("Adresse", "Address")} description={t("Streamable HTTP; das Token kommt in die Kopfzeile Authorization.", "Streamable HTTP; the token goes into the Authorization header.")}>
        <code className="api-code" aria-label={t("MCP-Adresse", "MCP address")}>
          {url}
        </code>
        <button className="button" onClick={() => void navigator.clipboard.writeText(url).catch(() => {})}>
          <Copy size={14} aria-hidden /> {t("Kopieren", "Copy")}
        </button>
      </SettingRow>
      <div className="setting-row wide">
        <div className="setting-text">
          <span className="setting-label" id="mcp-client-label">
            {t("Client", "Client")}
          </span>
          <small>{hints[client]}</small>
        </div>
        <div className="setting-control mcp-client-control">
          <div className="segmented mcp-clients" role="tablist" aria-labelledby="mcp-client-label">
            {(
              [
                ["claude-code", "Claude Code"],
                ["claude-desktop", "Claude Desktop"],
                ["chatgpt", "ChatGPT"],
                ["other", t("Andere", "Other")],
              ] as [McpClient, string][]
            ).map(([id, label]) => (
              <button key={id} role="tab" type="button" aria-selected={client === id} data-active={client === id} onClick={() => setClient(id)}>
                {label}
              </button>
            ))}
          </div>
          <pre className="mcp-config" aria-label={t("Beispielkonfiguration", "Example configuration")}>
            {config}
          </pre>
          <div className="api-row-actions">
            <button className="button" onClick={() => void navigator.clipboard.writeText(config).catch(() => {})}>
              <Copy size={14} aria-hidden /> {t("Konfiguration kopieren", "Copy configuration")}
            </button>
          </div>
        </div>
      </div>
      <p className="setting-note">
        {t(
          "Lese-Tokens bieten nur Lese-Werkzeuge. Widerrufe das Token oben, um die Verbindung sofort zu trennen. Das Token nie in eine Adresse schreiben.",
          "Read tokens only offer read tools. Revoke the token above to cut the connection at once. Never put the token into an address.",
        )}
      </p>
    </SettingGroup>
  );
}
const when = (ms: number | null) =>
  ms ? new Date(ms).toLocaleString(LOCALE_TAG, { dateStyle: "short", timeStyle: "short" }) : tr("nie", "never");

// The secret shown once after creating a token (or a webhook).
export function FreshSecret({ label, value }: { label: string; value: string }) {
  const t = useT();
  return (
    <div className="integration-secret" role="status">
      <strong>
        {label} {t("– nur jetzt sichtbar:", "– visible only now:")}
      </strong>
      <code>{value}</code>
      <button className="button" onClick={() => void navigator.clipboard.writeText(value).catch(() => {})}>
        <Copy size={14} aria-hidden /> {t("Kopieren", "Copy")}
      </button>
    </div>
  );
}

// Settings → API & KI-Assistenten: personal tokens and MCP.
export function IntegrationSettings({ onError }: { onError: (message: string) => void }) {
  const t = useT();
  const [tokens, setTokens] = useState<Token[] | null>(null),
    [tokenName, setTokenName] = useState(""),
    [scope, setScope] = useState<"read" | "write" | "clipper">("read"),
    [fresh, setFresh] = useState<{ label: string; value: string } | null>(null),
    [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setTokens(await api<Token[]>("/api/tokens"));
    } catch (e) {
      onError((e as Error).message);
    }
  }, [onError]);
  useEffect(() => void load(), [load]);
  const origin = typeof location === "undefined" ? "" : location.origin;
  const scopes: Record<Token["scope"], { label: string; tone: Tone }> = {
    read: { label: t("Nur lesen", "Read only"), tone: "info" },
    write: { label: t("Lesen und schreiben", "Read and write"), tone: "warn" },
    clipper: { label: t("Nur Browser-Erweiterung", "Browser extension only"), tone: "off" },
  };
  const revoke = async (token: Token) => {
    await api("/api/command", { action: "token.revoke", id: token.id }).catch((e) => onError((e as Error).message));
    await load();
  };
  return (
    <>
      <SettingGroup
        id="tokens"
        title={t("Persönliche API-Tokens", "Personal API tokens")}
        description={
          <>
            {t("Für Skripte, n8n oder Home Assistant: Anfragen mit", "For scripts, n8n or Home Assistant: requests with")} <code>Authorization: Bearer fp_…</code>{" "}
            {t("handeln mit deinen Rechten. Lese-Tokens können nichts ändern.", "act with your permissions. Read tokens cannot change anything.")}
          </>
        }
      >
        {fresh && (
          <div className="setting-row wide">
            <FreshSecret label={fresh.label} value={fresh.value} />
          </div>
        )}
        <div className="setting-row wide">
          {tokens && !tokens.length ? (
            <EmptyState icon={<Key size={20} />} title={t("Noch keine Tokens", "No tokens yet")}>
              {t("Lege unten ein Token an, z. B. für Home Assistant oder einen KI-Assistenten.", "Create a token below, e.g. for Home Assistant or an AI assistant.")}
            </EmptyState>
          ) : (
            <div className="integration-list">
              <ResponsiveTable
                label={t("Persönliche API-Tokens", "Personal API tokens")}
                rows={tokens || []}
                rowKey={(token) => token.id}
                columns={[
                  {
                    key: "name",
                    header: t("Name", "Name"),
                    primary: true,
                    render: (token) => (
                      <span className="api-token-name">
                        <strong>{token.name}</strong>
                        <code>{token.prefix}…</code>
                      </span>
                    ),
                  },
                  { key: "scope", header: t("Rechte", "Permissions"), render: (token) => <StatusBadge tone={scopes[token.scope].tone}>{scopes[token.scope].label}</StatusBadge> },
                  { key: "used", header: t("Zuletzt benutzt", "Last used"), render: (token) => when(token.last_used_at) },
                  { key: "created", header: t("Angelegt", "Created"), hideOnPhone: true, render: (token) => when(token.created_at) },
                  {
                    key: "actions",
                    header: t("Aktionen", "Actions"),
                    align: "end",
                    render: (token) => (
                      <button className="icon-button" aria-label={t(`Token ${token.name} widerrufen`, `Revoke token ${token.name}`)} title={t("Widerrufen", "Revoke")} onClick={() => void revoke(token)}>
                        <Trash size={16} />
                      </button>
                    ),
                  },
                ]}
              />
            </div>
          )}
        </div>
        <form
          className="setting-row wide api-token-form"
          aria-label={t("Neues Token", "New token")}
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const r = await api<{ token: string }>("/api/command", { action: "token.create", name: tokenName, scope });
              setFresh({ label: t(`Token „${tokenName}“`, `Token “${tokenName}”`), value: r.token });
              setTokenName("");
              await load();
            } catch (error) {
              onError((error as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            {t("Name des Tokens", "Token name")}
            <input id="token-name" className={CONTROL.md} required maxLength={80} value={tokenName} onChange={(e) => setTokenName(e.target.value)} placeholder={t("z. B. Home Assistant", "e.g. Home Assistant")} />
          </label>
          <label>
            {t("Rechte", "Permissions")}
            <Select className={CONTROL.md} value={scope} onChange={(e) => setScope(e.target.value as "read" | "write" | "clipper")} aria-label={t("Rechte des Tokens", "Token permissions")}>
              <option value="read">{t("Nur lesen", "Read only")}</option>
              <option value="write">{t("Lesen und schreiben", "Read and write")}</option>
              <option value="clipper">{t("Nur Browser-Erweiterung (Web-Clipper)", "Browser extension only (web clipper)")}</option>
            </Select>
          </label>
          <button className="button primary" disabled={busy}>
            {t("Token erstellen", "Create token")}
          </button>
        </form>
        <p className="setting-note">
          {t("Beispiel:", "Example:")} <code>curl -H &quot;Authorization: Bearer fp_…&quot; {origin}/api/bootstrap</code>
        </p>
      </SettingGroup>
      <McpSettings origin={origin} token={fresh?.value.startsWith("fp_") ? fresh.value : ""} />
    </>
  );
}
