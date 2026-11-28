"use client";
import { useLocale, useT } from "./i18n";
import { ANDROID_APK_URL, APP_STORE_URL, DOWNLOAD_URL } from "@/lib/app-links";
import { friendlyError } from "./ui";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { CircleNotch } from "@phosphor-icons/react";
import { ago } from "./page-activity";
import {
  CONTROL,
  ResponsiveTable,
  SettingGroup,
  SettingRow,
  StatusBadge,
  Switch,
  SwitchRow,
  UsageMeter,
} from "./settings-ui";
import { bytes } from "./admin-storage";
import { Select } from "./select";
import {
  OFFLINE_CHANGED,
  OFFLINE_SYNC,
  budgetOf,
  disableOffline,
  enableOffline,
  offlineMarker,
  offlinePlatform,
  offlineRefreshing,
  offlineSupported,
  persistOffline,
  refreshOffline,
  setOfflineBudget,
  setOfflineKeep,
  setOfflineRecords,
  type OfflineMarker,
  type OfflinePersistence,
} from "./offline";
import { offlineUnsupportedReason } from "@/lib/native-app";
import { appOfflineBridge, isStorageRefusal } from "@/lib/offline-store";
import { budgetChoices, defaultBudget, isKept, type KeepItem, type SpaceUsage } from "@/lib/offline-keep";
import type { Page, Space } from "@/lib/types";

