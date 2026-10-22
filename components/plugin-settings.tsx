"use client";
// Block extensions of a workspace (lib/plugins.ts): owners register a plugin
// by its address, see what it may do, switch it off, allow it on published
// pages, pick the databases it may read and fill in its settings.
import { useT } from "./i18n";
import { useCallback, useEffect, useState } from "react";
import { PuzzlePiece, Trash } from "@phosphor-icons/react";
import { api } from "./ui";

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
    <section className="settings-section plugin-settings">
      <h2>
        <PuzzlePiece size={18} aria-hidden="true" /> {t("Block-Erweiterungen", "Block extensions")}
      </h2>
      <p className="muted">
        {t(
          "Eigene Blocktypen von Webadressen, die die Administration freigegeben hat. Sie laufen abgeschottet in einem Rahmen, sehen weder Konto noch E-Mail-Adresse und lesen Datenbanken nur, wenn du sie hier erlaubst – immer mit den Rechten der lesenden Person.",
          "Custom block types from web addresses your administrators allowed. They run isolated in a frame, see neither account nor e-mail address and read databases only when you allow it here – always with the rights of the person reading.",
        )}
      </p>
      {owner && (
        <div className="plugin-register">
          <input
            type="url"
            value={url}
            placeholder="https://plugins.example.org/poll/"
            aria-label={t("Adresse der Erweiterung", "Address of the extension")}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void register()}
          />
          <button className="button primary" disabled={busy || !url.trim()} onClick={() => void register()}>
            {busy ? t("Wird geprüft …", "Checking …") : t("Registrieren", "Register")}
          </button>
        </div>
      )}
      {!plugins.length && <p className="muted">{t("Noch keine Block-Erweiterungen.", "No block extensions yet.")}</p>}
      <ul className="plugin-list">
        {plugins.map((plugin) => {
          const draft = drafts[plugin.id] || plugin.settings;
          const anyDatabase = plugin.requested.includes("read:database");
          const granted = plugin.permissions.filter((p) => p.startsWith("read:database:")).map((p) => p.slice(14));
          return (
            <li key={plugin.id} className={plugin.enabled ? "" : "plugin-off"}>
              <div className="plugin-head">
                <strong>
                  {plugin.name} <span className="muted">{plugin.version}</span>
                </strong>
                <code>{plugin.origin}</code>
                {owner && (
                  <button
                    className="icon-button"
                    title={t("Erweiterung entfernen", "Remove extension")}
                    aria-label={t("Erweiterung entfernen", "Remove extension")}
                    onClick={() =>
                      confirm(t("Erweiterung entfernen? Ihre Blöcke zeigen danach nur noch ihren Text.", "Remove the extension? Its blocks then only show their text.")) &&
                      void act({ action: "plugin.delete", pluginId: plugin.id })
                    }
                  >
                    <Trash size={16} />
                  </button>
                )}
              </div>
              {plugin.description && <p className="muted">{plugin.description}</p>}
              <p className="plugin-blocks">
                {t("Blöcke:", "Blocks:")} {plugin.blocks.map((b) => `${b.icon ? b.icon + " " : ""}${b.label}`).join(", ")}
              </p>
              <p className="plugin-permissions">
                {t("Darf:", "May:")}{" "}
                {plugin.permissions.length ? plugin.permissions.map(permissionLabel).join(" · ") : t("nur sich selbst zeigen", "only show itself")}
              </p>
              {owner && (
                <div className="plugin-options">
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={plugin.enabled}
                      onChange={(e) => void act({ action: "plugin.update", pluginId: plugin.id, enabled: e.target.checked })}
                    />
                    {t("Aktiv", "Active")}
                  </label>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={plugin.public}
                      onChange={(e) => void act({ action: "plugin.update", pluginId: plugin.id, public: e.target.checked })}
                    />
                    {t("Auch auf veröffentlichten Seiten zeigen", "Also show on published pages")}
                  </label>
                </div>
              )}
              {owner && anyDatabase && (
                <fieldset className="plugin-databases">
                  <legend>{t("Datenbanken, die sie lesen darf", "Databases it may read")}</legend>
                  {databases.map((d) => (
                    <label key={d.id} className="checkbox-label">
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
                      {d.title || t("Ohne Titel", "Untitled")}
                    </label>
                  ))}
                </fieldset>
              )}
              {owner && Object.keys(plugin.settingsSchema).length > 0 && (
                <form
                  className="plugin-config"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act({ action: "plugin.update", pluginId: plugin.id, settings: draft });
                  }}
                >
                  {Object.entries(plugin.settingsSchema).map(([key, field]) => (
                    <label key={key} className={field.type === "boolean" ? "checkbox-label" : "plugin-config-field"}>
                      {field.type !== "boolean" && <span>{field.label}</span>}
                      <input
                        type={field.type === "boolean" ? "checkbox" : field.type === "number" ? "number" : "text"}
                        {...(field.type === "boolean"
                          ? { checked: !!draft[key] }
                          : { value: String(draft[key] ?? field.default ?? "") })}
                        onChange={(e) =>
                          setDrafts((all) => ({
                            ...all,
                            [plugin.id]: {
                              ...draft,
                              [key]: field.type === "boolean" ? e.target.checked : field.type === "number" ? Number(e.target.value) : e.target.value,
                            },
                          }))
                        }
                      />
                      {field.type === "boolean" && field.label}
                    </label>
                  ))}
                  <p className="muted">{t("Einstellungen sind für alle sichtbar, die den Block sehen – keine Passwörter eintragen.", "Settings are visible to everyone who sees the block – do not enter passwords.")}</p>
                  <button className="button" type="submit">
                    {t("Einstellungen speichern", "Save settings")}
                  </button>
                </form>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
