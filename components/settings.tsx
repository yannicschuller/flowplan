"use client";
import { WorkspaceIconPicker } from "./workspace-icon";
import { Select } from "./select";
import { SpaceIcon } from "./space-appearance";
import PushSettings from "./push-settings";
import { OfflineSettings } from "./offline-settings";
import { NotificationSettings } from "./notification-settings";
import { WorkspaceLifecycle } from "./workspace-lifecycle";
import { SpaceManager } from "./space-manager";
import { IntegrationSettings } from "./integration-settings";
import { useEffect, useState } from "react";
import { ClipperSettings } from "./clipper-settings";
import { AccountSecurity } from "./account-security";
import {
  GearSix,
  Users,
  DownloadSimple,
  ShieldCheck,
  Plus,
  Sun,
  Moon,
  Globe,
  Lock,
  UploadSimple,
  SlidersHorizontal,
  FolderSimple,
  UsersThree,
  Database,
  BellSimple,
  PlugsConnected,
} from "@phosphor-icons/react";
import { api, Avatar, download, Modal } from "./ui";
import type { Bootstrap, Space } from "@/lib/types";
type SettingsData = {
  invites: { id: string; email: string; role: string; guest?: number }[];
  groups: { id: string; name: string }[];
  groupMembers: { group_id: string; user_id: string }[];
  grants: {
    resource_id: string;
    user_id: string;
    group_id: string;
    role: string;
  }[];
};
const settingsTabs = [
  [
    "general",
    "Allgemein",
    SlidersHorizontal,
    "Name, Symbol und Aussehen des Arbeitsbereichs, dein Profil und Tastenkürzel.",
  ],
  [
    "spaces",
    "Bereiche",
    FolderSimple,
    "Bereiche anlegen, umbenennen, freigeben und ihr Aussehen festlegen.",
  ],
  [
    "members",
    "Mitglieder",
    UsersThree,
    "Wer zum Arbeitsbereich gehört, mit welcher Rolle, und wer eingeladen ist.",
  ],
  [
    "groups",
    "Gruppen & Rechte",
    ShieldCheck,
    "Gruppen bilden und ihnen Zugriff auf Bereiche geben.",
  ],
  [
    "data",
    "Daten",
    Database,
    "Offline-Nutzung, Export und Import von Inhalten.",
  ],
  [
    "notifications",
    "Benachrichtigungen",
    BellSimple,
    "Welche Benachrichtigungen dich im Posteingang, per Push und per E-Mail erreichen.",
  ],
  [
    "integrations",
    "API & Webhooks",
    PlugsConnected,
    "Persönliche API-Tokens für Skripte und Automationen, Webhooks des Arbeitsbereichs.",
  ],
] as const;
export default function Settings({
  boot,
  mutate,
  onError,
  dark,
  setDark,
  onRefresh,
  onWorkspaceExit,
}: {
  boot: Bootstrap;
  mutate: (b: Record<string, unknown>) => Promise<unknown>;
  onError: (s: string) => void;
  onRefresh: () => Promise<unknown>;
  onWorkspaceExit: (id: string | null) => Promise<unknown> | void;
  dark: boolean;
  setDark: (b: boolean) => void;
}) {
  const [tab, setTab] = useState("general"),
    [email, setEmail] = useState(""),
    [role, setRole] = useState("editor"),
    [inviteGuest, setInviteGuest] = useState(false),
    [name, setName] = useState(boot.workspace.name),
    [groupName, setGroupName] = useState(""),
    [settings, setSettings] = useState<SettingsData | null>(null),
    [groupId, setGroupId] = useState<string | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [zipBusy, setZipBusy] = useState(false),
    [zipResult, setZipResult] = useState(""),
    [importSpace, setImportSpace] = useState("");
  const [editingSpace, setEditingSpace] = useState<Space | null>(null);
  const owner = boot.workspace.role === "owner";
  async function load() {
    if (owner)
      setSettings(await api(`/api/settings?workspace=${boot.workspace.id}`));
  }
  useEffect(() => {
    void load().catch((e) => onError(e.message));
  }, [boot.workspace.id]);
  async function act(b: Record<string, unknown>) {
    try {
      await mutate({ workspaceId: boot.workspace.id, ...b });
      await load();
      return true;
    } catch (e) {
      onError((e as Error).message);
      return false;
    }
  }
  return (
    <div className="utility-content settings-page">
      <div className="utility-title settings-header">
        <GearSix size={30} />
        <div>
          <h1>Einstellungen</h1>
          <p>
            Arbeitsbereich „{boot.workspace.name}“ – Mitglieder, Rechte, Daten
            und Aussehen.
          </p>
        </div>
      </div>
      <div className="settings-layout">
        <nav className="settings-tabs" aria-label="Bereiche der Einstellungen">
          {settingsTabs.map(([id, label, Icon]) => (
            <button
              key={id}
              className={tab === id ? "selected" : ""}
              aria-current={tab === id ? "page" : undefined}
              onClick={() => setTab(id)}
            >
              <Icon size={18} aria-hidden="true" />
              {label}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          <p className="settings-intro">
            {settingsTabs.find(([id]) => id === tab)?.[3]}
          </p>
          {tab === "integrations" && (
            <IntegrationSettings
              workspaceId={boot.workspace.id}
              owner={owner}
              pages={boot.pages.filter((p) => !p.deleted_at)}
              onError={onError}
            />
          )}
          {tab === "notifications" && (
            <>
              {boot.notificationPrefs && (
                <NotificationSettings
                  prefs={boot.notificationPrefs}
                  onChange={async (kind, value) => {
                    try {
                      await mutate({
                        action: "notification.prefs",
                        kind,
                        ...value,
                      });
                    } catch (e) {
                      onError((e as Error).message);
                    }
                  }}
                />
              )}
              <PushSettings />
            </>
          )}
          {tab === "spaces" && (
            <section className="settings-section">
              <h2>Bereiche verwalten</h2>
              <p>
                Bereichseigentümer verwalten ihre eigenen Bereiche.
                Arbeitsbereichseigentümer können alle Bereiche verwalten;
                private Seiten bleiben an ihre Leserechte gebunden.
              </p>
              {(boot.managedSpaces || []).map((space) => (
                <div className="utility-row" key={space.id}>
                  <SpaceIcon icon={space.icon} color={space.icon_color} />
                  {space.visibility === "private" && (
                    <Lock aria-label="Privater Bereich" />
                  )}
                  <strong>{space.name}</strong>
                  <button
                    className="button compact"
                    onClick={() => setEditingSpace(space)}
                  >
                    Verwalten
                  </button>
                </div>
              ))}
              {!boot.managedSpaces?.length && (
                <p className="muted">
                  Keine Bereiche mit Verwaltungsrechten vorhanden.
                </p>
              )}
            </section>
          )}
          {editingSpace && (
            <SpaceManager
              space={editingSpace}
              onClose={() => setEditingSpace(null)}
              onDone={async () => {
                await onRefresh();
                await load();
              }}
            />
          )}
          {tab === "general" && (
            <>
              <section className="settings-section">
                <h2>Arbeitsbereich</h2>
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (await act({ action: "workspace.update", name }))
                      onError("Arbeitsbereich gespeichert");
                  }}
                >
                  <WorkspaceIconPicker
                    name={boot.workspace.name}
                    icon={boot.workspace.icon}
                    disabled={!owner}
                    save={(icon) => act({ action: "workspace.update", icon })}
                  />
                  <label>
                    Name
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      disabled={!owner}
                    />
                  </label>
                  {owner && (
                    <button className="button primary compact">
                      Änderungen speichern
                    </button>
                  )}
                </form>
              </section>
              <WorkspaceLifecycle
                key={boot.workspace.id}
                boot={boot}
                onExit={onWorkspaceExit}
              />
              <section className="settings-section">
                <h2>Erscheinungsbild</h2>
                <div className="theme-options">
                  <button
                    className={!dark ? "selected" : ""}
                    onClick={() => setDark(false)}
                  >
                    <Sun size={25} />
                    Hell
                  </button>
                  <button
                    className={dark ? "selected" : ""}
                    onClick={() => setDark(true)}
                  >
                    <Moon size={25} />
                    Dunkel
                  </button>
                </div>
              </section>
              <section className="settings-section">
                <h2>Dein Profil</h2>
                <div className="member-row">
                  <Avatar name={boot.user.name} userId={boot.user.id} />
                  <span>
                    {boot.user.name}
                    <small>{boot.user.email}</small>
                  </span>
                  <span className="tag tag-blue">{boot.localAccount ? "E-Mail" : "SSO"}</span>
                </div>
                {boot.localAccount ? (
                  <AccountSecurity name={boot.user.name} onRenamed={onRefresh} />
                ) : (
                  <p className="muted">
                    Name und E-Mail werden von deinem Identitätsanbieter
                    übernommen.
                  </p>
                )}
              </section>
              <section className="settings-section">
                <h2>Tastenkürzel</h2>
                <div className="shortcut">
                  <span>Seiten suchen</span>
                  <kbd>⌘ / Ctrl + K</kbd>
                </div>
                <div className="shortcut">
                  <span>Neue Seite</span>
                  <kbd>⌘ / Ctrl + N</kbd>
                </div>
                <div className="shortcut">
                  <span>Editor-Befehle</span>
                  <kbd>/</kbd>
                </div>
                <div className="shortcut">
                  <span>Fett / Kursiv</span>
                  <kbd>⌘ / Ctrl + B / I</kbd>
                </div>
              </section>
            </>
          )}
          {tab === "members" && (
            <>
              <section className="settings-section">
                <h2>Mitglieder · {boot.members.length}</h2>
                {boot.members.map((m) => (
                  <div className="member-row" key={m.id}>
                    <Avatar name={m.name} userId={m.id} />
                    <span>
                      {m.name}
                      {!!m.guest && (
                        <span className="tag tag-yellow">Gast</span>
                      )}
                      <small>{m.email}</small>
                    </span>
                    {owner && m.role !== "owner" && (
                      <button
                        className="button compact"
                        aria-label={
                          m.guest
                            ? `${m.name} zum Mitglied machen`
                            : `${m.name} zum Gast machen`
                        }
                        onClick={() =>
                          act({
                            action: "member.guest",
                            userId: m.id,
                            guest: !m.guest,
                          })
                        }
                      >
                        {m.guest ? "Zum Mitglied machen" : "Zum Gast machen"}
                      </button>
                    )}
                    {owner ? (
                      <Select
                        aria-label={`Rolle für ${m.name}`}
                        value={m.role}
                        onChange={(e) =>
                          act({
                            action: "member.role",
                            userId: m.id,
                            role: e.target.value,
                          })
                        }
                      >
                        <option value="owner">Eigentümer</option>
                        <option value="editor">Bearbeiten</option>
                        <option value="viewer">Ansehen</option>
                        <option value="remove">Entfernen</option>
                      </Select>
                    ) : (
                      <span className="tag">{m.role}</span>
                    )}
                  </div>
                ))}
              </section>
              {owner && (
                <section className="settings-section">
                  <h2>Mitglied einladen</h2>
                  <p className="muted">
                    Die Freigabe wird bei der nächsten SSO-Anmeldung mit
                    bestätigter E-Mail automatisch zugeordnet.
                  </p>
                  <form
                    className="invite-form"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      if (
                        await act({
                          action: "member.invite",
                          email,
                          role,
                          guest: inviteGuest,
                        })
                      )
                        setEmail("");
                    }}
                  >
                    <input
                      required
                      type="email"
                      placeholder="name@unternehmen.de"
                      aria-label="E-Mail des neuen Mitglieds"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                    <Select
                      value={role}
                      aria-label="Rolle"
                      onChange={(e) => setRole(e.target.value)}
                    >
                      <option value="editor">Bearbeiten</option>
                      <option value="viewer">Ansehen</option>
                    </Select>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={inviteGuest}
                        onChange={(e) => setInviteGuest(e.target.checked)}
                      />
                      Als Gast (nur freigegebene Seiten)
                    </label>
                    <button className="button primary">
                      <Plus />
                      Freigeben
                    </button>
                  </form>
                  {settings?.invites.map((i) => (
                    <div className="utility-row" key={i.id}>
                      <span>{i.email}</span>
                      <span className="tag tag-yellow">
                        {i.guest ? "Gast · ausstehend" : "Ausstehend"}
                      </span>
                    </div>
                  ))}
                </section>
              )}
            </>
          )}
          {tab === "groups" &&
            (owner ? (
              <>
                <section className="settings-section">
                  <h2>Gruppen</h2>
                  <p className="muted">
                    Fasse Mitglieder zusammen und vergebe gemeinsame Rechte für
                    Bereiche.
                  </p>
                  <form
                    className="invite-form"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      if (
                        await act({ action: "group.create", name: groupName })
                      )
                        setGroupName("");
                    }}
                  >
                    <input
                      required
                      value={groupName}
                      aria-label="Gruppenname"
                      onChange={(e) => setGroupName(e.target.value)}
                      placeholder="Neue Gruppe"
                    />
                    <button className="button primary">
                      <Plus />
                      Erstellen
                    </button>
                  </form>
                  {settings?.groups.map((g) => (
                    <div className="utility-row" key={g.id}>
                      <Users />
                      <strong>{g.name}</strong>
                      <span>
                        {
                          settings.groupMembers.filter(
                            (m) => m.group_id === g.id,
                          ).length
                        }{" "}
                        Mitglieder
                      </span>
                      <button
                        className="button compact"
                        onClick={() => setGroupId(g.id)}
                      >
                        Verwalten
                      </button>
                    </div>
                  ))}
                </section>
                <section className="settings-section">
                  <h2>Bereiche & Zugriffsrechte</h2>
                  {(boot.managedSpaces || boot.spaces).map((s) => (
                    <div className="space-settings" key={s.id}>
                      <div className="utility-row">
                        {s.visibility === "private" ? <Lock /> : <Globe />}
                        <strong>{s.name}</strong>
                        <Select
                          aria-label={`Sichtbarkeit ${s.name}`}
                          value={s.visibility}
                          onChange={(e) =>
                            act({
                              action: "space.update",
                              spaceId: s.id,
                              name: s.name,
                              version: s.version,
                              private: e.target.value === "private",
                            })
                          }
                        >
                          <option value="team">Gesamtes Team</option>
                          <option value="private">Nur Berechtigte</option>
                        </Select>
                      </div>
                      {settings?.groups.map((g) => (
                        <div className="permission-row" key={g.id}>
                          <Users size={16} />
                          <span>{g.name}</span>
                          <Select
                            aria-label={`Rechte ${g.name} in ${s.name}`}
                            value={
                              settings.grants.find(
                                (x) =>
                                  x.resource_id === s.id && x.group_id === g.id,
                              )?.role || "remove"
                            }
                            onChange={(e) =>
                              act({
                                action: "grant.set",
                                resourceId: s.id,
                                groupId: g.id,
                                role: e.target.value,
                              })
                            }
                          >
                            <option value="remove">
                              Keine zusätzlichen Rechte
                            </option>
                            <option value="viewer">Ansehen</option>
                            <option value="editor">Bearbeiten</option>
                          </Select>
                        </div>
                      ))}
                    </div>
                  ))}
                </section>
              </>
            ) : (
              <div className="empty-state">
                <ShieldCheck size={36} />
                <h3>Nur für Eigentümer</h3>
                <p>
                  Gruppen und Berechtigungen verwaltet ein Eigentümer des
                  Arbeitsbereichs.
                </p>
              </div>
            ))}
          {tab === "data" && (
            <>
              <OfflineSettings
                userId={boot.user.id}
                workspaceId={boot.workspace.id}
                pageIds={boot.pages
                  .filter((p) => !p.deleted_at)
                  .map((p) => p.id)}
              />
              <section className="settings-section">
                <h2>Arbeitsbereich exportieren</h2>
                <p>
                  Das ZIP-Inhaltsarchiv enthält zugängliche Seiten
                  einschließlich Papierkorb, Datenbanken, interne Verknüpfungen,
                  Seiten- und Datensatzvorlagen, Kommentare, Versionen,
                  Favoriten und hochgeladene Dateien.
                </p>
                <div className="archive-actions">
                  <button
                    className="button primary"
                    disabled={archiveBusy}
                    onClick={async () => {
                      setArchiveBusy(true);
                      try {
                        const response = await fetch(
                          `/api/backup?workspace=${boot.workspace.id}`,
                        );
                        if (!response.ok)
                          throw new Error((await response.json()).error);
                        const blob = await response.blob();
                        const url = URL.createObjectURL(blob),
                          link = document.createElement("a");
                        link.href = url;
                        link.download = `flowplan-${new Date().toISOString().slice(0, 10)}.zip`;
                        document.body.appendChild(link);
                        link.click();
                        link.remove();
                        setTimeout(() => URL.revokeObjectURL(url), 10000);
                      } catch (e) {
                        onError((e as Error).message);
                      } finally {
                        setArchiveBusy(false);
                      }
                    }}
                  >
                    <DownloadSimple />
                    {archiveBusy
                      ? "Archiv wird verarbeitet …"
                      : "ZIP mit Dateien exportieren"}
                  </button>
                  <button
                    className="button"
                    onClick={async () => {
                      try {
                        const data = await api(
                          `/api/export?workspace=${boot.workspace.id}`,
                        );
                        download(
                          "flowplan-export.json",
                          JSON.stringify(data, null, 2),
                          "application/json",
                        );
                      } catch (e) {
                        onError((e as Error).message);
                      }
                    }}
                  >
                    <DownloadSimple />
                    JSON ohne Dateien exportieren
                  </button>
                </div>
              </section>
              <section className="settings-section">
                <h2>Markdown oder Text importieren</h2>
                <p>
                  Jede Datei wird als neue Seite in deinem Arbeitsbereich
                  angelegt.
                </p>
                <label className="button file-label">
                  <UploadSimple />
                  Dateien auswählen
                  <input
                    type="file"
                    accept=".md,.txt,.html"
                    multiple
                    hidden
                    disabled={boot.workspace.role === "viewer"}
                    onChange={async (e) => {
                      for (const file of Array.from(e.target.files || [])) {
                        if (file.size > 2_000_000) {
                          onError("Datei zu groß (max. 2 MB)");
                          continue;
                        }
                        try {
                          await mutate({
                            action: "page.import",
                            workspaceId: boot.workspace.id,
                            spaceId: boot.spaces[0].id,
                            title: file.name.replace(/\.[^.]+$/, ""),
                            content: await file.text(),
                            format: file.name.endsWith(".html")
                              ? "html"
                              : file.name.endsWith(".md")
                                ? "markdown"
                                : "text",
                          });
                        } catch (err) {
                          onError((err as Error).message);
                        }
                      }
                      e.target.value = "";
                    }}
                  />
                </label>
              </section>
              <ClipperSettings
                spaces={boot.spaces.filter((space) => !space.deleted_at)}
                canWrite={boot.workspace.role !== "viewer" && !boot.workspace.guest}
                onImport={async (spaceId, html) => {
                  try {
                    const result = (await mutate({
                      action: "bookmarks.import",
                      workspaceId: boot.workspace.id,
                      spaceId,
                      html,
                    })) as { added: number; skipped: number };
                    onError(
                      `${result.added} Lesezeichen importiert${result.skipped ? `, ${result.skipped} übersprungen` : ""}.`,
                    );
                  } catch (err) {
                    onError((err as Error).message);
                  }
                }}
              />
              <section className="settings-section">
                <h2>Notion-, AppFlowy- oder Markdown-Export importieren</h2>
                <p>
                  ZIP mit Markdown- und CSV-Dateien: Markdown wird zu Seiten,
                  CSV zu Datenbanken, Ordner zu Unterseiten. Bilder und Dateien,
                  auf die Markdown verweist, werden hochgeladen; Datensatzseiten
                  aus Notion werden den Einträgen zugeordnet. Maximal 100 MB,
                  500 Seiten und 5.000 Einträge je Tabelle.
                </p>
                <label>
                  Zielbereich
                  <Select
                    aria-label="Zielbereich für den Import"
                    value={importSpace || boot.spaces[0]?.id || ""}
                    onChange={(e) => setImportSpace(e.target.value)}
                  >
                    {boot.spaces.map((space) => (
                      <option key={space.id} value={space.id}>
                        {space.name}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="button file-label">
                  <UploadSimple />
                  {zipBusy ? "Import läuft …" : "ZIP auswählen"}
                  <input
                    type="file"
                    accept=".zip,application/zip"
                    hidden
                    aria-label="Export-ZIP importieren"
                    disabled={boot.workspace.role === "viewer" || zipBusy}
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (!file) return;
                      setZipBusy(true);
                      setZipResult("");
                      try {
                        const body = new FormData();
                        body.set("workspaceId", boot.workspace.id);
                        body.set(
                          "spaceId",
                          importSpace || boot.spaces[0]?.id || "",
                        );
                        body.set("file", file);
                        const response = await fetch("/api/import/zip", {
                          method: "POST",
                          body,
                        });
                        const result = await response.json();
                        if (!response.ok)
                          throw new Error(
                            result.error || "Import fehlgeschlagen.",
                          );
                        setZipResult(
                          `${result.pages} Seiten, ${result.rows} Einträge und ${result.files} Dateien importiert.`,
                        );
                        await onRefresh();
                      } catch (err) {
                        onError((err as Error).message);
                      } finally {
                        setZipBusy(false);
                      }
                    }}
                  />
                </label>
                {zipResult && <p role="status">{zipResult}</p>}
              </section>
              <section className="settings-section">
                <h2>Flowplan-Backup importieren</h2>
                <p>
                  ZIP-Archive werden als Kopien in neuen privaten Bereichen
                  wiederhergestellt. Alte Freigaben und Anmeldedaten werden
                  nicht aktiviert. Maximal 2 GB ZIP / 4 GB entpackt.
                  JSON-Dateien bleiben als älteres Importformat verfügbar.
                </p>
                <label className="button file-label">
                  <UploadSimple />
                  {archiveBusy
                    ? "Archiv wird verarbeitet …"
                    : "ZIP-Archiv auswählen"}
                  <input
                    type="file"
                    accept=".zip"
                    hidden
                    disabled={archiveBusy || boot.workspace.role === "viewer"}
                    onChange={async (e) => {
                      const input = e.currentTarget,
                        file = input.files?.[0];
                      if (!file) return;
                      setArchiveBusy(true);
                      try {
                        if (file.size > 2 * 1024 * 1024 * 1024)
                          throw new Error("ZIP darf maximal 2 GB groß sein.");
                        const r = await fetch(
                          `/api/backup?workspace=${boot.workspace.id}`,
                          {
                            method: "POST",
                            headers: { "Content-Type": "application/zip" },
                            body: file,
                          },
                        );
                        const result = await r.json();
                        if (!r.ok) throw new Error(result.error);
                        await onRefresh();
                        onError(
                          `${result.pages} ${result.pages === 1 ? "Seite" : "Seiten"} und ${result.files} ${result.files === 1 ? "Datei" : "Dateien"} importiert.${result.omittedRelations ? ` ${result.omittedRelations} Verknüpfungen zu nicht enthaltenen Einträgen konnten nicht übernommen werden.` : ""}`,
                        );
                      } catch (e) {
                        onError((e as Error).message);
                      } finally {
                        setArchiveBusy(false);
                        input.value = "";
                      }
                    }}
                  />
                </label>
                <label className="button file-label">
                  <UploadSimple />
                  JSON-Backup auswählen
                  <input
                    type="file"
                    accept=".json"
                    hidden
                    disabled={boot.workspace.role === "viewer"}
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (f) {
                        try {
                          await mutate({
                            action: "workspace.import",
                            workspaceId: boot.workspace.id,
                            spaceId: boot.spaces[0].id,
                            backup: JSON.parse(await f.text()),
                          });
                          onError("Backup importiert");
                        } catch (err) {
                          onError((err as Error).message);
                        }
                      }
                      e.target.value = "";
                    }}
                  />
                </label>
              </section>
              <section className="settings-section">
                <h2>Offline & Synchronisierung</h2>
                <p>
                  Dokumente und Whiteboards werden zusätzlich auf diesem Gerät
                  gespeichert und nach Wiederherstellung der Verbindung
                  zusammengeführt. Einträge in Datenbanken lassen sich offline
                  anlegen, ändern und löschen; Konflikte kannst du danach
                  auflösen.
                </p>
              </section>
            </>
          )}
        </div>
      </div>
      <Modal
        open={!!groupId}
        onClose={() => setGroupId(null)}
        title={settings?.groups.find((g) => g.id === groupId)?.name || "Gruppe"}
      >
        {boot.members.map((m) => (
          <label className="member-row checkbox-label" key={m.id}>
            <input
              type="checkbox"
              checked={
                !!settings?.groupMembers.some(
                  (g) => g.group_id === groupId && g.user_id === m.id,
                )
              }
              onChange={(e) =>
                act({
                  action: "group.member",
                  groupId,
                  userId: m.id,
                  enabled: e.target.checked,
                })
              }
            />
            <Avatar name={m.name} userId={m.id} />
            <span>{m.name}</span>
          </label>
        ))}
      </Modal>
    </div>
  );
}
