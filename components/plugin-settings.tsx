"use client";
// Block extensions of a workspace (lib/plugins.ts): owners register a plugin
// by its address, see what it may do, switch it off, allow it on published
// pages, pick the databases it may read and fill in its settings.
import { useT } from "./i18n";
import { useCallback, useEffect, useState } from "react";
import { PuzzlePiece, Trash } from "@phosphor-icons/react";
import { api } from "./ui";
import { CONTROL, EmptyState, SettingGroup, SettingRow, StatusBadge, SwitchRow } from "./settings-ui";

type SettingField = { type: "string" | "number" | "boolean"; label: string; default?: string | number | boolean };
type Plugin = {
  id: string;
  name: string;
  version: string;
  description: string;
  url: string;
  origin: string;
  blocks: { type: string; label: string; icon: string; description: string }[];
  permissions: string[];
  requested: string[];
  settingsSchema: Record<string, SettingField>;
  settings: Record<string, unknown>;
  enabled: boolean;
  public: boolean;
};

export function PluginSettings({
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
  const [plugins, setPlugins] = useState<Plugin[]>([]),
    [url, setUrl] = useState(""),
    [busy, setBusy] = useState(false),
    [drafts, setDrafts] = useState<Record<string, Record<string, unknown>>>({});
  const databases = pages.filter((p) => p.kind === "database");
  const load = useCallback(async () => {
    try {
      const r = await api<{ plugins: Plugin[] }>(`/api/plugins?workspace=${workspaceId}`);
      setPlugins(r.plugins);
    } catch (e) {
      onError((e as Error).message);
    }
  }, [workspaceId, onError]);
  useEffect(() => void load(), [load]);
  const act = async (body: Record<string, unknown>) => {
    try {
      await api("/api/command", body);
      await load();
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const register = async () => {
    if (!url.trim()) return;
    setBusy(true);
    try {
      await api("/api/plugins", { workspaceId, url: url.trim() });
      setUrl("");
      await load();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const permissionLabel = (permission: string) => {
    if (permission === "read:page") return t("Seitentitel lesen", "Read the page title");
    if (permission === "read:selection") return t("Markierten Text lesen", "Read the selected text");
    if (permission === "write:block") return t("Eigene Blockdaten speichern", "Store its own block data");
    if (permission === "read:database") return t("Ausgewählte Datenbanken lesen", "Read chosen databases");
    const db = /^read:database:(.+)$/.exec(permission)?.[1];
    if (db) return t("Datenbank lesen: ", "Read database: ") + (databases.find((d) => d.id === db)?.title || db);
    return permission;
  };
  return (
    <>
      <SettingGroup
        id="extensions"
        title={t("Erweiterungen des Arbeitsbereichs", "Extensions of the workspace")}
        description={t(
          "Eigene Blocktypen von Webadressen, die die Administration freigegeben hat. Sie laufen abgeschottet in einem Rahmen, sehen weder Konto noch E-Mail-Adresse und lesen Datenbanken nur, wenn du sie hier erlaubst – immer mit den Rechten der lesenden Person.",
          "Custom block types from web addresses your administrators allowed. They run isolated in a frame, see neither account nor e-mail address and read databases only when you allow it here – always with the rights of the person reading.",
        )}
      >
        {owner && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void register();
            }}
          >
            <SettingRow label={t("Adresse der Erweiterung", "Address of the extension")} id="plugin-url" description={t("Die Adresse ihres Manifests; die Administration muss die Domain freigegeben haben.", "The address of its manifest; the administrators must have allowed the domain.")}>
              <input id="plugin-url" type="url" className={CONTROL.lg} value={url} placeholder="https://plugins.example.org/poll/" onChange={(e) => setUrl(e.target.value)} />
              <button className="button primary" disabled={busy || !url.trim()}>
                {busy ? t("Wird geprüft …", "Checking …") : t("Registrieren", "Register")}
              </button>
            </SettingRow>
          </form>
        )}
        {!plugins.length && (
          <div className="setting-row wide">
            <EmptyState icon={<PuzzlePiece size={20} />} title={t("Noch keine Block-Erweiterungen", "No block extensions yet")}>
              {owner ? t("Registriere eine Erweiterung über ihre Adresse.", "Register an extension by its address.") : t("Eigentümer des Arbeitsbereichs registrieren Erweiterungen.", "Owners of the workspace register extensions.")}
            </EmptyState>
          </div>
        )}
      </SettingGroup>
      {plugins.map((plugin) => {
        const draft = drafts[plugin.id] || plugin.settings;
        const anyDatabase = plugin.requested.includes("read:database");
        const granted = plugin.permissions.filter((p) => p.startsWith("read:database:")).map((p) => p.slice(14));
        return (
          <SettingGroup
            key={plugin.id}
            id={`plugin-${plugin.id}`}
            title={`${plugin.name} ${plugin.version}`}
            description={
              <>
                {plugin.description && <>{plugin.description} </>}
                <code className="ws-break">{plugin.origin}</code>
              </>
            }
            actions={
              <>
                <StatusBadge tone={plugin.enabled ? "ok" : "off"}>{plugin.enabled ? t("Aktiv", "Active") : t("Aus", "Off")}</StatusBadge>
                {owner && (
                  <button
                    type="button"
                    className="icon-button ws-danger-icon"
                    title={t("Erweiterung entfernen", "Remove extension")}
                    aria-label={t("Erweiterung entfernen", "Remove extension")}
                    onClick={() =>
                      confirm(t("Erweiterung entfernen? Ihre Blöcke zeigen danach nur noch ihren Text.", "Remove the extension? Its blocks then only show their text.")) &&
                      void act({ action: "plugin.delete", pluginId: plugin.id })
                    }
                  >
                    <Trash size={18} />
                  </button>
                )}
              </>
            }
          >
            <SettingRow label={t("Blöcke", "Blocks")}>
              <span className="ws-value">{plugin.blocks.map((b) => `${b.icon ? b.icon + " " : ""}${b.label}`).join(", ")}</span>
            </SettingRow>
            <SettingRow label={t("Darf", "May")}>
              <span className="ws-value">{plugin.permissions.length ? plugin.permissions.map(permissionLabel).join(" · ") : t("nur sich selbst zeigen", "only show itself")}</span>
            </SettingRow>
            {owner && (
              <SwitchRow
                label={t("Aktiv", "Active")}
                description={t("Ausgeschaltet zeigen ihre Blöcke nur ihren Text.", "Switched off, its blocks only show their text.")}
                checked={plugin.enabled}
                onChange={(enabled) => void act({ action: "plugin.update", pluginId: plugin.id, enabled })}
              />
            )}
            {owner && (
              <SwitchRow
                label={t("Auch auf veröffentlichten Seiten zeigen", "Also show on published pages")}
                checked={plugin.public}
                onChange={(on) => void act({ action: "plugin.update", pluginId: plugin.id, public: on })}
              />
            )}
            {owner && anyDatabase && (
              <SettingRow wide label={t("Datenbanken, die sie lesen darf", "Databases it may read")}>
                <div className="ws-checks" role="group" aria-label={t("Datenbanken, die sie lesen darf", "Databases it may read")}>
                  {databases.map((d) => (
                    <label key={d.id} className="ws-check">
                      <input
                        type="checkbox"
                        checked={granted.includes(d.id)}
                        onChange={(e) =>
                          void act({
                            action: "plugin.update",
                            pluginId: plugin.id,
                            databases: e.target.checked ? [...granted, d.id] : granted.filter((id) => id !== d.id),
                          })
                        }
                      />
                      <span>{d.title || t("Ohne Titel", "Untitled")}</span>
                    </label>
                  ))}
                  {!databases.length && <p className="ws-note">{t("Im Arbeitsbereich gibt es noch keine Datenbank.", "The workspace has no database yet.")}</p>}
                </div>
              </SettingRow>
            )}
            {owner && Object.keys(plugin.settingsSchema).length > 0 && (
              <form
                className="setting-row wide"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act({ action: "plugin.update", pluginId: plugin.id, settings: draft });
                }}
              >
                <div className="setting-text">
                  <span className="setting-label">{t("Einstellungen", "Settings")}</span>
                  <small>{t("Einstellungen sind für alle sichtbar, die den Block sehen – keine Passwörter eintragen.", "Settings are visible to everyone who sees the block – do not enter passwords.")}</small>
                </div>
                <div className="ws-form">
                  {Object.entries(plugin.settingsSchema).map(([key, field]) => {
                    const id = `plugin-${plugin.id}-${key}`;
                    const change = (value: unknown) => setDrafts((all) => ({ ...all, [plugin.id]: { ...draft, [key]: value } }));
                    return field.type === "boolean" ? (
                      <label key={key} className="ws-check">
                        <input type="checkbox" checked={!!draft[key]} onChange={(e) => change(e.target.checked)} />
                        <span>{field.label}</span>
                      </label>
                    ) : (
                      <div key={key} className="ws-field">
                        <label htmlFor={id}>{field.label}</label>
                        <input id={id} type={field.type === "number" ? "number" : "text"} value={String(draft[key] ?? field.default ?? "")} onChange={(e) => change(field.type === "number" ? Number(e.target.value) : e.target.value)} />
                      </div>
                    );
                  })}
                  <div className="ws-form-actions">
                    <button className="button" type="submit">
                      {t("Einstellungen speichern", "Save settings")}
                    </button>
                  </div>
                </div>
              </form>
            )}
          </SettingGroup>
        );
      })}
    </>
  );
}
