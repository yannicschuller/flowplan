"use client";
import { serverMessage } from "@/lib/i18n-errors";
import { useT } from "./i18n";
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
    ["Allgemein", "General"],
    SlidersHorizontal,
    ["Name, Symbol und Aussehen des Arbeitsbereichs, dein Profil und Tastenkürzel.", "Name, icon and appearance of the workspace, your profile and keyboard shortcuts."],
  ],
  [
    "spaces",
    ["Bereiche", "Spaces"],
    FolderSimple,
    ["Bereiche anlegen, umbenennen, freigeben und ihr Aussehen festlegen.", "Create, rename and share spaces and set their appearance."],
  ],
  [
    "members",
    ["Mitglieder", "Members"],
    UsersThree,
    ["Wer zum Arbeitsbereich gehört, mit welcher Rolle, und wer eingeladen ist.", "Who belongs to the workspace, in which role, and who is invited."],
  ],
  [
    "groups",
    ["Gruppen & Rechte", "Groups & permissions"],
    ShieldCheck,
    ["Gruppen bilden und ihnen Zugriff auf Bereiche geben.", "Form groups and give them access to spaces."],
  ],
  [
    "data",
    ["Daten", "Data"],
    Database,
    ["Offline-Nutzung, Export und Import von Inhalten.", "Offline use, export and import of content."],
  ],
  [
    "notifications",
    ["Benachrichtigungen", "Notifications"],
    BellSimple,
    ["Welche Benachrichtigungen dich im Posteingang, per Push und per E-Mail erreichen.", "Which notifications reach you in the inbox, as push and by e-mail."],
  ],
  [
    "integrations",
    ["API & Webhooks", "API & webhooks"],
    PlugsConnected,
    ["Persönliche API-Tokens für Skripte und Automationen, Webhooks des Arbeitsbereichs.", "Personal API tokens for scripts and automations, the workspace's webhooks."],
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
  const t = useT();
  const [tab, setTab] = useState("general"),
    [email, setEmail] = useState(""),
    [role, setRole] = useState("editor"),
    [inviteGuest, setInviteGuest] = useState(false),
    [name, setName] = useState(boot.workspace.name),
    [groupName, setGroupName] = useState(""),
    [settings, setSettings] = useState<SettingsData | null>(null),
    [groupId, setGroupId] = useState<string | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [trackerBusy, setTrackerBusy] = useState(false);
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
          <h1>{t("Einstellungen", "Settings")}</h1>
          <p>
            {t("Arbeitsbereich „", "Workspace “")}{boot.workspace.name}{t("“ – Mitglieder, Rechte, Daten und Aussehen.", "” – members, permissions, data and appearance.")}
          </p>
        </div>
      </div>
      <div className="settings-layout">
        <nav className="settings-tabs" aria-label={t("Bereiche der Einstellungen", "Settings sections")}>
          {settingsTabs.map(([id, label, Icon]) => (
            <button
              key={id}
              className={tab === id ? "selected" : ""}
              aria-current={tab === id ? "page" : undefined}
              onClick={() => setTab(id)}
            >
              <Icon size={18} aria-hidden="true" />
              {t(label[0], label[1])}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          <p className="settings-intro">
            {(() => {
              const intro = settingsTabs.find(([id]) => id === tab)?.[3];
              return intro ? t(intro[0], intro[1]) : null;
            })()}
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
              <h2>{t("Bereiche verwalten", "Manage spaces")}</h2>
              <p>
                {t("Bereichseigentümer verwalten ihre eigenen Bereiche. Arbeitsbereichseigentümer können alle Bereiche verwalten; private Seiten bleiben an ihre Leserechte gebunden.", "Space owners manage their own spaces. Workspace owners can manage all spaces; private pages stay bound to their read permissions.")}
              </p>
              {(boot.managedSpaces || []).map((space) => (
                <div className="utility-row" key={space.id}>
                  <SpaceIcon icon={space.icon} color={space.icon_color} />
                  {space.visibility === "private" && (
                    <Lock aria-label={t("Privater Bereich", "Private space")} />
                  )}
                  <strong>{space.name}</strong>
                  <button
                    className="button compact"
                    onClick={() => setEditingSpace(space)}
                  >
                    {t("Verwalten", "Manage")}
                  </button>
                </div>
              ))}
              {!boot.managedSpaces?.length && (
                <p className="muted">
                  {t("Keine Bereiche mit Verwaltungsrechten vorhanden.", "No spaces you can manage.")}
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
                <h2>{t("Arbeitsbereich", "Workspace")}</h2>
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (await act({ action: "workspace.update", name }))
                      onError(t("Arbeitsbereich gespeichert", "Workspace saved"));
                  }}
                >
                  <WorkspaceIconPicker
                    name={boot.workspace.name}
                    icon={boot.workspace.icon}
                    disabled={!owner}
                    save={(icon) => act({ action: "workspace.update", icon })}
                  />
                  <label>
                    {t("Name", "Name")}
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      disabled={!owner}
                    />
                  </label>
                  {owner && (
                    <button className="button primary compact">
                      {t("Änderungen speichern", "Save changes")}
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
                <h2>{t("Erscheinungsbild", "Appearance")}</h2>
                <div className="theme-options">
                  <button
                    className={!dark ? "selected" : ""}
                    onClick={() => setDark(false)}
                  >
                    <Sun size={25} />
                    {t("Hell", "Light")}
                  </button>
                  <button
                    className={dark ? "selected" : ""}
                    onClick={() => setDark(true)}
                  >
                    <Moon size={25} />
                    {t("Dunkel", "Dark")}
                  </button>
                </div>
              </section>
              <section className="settings-section">
                <h2>{t("Dein Profil", "Your profile")}</h2>
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
                    {t("Name und E-Mail werden von deinem Identitätsanbieter übernommen.", "Your name and e-mail come from your identity provider.")}
                  </p>
                )}
              </section>
              <section className="settings-section">
                <h2>{t("Tastenkürzel", "Keyboard shortcuts")}</h2>
                <div className="shortcut">
                  <span>{t("Seiten suchen", "Search pages")}</span>
                  <kbd>⌘ / Ctrl + K</kbd>
                </div>
                <div className="shortcut">
                  <span>{t("Neue Seite", "New page")}</span>
                  <kbd>⌘ / Ctrl + N</kbd>
                </div>
                <div className="shortcut">
                  <span>{t("Editor-Befehle", "Editor commands")}</span>
                  <kbd>/</kbd>
                </div>
                <div className="shortcut">
                  <span>{t("Fett / Kursiv", "Bold / italic")}</span>
                  <kbd>⌘ / Ctrl + B / I</kbd>
                </div>
              </section>
            </>
          )}
          {tab === "members" && (
            <>
              <section className="settings-section">
                <h2>{t("Mitglieder ·", "Members ·")}{" "}{boot.members.length}</h2>
                {boot.members.map((m) => (
                  <div className="member-row" key={m.id}>
                    <Avatar name={m.name} userId={m.id} />
                    <span>
                      {m.name}
                      {!!m.guest && (
                        <span className="tag tag-yellow">{t("Gast", "Guest")}</span>
                      )}
                      <small>{m.email}</small>
                    </span>
                    {owner && m.role !== "owner" && (
                      <button
                        className="button compact"
                        aria-label={
                          m.guest
                            ? t(`${m.name} zum Mitglied machen`, `Make ${m.name} a member`)
                            : t(`${m.name} zum Gast machen`, `Make ${m.name} a guest`)
                        }
                        onClick={() =>
                          act({
                            action: "member.guest",
                            userId: m.id,
                            guest: !m.guest,
                          })
                        }
                      >
                        {m.guest ? t("Zum Mitglied machen", "Make member") : t("Zum Gast machen", "Make guest")}
                      </button>
                    )}
                    {owner ? (
                      <Select
                        aria-label={t(`Rolle für ${m.name}`, `Role for ${m.name}`)}
                        value={m.role}
                        onChange={(e) =>
                          act({
                            action: "member.role",
                            userId: m.id,
                            role: e.target.value,
                          })
                        }
                      >
                        <option value="owner">{t("Eigentümer", "Owner")}</option>
                        <option value="editor">{t("Bearbeiten", "Edit")}</option>
                        <option value="viewer">{t("Ansehen", "View")}</option>
                        <option value="remove">{t("Entfernen", "Remove")}</option>
                      </Select>
                    ) : (
                      <span className="tag">{m.role}</span>
                    )}
                  </div>
                ))}
              </section>
              {owner && (
                <section className="settings-section">
                  <h2>{t("Mitglied einladen", "Invite member")}</h2>
                  <p className="muted">
                    {t("Die Freigabe wird bei der nächsten SSO-Anmeldung mit bestätigter E-Mail automatisch zugeordnet.", "The invitation is assigned automatically once the person signs in with this confirmed e-mail address.")}
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
                      placeholder={t("name@unternehmen.de", "name@company.com")}
                      aria-label={t("E-Mail des neuen Mitglieds", "E-mail of the new member")}
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                    <Select
                      value={role}
                      aria-label={t("Rolle", "Role")}
                      onChange={(e) => setRole(e.target.value)}
                    >
                      <option value="editor">{t("Bearbeiten", "Edit")}</option>
                      <option value="viewer">{t("Ansehen", "View")}</option>
                    </Select>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={inviteGuest}
                        onChange={(e) => setInviteGuest(e.target.checked)}
                      />
                      {t("Als Gast (nur freigegebene Seiten)", "As a guest (shared pages only)")}
                    </label>
                    <button className="button primary">
                      <Plus />
                      {t("Freigeben", "Invite")}
                    </button>
                  </form>
                  {settings?.invites.map((i) => (
                    <div className="utility-row" key={i.id}>
                      <span>{i.email}</span>
                      <span className="tag tag-yellow">
                        {i.guest ? t("Gast · ausstehend", "Guest · pending") : t("Ausstehend", "Pending")}
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
                  <h2>{t("Gruppen", "Groups")}</h2>
                  <p className="muted">
                    {t("Fasse Mitglieder zusammen und vergebe gemeinsame Rechte für Bereiche.", "Bring members together and give them shared permissions for spaces.")}
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
                      aria-label={t("Gruppenname", "Group name")}
                      onChange={(e) => setGroupName(e.target.value)}
                      placeholder={t("Neue Gruppe", "New group")}
                    />
                    <button className="button primary">
                      <Plus />
                      {t("Erstellen", "Create")}
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
                        {t("Mitglieder", "Members")}
                      </span>
                      <button
                        className="button compact"
                        onClick={() => setGroupId(g.id)}
                      >
                        {t("Verwalten", "Manage")}
                      </button>
                    </div>
                  ))}
                </section>
                <section className="settings-section">
                  <h2>{t("Bereiche & Zugriffsrechte", "Spaces & access")}</h2>
                  {(boot.managedSpaces || boot.spaces).map((s) => (
                    <div className="space-settings" key={s.id}>
                      <div className="utility-row">
                        {s.visibility === "private" ? <Lock /> : <Globe />}
                        <strong>{s.name}</strong>
                        <Select
                          aria-label={t(`Sichtbarkeit ${s.name}`, `Visibility ${s.name}`)}
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
                          <option value="team">{t("Gesamtes Team", "Whole team")}</option>
                          <option value="private">{t("Nur Berechtigte", "Only people with access")}</option>
                        </Select>
                      </div>
                      {settings?.groups.map((g) => (
                        <div className="permission-row" key={g.id}>
                          <Users size={16} />
                          <span>{g.name}</span>
                          <Select
                            aria-label={t(`Rechte ${g.name} in ${s.name}`, `Permissions of ${g.name} in ${s.name}`)}
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
                              {t("Keine zusätzlichen Rechte", "No additional permissions")}
                            </option>
                            <option value="viewer">{t("Ansehen", "View")}</option>
                            <option value="editor">{t("Bearbeiten", "Edit")}</option>
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
                <h3>{t("Nur für Eigentümer", "Owners only")}</h3>
                <p>
                  {t("Gruppen und Berechtigungen verwaltet ein Eigentümer des Arbeitsbereichs.", "Groups and permissions are managed by an owner of the workspace.")}
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
                <h2>{t("Arbeitsbereich exportieren", "Export workspace")}</h2>
                <p>
                  {t("Das ZIP-Inhaltsarchiv enthält zugängliche Seiten einschließlich Papierkorb, Datenbanken, interne Verknüpfungen, Seiten- und Datensatzvorlagen, Kommentare, Versionen, Favoriten und hochgeladene Dateien.", "The ZIP content archive contains accessible pages including the trash, databases, internal links, page and record templates, comments, versions, favourites and uploaded files.")}
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
                          throw new Error(serverMessage((await response.json()).error));
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
                      ? t("Archiv wird verarbeitet …", "Processing archive …")
                      : t("ZIP mit Dateien exportieren", "Export ZIP with files")}
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
                    {t("JSON ohne Dateien exportieren", "Export JSON without files")}
                  </button>
                </div>
              </section>
              <section className="settings-section">
                <h2>{t("Markdown oder Text importieren", "Import Markdown or text")}</h2>
                <p>
                  {t("Jede Datei wird als neue Seite in deinem Arbeitsbereich angelegt.", "Every file becomes a new page in your workspace.")}
                </p>
                <label className="button file-label">
                  <UploadSimple />
                  {t("Dateien auswählen", "Choose files")}
                  <input
                    type="file"
                    accept=".md,.txt,.html"
                    multiple
                    hidden
                    disabled={boot.workspace.role === "viewer"}
                    onChange={async (e) => {
                      for (const file of Array.from(e.target.files || [])) {
                        if (file.size > 2_000_000) {
                          onError(t("Datei zu groß (max. 2 MB)", "File too large (max. 2 MB)"));
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
                      t(`${result.added} Lesezeichen importiert${result.skipped ? `, ${result.skipped} übersprungen` : ""}.`, `${result.added} bookmarks imported${result.skipped ? `, ${result.skipped} skipped` : ""}.`),
                    );
                  } catch (err) {
                    onError((err as Error).message);
                  }
                }}
              />
              <section className="settings-section">
                <h2>{t("Aus Jira oder Trello importieren", "Import from Jira or Trello")}</h2>
                <p>
                  {t(
                    "Jira: Vorgänge als CSV exportieren (alle Felder). Trello: Board-Menü → Drucken, exportieren und teilen → Als JSON exportieren. Daraus wird eine neue Datenbank mit Status, Priorität, Zuständigen, Labels, Story Points und Unteraufgaben; Beschreibungen werden zum Inhalt, Kommentare zu Kommentaren, Anhänge zu Links.",
                    "Jira: export issues as CSV (all fields). Trello: board menu → Print, export and share → Export as JSON. This becomes a new database with status, priority, assignees, labels, story points and subtasks; descriptions become the content, comments comments, attachments links.",
                  )}
                </p>
                <label className="button file-label">
                  <UploadSimple />
                  {trackerBusy ? t("Import läuft …", "Importing …") : t("CSV oder JSON auswählen", "Choose CSV or JSON")}
                  <input
                    type="file"
                    accept=".csv,.json,text/csv,application/json"
                    hidden
                    aria-label={t("Jira- oder Trello-Export importieren", "Import Jira or Trello export")}
                    disabled={boot.workspace.role === "viewer" || trackerBusy}
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (!file) return;
                      setTrackerBusy(true);
                      try {
                        const body = new FormData();
                        body.set("workspaceId", boot.workspace.id);
                        body.set("spaceId", importSpace || boot.spaces[0]?.id || "");
                        body.set("file", file);
                        const response = await fetch("/api/import/tracker", { method: "POST", body });
                        const result = await response.json();
                        if (!response.ok) throw new Error(serverMessage(result.error) || t("Import fehlgeschlagen.", "Import failed."));
                        await onRefresh();
                        onError(t(`${result.rows} Einträge und ${result.comments} Kommentare importiert.`, `${result.rows} records and ${result.comments} comments imported.`));
                        location.hash = `#page=${result.pageId}`;
                      } catch (err) {
                        onError((err as Error).message);
                      } finally {
                        setTrackerBusy(false);
                      }
                    }}
                  />
                </label>
              </section>
              <section className="settings-section">
                <h2>{t("Notion-, AppFlowy- oder Markdown-Export importieren", "Import a Notion, AppFlowy or Markdown export")}</h2>
                <p>
                  {t("ZIP mit Markdown- und CSV-Dateien: Markdown wird zu Seiten, CSV zu Datenbanken, Ordner zu Unterseiten. Bilder und Dateien, auf die Markdown verweist, werden hochgeladen; Datensatzseiten aus Notion werden den Einträgen zugeordnet. Maximal 100 MB, 500 Seiten und 5.000 Einträge je Tabelle.", "A ZIP with Markdown and CSV files: Markdown becomes pages, CSV databases, folders sub-pages. Images and files referenced in Markdown are uploaded; Notion record pages are matched to their records. At most 100 MB, 500 pages and 5,000 records per table.")}
                </p>
                <label>
                  {t("Zielbereich", "Target space")}
                  <Select
                    aria-label={t("Zielbereich für den Import", "Target space for the import")}
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
                  {zipBusy ? t("Import läuft …", "Importing …") : t("ZIP auswählen", "Choose ZIP")}
                  <input
                    type="file"
                    accept=".zip,application/zip"
                    hidden
                    aria-label={t("Export-ZIP importieren", "Import export ZIP")}
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
                            serverMessage(result.error) || t("Import fehlgeschlagen.", "Import failed."),
                          );
                        setZipResult(
                          t(`${result.pages} Seiten, ${result.rows} Einträge und ${result.files} Dateien importiert.`, `${result.pages} pages, ${result.rows} records and ${result.files} files imported.`),
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
                <h2>{t("Flowplan-Backup importieren", "Import a Flowplan backup")}</h2>
                <p>
                  {t("ZIP-Archive werden als Kopien in neuen privaten Bereichen wiederhergestellt. Alte Freigaben und Anmeldedaten werden nicht aktiviert. Maximal 2 GB ZIP / 4 GB entpackt. JSON-Dateien bleiben als älteres Importformat verfügbar.", "ZIP archives are restored as copies in new private spaces. Old shares and sign-in data are not activated. At most 2 GB ZIP / 4 GB unpacked. JSON files remain available as an older import format.")}
                </p>
                <label className="button file-label">
                  <UploadSimple />
                  {archiveBusy
                    ? t("Archiv wird verarbeitet …", "Processing archive …")
                    : t("ZIP-Archiv auswählen", "Choose ZIP archive")}
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
                          throw new Error(t("ZIP darf maximal 2 GB groß sein.", "The ZIP may be at most 2 GB."));
                        const r = await fetch(
                          `/api/backup?workspace=${boot.workspace.id}`,
                          {
                            method: "POST",
                            headers: { "Content-Type": "application/zip" },
                            body: file,
                          },
                        );
                        const result = await r.json();
                        if (!r.ok) throw new Error(serverMessage(result.error));
                        await onRefresh();
                        onError(
                          t(`${result.pages} ${result.pages === 1 ? "Seite" : "Seiten"} und ${result.files} ${result.files === 1 ? "Datei" : "Dateien"} importiert.${result.omittedRelations ? ` ${result.omittedRelations} Verknüpfungen zu nicht enthaltenen Einträgen konnten nicht übernommen werden.` : ""}`, `${result.pages} ${result.pages === 1 ? "page" : "pages"} and ${result.files} ${result.files === 1 ? "file" : "files"} imported.${result.omittedRelations ? ` ${result.omittedRelations} links to records not included could not be kept.` : ""}`),
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
                  {t("JSON-Backup auswählen", "Choose JSON backup")}
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
                          onError(t("Backup importiert", "Backup imported"));
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
                <h2>{t("Offline & Synchronisierung", "Offline & sync")}</h2>
                <p>
                  {t("Dokumente und Whiteboards werden zusätzlich auf diesem Gerät gespeichert und nach Wiederherstellung der Verbindung zusammengeführt. Einträge in Datenbanken lassen sich offline anlegen, ändern und löschen; Konflikte kannst du danach auflösen.", "Documents and whiteboards are also stored on this device and merged once the connection is back. Database records can be created, changed and deleted offline; you can resolve conflicts afterwards.")}
                </p>
              </section>
            </>
          )}
        </div>
      </div>
      <Modal
        open={!!groupId}
        onClose={() => setGroupId(null)}
        title={settings?.groups.find((g) => g.id === groupId)?.name || t("Gruppe", "Group")}
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