// Settings → Offline & Geräte. Opt-in per device: the copies contain the
// workspace's private content.
export function OfflineSettings({
  userId,
  workspaceId,
  spaces = [],
  pages = [],
}: {
  userId: string;
  workspaceId: string;
  // For the storage per space and the kept items (#417).
  spaces?: Space[];
  pages?: Page[];
}) {
  const t = useT();
  const locale = useLocale();
  const [supported, setSupported] = useState(true),
    [marker, setMarker] = useState<OfflineMarker | null>(null),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState<[number, number] | null>(null),
    [message, setMessage] = useState(""),
    // The iPhone and iPad app keeps the copy (lib/offline-store.ts).
    [inApp, setInApp] = useState(false),
    // Persistent storage (#417): asked for when offline use is on.
    [persisted, setPersisted] = useState<OfflinePersistence>("unknown"),
    // A refresh this tab runs that the settings did not start (#644), e.g.
    // the one on opening the app.
    [refreshing, setRefreshing] = useState(false);
  const waitId = useId();
  // The status line in "Offline copy" scrolled out of view (#644): a copy of
  // it stays at the top of the pane while a sync runs.
  const statusLine = useRef<HTMLSpanElement>(null),
    [statusHidden, setStatusHidden] = useState(false);
  const load = useCallback(
    () =>
      void offlineMarker().then((m) =>
        setMarker(m?.user === userId ? m : null),
      ),
    [userId],
  );
  useEffect(() => {
    if (!offlineSupported()) {
      setSupported(false);
      return;
    }
    setInApp(!!appOfflineBridge());
    load();
    const sync = () => setRefreshing(offlineRefreshing());
    sync();
    window.addEventListener(OFFLINE_CHANGED, load);
    window.addEventListener(OFFLINE_SYNC, sync);
    return () => {
      window.removeEventListener(OFFLINE_CHANGED, load);
      window.removeEventListener(OFFLINE_SYNC, sync);
    };
  }, [load]);
  const enabled = !!marker;
  useEffect(() => {
    if (enabled) void persistOffline({ ask: false }).then(setPersisted);
  }, [enabled, marker?.lastRefresh]);

  // The device took nothing (#417, lib/offline-store.ts OfflineRefused).
  const storageText = () =>
    t(
      "Auf diesem Gerät ist zu wenig Speicher für die Offline-Kopie frei – gib etwas Speicher frei und aktualisiere dann erneut.",
      "There is too little storage left on this device for the offline copy – free up some space, then update again.",
    );
  const pagesText = (n: number) => (n === 1 ? t("1 Seite", "1 page") : t(`${n} Seiten`, `${n} pages`));
  async function enable() {
    setBusy(true);
    setMessage("");
    try {
      const result = await enableOffline(userId, workspaceId, (done, total) =>
        setProgress([done, total]),
      );
      const n = (await offlineMarker())?.pages ?? result.fetched;
      setMessage(
        result.status === "signed-out"
          ? t(
              "Du wurdest abgemeldet – melde dich erneut an, um die Offline-Kopie zu aktualisieren.",
              "You were signed out – sign in again to update the offline copy.",
            )
          : result.status === "storage"
            ? storageText()
            : result.status === "incomplete"
            ? t(
                "Nicht alle Seiten konnten gespeichert werden – sie werden beim nächsten Aktualisieren nachgeholt.",
                "Not every page could be stored – they follow with the next update.",
              )
            : t(
                `${pagesText(n)} auf diesem Gerät offline verfügbar.`,
                `${pagesText(n)} available offline on this device.`,
              ),
      );
    } catch (error) {
      setMessage(isStorageRefusal(error) ? storageText() : friendlyError(error));
    } finally {
      setBusy(false);
      setProgress(null);
      load();
    }
  }
  async function update(again = false) {
    setBusy(true);
    setMessage("");
    try {
      const result = await refreshOffline({
        full: true,
        again,
        onProgress: (done, total) => setProgress([done, total]),
      });
      setMessage(
        result.status === "signed-out"
          ? t(
              "Du wurdest abgemeldet – melde dich erneut an, um die Offline-Kopie zu aktualisieren.",
              "You were signed out – sign in again to update the offline copy.",
            )
          : result.status === "storage"
            ? storageText()
            : result.status === "incomplete"
            ? t(
                "Nicht alle Seiten konnten aktualisiert werden – sie werden beim nächsten Mal nachgeholt.",
                "Not every page could be updated – they follow next time.",
              )
            : result.status === "busy"
              ? t(
                  "Die Offline-Kopie wird gerade aktualisiert.",
                  "The offline copy is being updated right now.",
                )
              : t(
                  "Offline-Kopie ist auf dem neuesten Stand.",
                  "Offline copy is up to date.",
                ),
      );
    } catch (error) {
      setMessage(isStorageRefusal(error) ? storageText() : friendlyError(error));
    } finally {
      setBusy(false);
      setProgress(null);
      load();
    }
  }
  // A choice the device did not store (#417): said so, and the settings
  // show again what is stored – not the choice as if it had been kept.
  function unsaved(error: unknown) {
    setMessage(
      isStorageRefusal(error)
        ? t(
            "Die Einstellung konnte auf diesem Gerät nicht gespeichert werden – zu wenig Speicher frei. Gib etwas Speicher frei und versuche es erneut.",
            "The setting could not be saved on this device – too little storage left. Free up some space and try again.",
          )
        : friendlyError(error),
    );
    load();
  }
  async function records(on: boolean) {
    setBusy(true);
    setMessage("");
    setMarker((m) => (m ? { ...m, includeRecords: on } : m));
    try {
      await setOfflineRecords(on);
      load();
      // Fetches the records and files right away – after a refresh that
      // already runs (it read the setting before).
      if (on) await update(true);
    } catch (error) {
      unsaved(error);
    } finally {
      setBusy(false);
    }
  }
  // The budget for record contents and files on this device and the items
  // kept offline (#417): the copy follows at once (only what changed).
  async function follow() {
    if (!navigator.onLine) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await refreshOffline({ again: true, onProgress: (done, total) => setProgress([done, total]) });
      setMessage(
        result.status === "signed-out"
          ? t(
              "Du wurdest abgemeldet – melde dich erneut an, um die Offline-Kopie zu aktualisieren.",
              "You were signed out – sign in again to update the offline copy.",
            )
          : result.status === "storage"
            ? storageText()
            : result.status === "incomplete"
            ? t(
                "Nicht alle Seiten konnten aktualisiert werden – sie werden beim nächsten Mal nachgeholt.",
                "Not every page could be updated – they follow next time.",
              )
            : t("Offline-Kopie ist auf dem neuesten Stand.", "Offline copy is up to date."),
      );
    } catch (error) {
      setMessage(isStorageRefusal(error) ? storageText() : friendlyError(error));
    } finally {
      setBusy(false);
      setProgress(null);
      load();
    }
  }
  async function budget(value: number) {
    setMarker((m) => (m ? { ...m, budget: value } : m));
    try {
      await setOfflineBudget(value);
    } catch (error) {
      return unsaved(error);
    }
    load();
    await follow();
  }
  async function keep(item: KeepItem, on: boolean) {
    try {
      await setOfflineKeep(item, on);
    } catch (error) {
      return unsaved(error);
    }
    load();
    await follow();
  }
  async function disable() {
    setBusy(true);
    try {
      await disableOffline();
      setMarker(null);
      setMessage(
        t(
          "Offline-Kopien auf diesem Gerät wurden entfernt.",
          "Offline copies on this device were removed.",
        ),
      );
    } finally {
      setBusy(false);
    }
  }
  const updated = marker?.lastRefresh;
  // The sync status (#644), in one place: the first line of "Offline copy"
  // – while a sync runs, what it does and how far it is instead of when the
  // copy was updated, afterwards the result of the run.
  const syncing = busy || refreshing;
  const syncText = (
    <>
      <CircleNotch size={14} aria-hidden className="spin" />
      <span>
        {!updated
          ? t("Offline-Kopie wird erstellt …", "Creating the offline copy …")
          : t("Offline-Kopie wird aktualisiert …", "Updating the offline copy …")}
        {progress && ` ${progress[0]} ${t("von", "of")} ${progress[1]}`}
      </span>
    </>
  );
  const syncStatus = (
    <span ref={statusLine} className={`offline-sync${syncing ? " syncing" : ""}`} role="status" data-testid="offline-sync">
      {syncing ? syncText : message}
    </span>
  );
  // Below the sticky "back" bar on phones (53 px), at the top elsewhere.
  useEffect(() => {
    const line = statusLine.current;
    if (!syncing || !line || typeof IntersectionObserver === "undefined") return setStatusHidden(false);
    const observer = new IntersectionObserver(([entry]) => setStatusHidden(!entry.isIntersecting && entry.boundingClientRect.top < (entry.rootBounds?.top ?? 53)), {
      rootMargin: "-53px 0px 0px 0px",
    });
    observer.observe(line);
    return () => observer.disconnect();
  }, [syncing, enabled]);
  // What waits for a sync these settings run (one at a time): the budget,
  // "Also store …", "Keep offline", "Update now" and removing the copy. It
  // is disabled until then, and says why. The first note (the budget's)
  // has the id the disabled controls point to.
  const withWait = (text: string, first = false) =>
    busy ? (
      <>
        {text}
        <span className="offline-wait" id={first ? waitId : undefined} data-testid="offline-wait">
          {updated
            ? t("Wieder verfügbar, sobald die Aktualisierung fertig ist.", "Available again once the update is done.")
            : t("Wird verfügbar, sobald die Offline-Kopie fertig ist.", "Available once the offline copy is ready.")}
        </span>
      </>
    ) : (
      text
    );
  // #417: the budget, the kept pages and the storage per space.
  const platform = offlinePlatform();
  const limit = budgetOf(marker);
  const keptPages = (marker?.keep || []).filter((item) => item.kind === "page");
  const empty: SpaceUsage = { pages: 0, records: 0, files: 0 };
  const spaceRows = spaces
    .filter((sp) => !sp.deleted_at)
    .map((sp) => ({ id: sp.id, name: sp.name, encrypted: !!(sp as { encrypted?: number }).encrypted, usage: marker?.spaces?.[sp.id] || empty }));
  // The app's own files (#47): stored completely for this version or not yet.
  const appState = ({ app }: OfflineMarker) =>
    !app
      ? t(
          "App-Dateien werden beim nächsten Aktualisieren gespeichert.",
          "The app's files are stored with the next update.",
        )
      : app.complete
        ? `${t(`Die App ist für die Offline-Nutzung gespeichert (Version ${app.version || "?"})`, `The app is stored for offline use (version ${app.version || "?"})`)} · ${bytes(app.bytes)}`
        : app.space
          ? t(
              `Zu wenig Speicherplatz für die App (${bytes(app.bytes)}) – Teile, die du nie online geöffnet hast, fehlen offline.`,
              `Not enough storage for the app (${bytes(app.bytes)}) – parts you never opened online are missing offline.`,
            )
          : t(
              `App erst teilweise gespeichert: ${app.stored} von ${app.total} Dateien (Version ${app.version || "?"})`,
              `App only partly stored: ${app.stored} of ${app.total} files (version ${app.version || "?"})`,
            );
  return (
    <>
      <SettingGroup
        id="offline"
        title={t("Offline-Nutzung", "Offline use")}
        description={t(
          "Speichert die ganze App (einmal je Version, etwa 15–20 MB) und die Seiten dieses Arbeitsbereichs auf diesem Gerät, damit du sie ohne Verbindung öffnen kannst. Solange die App geöffnet ist, hält sie die Kopie aktuell. Nur auf eigenen Geräten aktivieren: Die Kopien bleiben bis zum Abmelden oder Ausschalten erhalten.",
          "Stores the whole app (once per version, about 15–20 MB) and this workspace's pages on this device so you can open them without a connection. While the app is open it keeps the copy current. Only enable on your own devices: the copies stay until you sign out or turn this off.",
        )}
      >
        {!supported ? (
          offlineUnsupportedReason() === "ios-app" ? (
            <SettingRow
              label={t("In der App", "In the app")}
              description={t(
                "Diese Version der Flowplan-App für iPhone und iPad kann Inhalte noch nicht offline speichern. Aktualisiere die App, um Seiten und Datenbanken auch ohne Verbindung zu öffnen.",
                "This version of the Flowplan app for iPhone and iPad cannot store content offline yet. Update the app to open pages and databases without a connection.",
              )}
            >
              <StatusBadge tone="off">
                {t("App aktualisieren", "Update the app")}
              </StatusBadge>
            </SettingRow>
          ) : (
            <SettingRow
              label={t("Auf diesem Gerät", "On this device")}
              description={
                // Plain http (#62): the browser allows no service worker there.
                typeof window !== "undefined" && !window.isSecureContext
                  ? t(
                      "Die Offline-Kopie braucht HTTPS – diese Instanz läuft ohne.",
                      "The offline copy needs HTTPS – this instance runs without it.",
                    )
                  : t(
                      "Dieser Browser unterstützt keine Offline-Nutzung (sichere Verbindung und Service Worker erforderlich).",
                      "This browser does not support offline use (secure connection and service worker required).",
                    )
              }
            >
              <StatusBadge tone="off">
                {t("Nicht unterstützt", "Not supported")}
              </StatusBadge>
            </SettingRow>
          )
        ) : enabled ? (
          <>
            <SettingRow
              label={t("Offline-Kopie", "Offline copy")}
              description={
                <span className="offline-state" data-testid="offline-state">
                  {!syncing && (
                    <span className="offline-updated" data-testid="offline-updated">
                      {updated
                        ? t("Offline-Kopie aktualisiert", "Offline copy updated") +
                          " " +
                          ago(updated, Date.now(), locale)
                        : t(
                            "Offline-Kopie noch nicht vollständig",
                            "Offline copy not complete yet",
                          )}
                      {marker.pages !== undefined &&
                        ` · ${pagesText(marker.pages)}`}
                      {marker.bytes !== undefined && ` · ${bytes(marker.bytes)}`}
                    </span>
                  )}
                  {syncStatus}
                  <span className="offline-app" data-testid="offline-app">
                    {appState(marker)}
                  </span>
                  {inApp && (
                    <span
                      className="offline-in-app"
                      data-testid="offline-in-app"
                    >
                      {t(
                        "In der Flowplan-App gespeichert: Ohne Verbindung öffnet die App diese Kopie, Änderungen werden danach abgeglichen.",
                        "Stored in the Flowplan app: without a connection the app opens this copy, changes are synced afterwards.",
                      )}
                    </span>
                  )}
                </span>
              }
            >
              <StatusBadge tone={updated ? "ok" : "warn"}>
                {t("An", "On")}
              </StatusBadge>
              <button className="button" disabled={busy} aria-describedby={busy ? waitId : undefined} onClick={() => void update()}>
                {t("Jetzt aktualisieren", "Update now")}
              </button>
            </SettingRow>
            {syncing && (
              <div className="offline-sync-float" aria-hidden="true">
                {statusHidden && <span data-testid="offline-sync-float">{syncText}</span>}
              </div>
            )}
            {persisted !== "unknown" && (
              <SettingRow
                label={t("Speicher auf diesem Gerät", "Storage on this device")}
                description={
                  <span data-testid="offline-persisted">
                    {persisted === "persisted"
                      ? t("Dauerhaft gespeichert", "Stored permanently")
                      : t("Kann vom Browser bei Platzmangel gelöscht werden", "May be cleared by the browser when space runs low")}
                  </span>
                }
              >
                <StatusBadge tone={persisted === "persisted" ? "ok" : "warn"}>
                  {persisted === "persisted" ? t("Dauerhaft", "Permanent") : t("Vorläufig", "Temporary")}
                </StatusBadge>
              </SettingRow>
            )}
            <SettingRow
              label={t("Speicherbudget", "Storage budget")}
              description={withWait(
                t(
                  `Für Eintragsinhalte und Dateien auf diesem Gerät – zuerst für das, was du offline behältst. Standard hier: ${bytes(defaultBudget(platform))}. Der freie Platz des Geräts begrenzt es zusätzlich.`,
                  `For record contents and files on this device – first for what you keep offline. Default here: ${bytes(defaultBudget(platform))}. The device's free space limits it as well.`,
                ),
                true,
              )}
            >
              <Select
                className={CONTROL.sm}
                aria-label={t("Speicherbudget", "Storage budget")}
                aria-describedby={busy ? waitId : undefined}
                value={limit}
                disabled={busy}
                onChange={(e) => void budget(Number(e.currentTarget.value))}
              >
                {budgetChoices(platform).map((choice) => (
                  <option key={choice} value={choice}>
                    {bytes(choice)}
                  </option>
                ))}
              </Select>
            </SettingRow>
            <div className="offline-budget" data-testid="offline-budget">
              <UsageMeter used={Math.min(marker.budgetUsed ?? 0, limit)} limit={limit} label={t("Im Speicherbudget belegt", "Used of the storage budget")} format={bytes} />
            </div>
            <SwitchRow
              label={t(
                "Auch Eintragsinhalte und Dateien speichern",
                "Also store record contents and files",
              )}
              description={withWait(
                t(
                  `Alle, bis zum Speicherbudget (${bytes(limit)}); sonst nur, was du schon geöffnet hast oder offline behältst.`,
                  `All of them, up to the storage budget (${bytes(limit)}); otherwise only what you have opened or keep offline.`,
                ),
              )}
              checked={!!marker.includeRecords}
              disabled={busy}
              describedBy={busy ? waitId : undefined}
              onChange={(on) => void records(on)}
            />
            <SettingRow
              label={t("Offline behalten", "Keep offline")}
              description={withWait(
                t(
                  "Bereiche, Seiten mit ihren Unterseiten und Datenbanken, deren Eintragsinhalte und Dateien dieses Gerät immer speichert – auch nie geöffnete. Wähle sie unten oder im Menü „⋯“ eines Bereichs oder einer Seite.",
                  "Spaces, pages with their sub-pages and databases whose record contents and files this device always stores – even ones never opened. Choose them below or in the “⋯” menu of a space or page.",
                ),
              )}
            >
              {null}
            </SettingRow>
            {keptPages.map((item) => {
              const page = pages.find((p) => p.id === item.id);
              return (
                <SettingRow
                  key={item.id}
                  label={page ? page.title || t("Ohne Titel", "Untitled") : t("Seite nicht mehr lesbar", "Page no longer readable")}
                  description={
                    page?.kind === "database"
                      ? t("Datenbank mit allen Einträgen", "Database with every record")
                      : t("Seite mit ihren Unterseiten", "Page with its sub-pages")
                  }
                >
                  <button className="button" disabled={busy} aria-describedby={busy ? waitId : undefined} onClick={() => void keep(item, false)}>
                    {t("Nicht mehr offline behalten", "Stop keeping offline")}
                  </button>
                </SettingRow>
              );
            })}
            <div className="offline-spaces" data-testid="offline-spaces">
              <ResponsiveTable
                label={t("Speicher je Bereich", "Storage per space")}
                rows={spaceRows}
                rowKey={(row) => row.id}
                columns={[
                  { key: "name", header: t("Bereich", "Space"), primary: true, render: (row) => row.name },
                  { key: "pages", header: t("Seiten", "Pages"), align: "end", render: (row) => bytes(row.usage.pages) },
                  { key: "records", header: t("Einträge", "Records"), align: "end", render: (row) => bytes(row.usage.records) },
                  { key: "files", header: t("Dateien", "Files"), align: "end", render: (row) => bytes(row.usage.files) },
                  {
                    key: "keep",
                    header: t("Offline behalten", "Keep offline"),
                    render: (row) =>
                      row.encrypted ? (
                        <span className="offline-online-only" title={t("Verschlüsselte Bereiche bleiben nur online.", "Encrypted spaces stay online-only.")}>
                          {t("Nur online", "Online only")}
                        </span>
                      ) : (
                        <Switch
                          checked={isKept(marker.keep, { kind: "space", id: row.id })}
                          disabled={busy}
                          describedBy={busy ? waitId : undefined}
                          label={t(`${row.name} offline behalten`, `Keep ${row.name} offline`)}
                          onChange={(on) => void keep({ kind: "space", id: row.id }, on)}
                        />
                      ),
                  },
                ]}
              />
              <p className="setting-note" data-testid="offline-budget-left">
                {t(
                  `Noch frei im Speicherbudget: ${bytes(Math.max(0, limit - (marker.budgetUsed ?? 0)))} von ${bytes(limit)}`,
                  `Left in the storage budget: ${bytes(Math.max(0, limit - (marker.budgetUsed ?? 0)))} of ${bytes(limit)}`,
                )}
              </p>
            </div>
            <SettingRow
              label={t("Offline-Kopien entfernen", "Remove offline copies")}
              description={t(
                "Löscht die Kopien auf diesem Gerät. Du kannst sie jederzeit neu laden.",
                "Deletes the copies on this device. You can load them again at any time.",
              )}
            >
              <button
                className="button danger"
                disabled={busy}
                aria-describedby={busy ? waitId : undefined}
                onClick={disable}
              >
                {t("Offline-Kopien entfernen", "Remove offline copies")}
              </button>
            </SettingRow>
          </>
        ) : (
          <SettingRow
            label={t("Auf diesem Gerät", "On this device")}
            description={t(
              "Aus. Inhalte brauchen eine Verbindung.",
              "Off. Content needs a connection.",
            )}
          >
            <StatusBadge tone="off">{t("Aus", "Off")}</StatusBadge>
            <button className="button primary" disabled={busy} onClick={enable}>
              {t(
                "Auf diesem Gerät offline verfügbar machen",
                "Make available offline on this device",
              )}
            </button>
          </SettingRow>
        )}
        {supported && !enabled && (syncing || message) && <p className="setting-note">{syncStatus}</p>}
        <SettingRow
          label={t("Synchronisierung", "Sync")}
          description={t(
            "Dokumente und Whiteboards werden zusätzlich auf diesem Gerät gespeichert und nach Wiederherstellung der Verbindung zusammengeführt. Einträge in Datenbanken lassen sich offline anlegen, ändern und löschen; Konflikte kannst du danach auflösen.",
            "Documents and whiteboards are also stored on this device and merged once the connection is back. Database records can be created, changed and deleted offline; you can resolve conflicts afterwards.",
          )}
        >
          {null}
        </SettingRow>
      </SettingGroup>
      {!inApp && (
        <SettingGroup
          id="apps"
          title={t("Apps", "Apps")}
          description={t(
            "Flowplan auf weiteren Geräten – angemeldet bei derselben Instanz.",
            "Flowplan on more devices – signed in to the same instance.",
          )}
        >
          <SettingRow
            label={t("iPhone und iPad", "iPhone and iPad")}
            description={t(
              "Im App Store erhältlich – mit Widgets, Siri und Kurzbefehlen und Teilen aus jeder App.",
              "Available on the App Store – with widgets, Siri and Shortcuts and sharing from any app.",
            )}
          >
            <a
              className="button"
              href={APP_STORE_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("Im App Store laden", "Download on the App Store")}
            </a>
          </SettingRow>
          <SettingRow
            label={t("macOS, Windows und Linux", "macOS, Windows and Linux")}
            description={t(
              "Desktop-App mit Schnellerfassung von überall.",
              "Desktop app with quick capture from anywhere.",
            )}
          >
            <a
              className="button"
              href={DOWNLOAD_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("Herunterladen", "Download")}
            </a>
          </SettingRow>
          <SettingRow
            label="Android"
            description={t(
              "App direkt von flowplan.org, ohne Play Store: die Datei öffnen und installieren; neue Versionen findet die App selbst.",
              "App straight from flowplan.org, without the Play Store: open the file and install it; the app finds new versions by itself.",
            )}
          >
            <a
              className="button"
              href={ANDROID_APK_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("Herunterladen", "Download")}
            </a>
          </SettingRow>
        </SettingGroup>
      )}
    </>
  );
}
