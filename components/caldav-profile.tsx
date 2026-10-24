"use client";
// Settings → Kalender & Issues → "Kalender auf iPhone, iPad und Mac": the
// person picks calendar views and gets a configuration profile with a CalDAV
// account for each (lib/caldav-profile.ts). In the app the profile opens in
// Safari (window.FlowplanApp.openInBrowser), on Apple devices the link
// downloads it, elsewhere a QR code carries it to the phone.
import { useEffect, useMemo, useState } from "react";
import { DeviceMobile, DownloadSimple } from "@phosphor-icons/react";
import { nativeApp } from "@/lib/native-app";
import { qrModules, qrPath } from "@/lib/qr";
import { EmptyState, SettingGroup } from "./settings-ui";
import { useT } from "./i18n";
import { api } from "./ui";

type Calendar = { pageId: string; viewId: string; page: string; view: string; workspace: string; syncing: boolean };
const key = (c: Pick<Calendar, "pageId" | "viewId">) => `${c.pageId}|${c.viewId}`;
const appleDevice = () =>
  typeof navigator !== "undefined" && (/iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));
// Whether this device can take the profile directly (the app, Safari, a Mac).
export const canInstallProfile = () => !!nativeApp()?.openInBrowser || appleDevice();

// A profile link for these calendars, opened where it installs; the link
// itself when this device cannot install it (shown as QR code).
export async function installProfile(calendars: Pick<Calendar, "pageId" | "viewId">[]) {
  const { url } = await api<{ url: string }>("/api/calendar-profile", { calendars });
  const app = nativeApp();
  // Profiles install from Safari only, not from the app's web view.
  if (app?.openInBrowser) app.openInBrowser(url);
  else if (appleDevice()) location.assign(url);
  else return url;
  return null;
}

export function CalDavProfile({ onError }: { onError: (message: string) => void }) {
  const t = useT();
  const [calendars, setCalendars] = useState<Calendar[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState("");
  useEffect(() => {
    void api<{ calendars: Calendar[] }>("/api/calendar-profile")
      .then((r) => {
        setCalendars(r.calendars);
        // Calendars synced already are chosen to begin with.
        setChosen(new Set(r.calendars.filter((c) => c.syncing).map(key)));
      })
      .catch(() => setCalendars(null));
  }, []);
  const qr = useMemo(() => {
    if (!link) return null;
    try {
      const modules = qrModules(link);
      return { size: modules.length, path: qrPath(modules) };
    } catch {
      return null;
    }
  }, [link]);
  if (!calendars) return null;
  const app = nativeApp();
  const create = async () => {
    setBusy(true);
    setLink("");
    try {
      setLink((await installProfile(calendars.filter((c) => chosen.has(key(c))).map(({ pageId, viewId }) => ({ pageId, viewId })))) || "");
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const toggle = (calendar: Calendar, on: boolean) =>
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(key(calendar));
      else next.delete(key(calendar));
      return next;
    });
  return (
    <SettingGroup
      id="caldav-profile"
      title={t("Kalender auf iPhone, iPad und Mac", "Calendars on iPhone, iPad and Mac")}
      description={t(
        "Ein Konfigurationsprofil richtet die gewählten Kalenderansichten als CalDAV-Konten in Apple Kalender ein – in beide Richtungen, ohne Passwörter abzutippen. Danach in den Einstellungen unter „Profil geladen“ installieren.",
        "A configuration profile sets up the chosen calendar views as CalDAV accounts in Apple Calendar – both ways, without typing passwords. Then install it in Settings under “Profile Downloaded”.",
      )}
    >
      {!calendars.length ? (
        <div className="setting-row wide">
          <EmptyState icon={<DeviceMobile size={20} />} title={t("Keine Kalenderansicht", "No calendar view")}>
            {t("Lege in einer Datenbank eine Kalenderansicht an, um sie hier einzurichten.", "Create a calendar view in a database to set it up here.")}
          </EmptyState>
        </div>
      ) : (
        <div className="setting-row wide">
          <div className="setting-control caldav-profile">
            <fieldset>
              <legend className="sr-only">{t("Kalender", "Calendars")}</legend>
              {calendars.map((c) => (
                <label key={key(c)} className="checkbox-row">
                  <input type="checkbox" checked={chosen.has(key(c))} onChange={(e) => toggle(c, e.target.checked)} />
                  <span>
                    {c.page || t("Ohne Titel", "Untitled")} · {c.view}
                    <small className="muted"> – {c.workspace}</small>
                  </span>
                </label>
              ))}
            </fieldset>
            <button type="button" className="button primary" disabled={busy || !chosen.size} onClick={() => void create()}>
              <DownloadSimple size={15} /> {app ? t("In Apple Kalender einrichten", "Set up in Apple Calendar") : t("Profil laden", "Download profile")}
            </button>
            <p className="muted small">
              {t(
                "Jedes Profil bekommt eigene Zugänge. „Zugang beenden“ oder ein neues Passwort im Abo-Dialog eines Kalenders beendet alle Zugänge zu ihm, auch die der Profile. Android: DAVx⁵ mit den Zugangsdaten aus diesem Dialog.",
                "Each profile gets accesses of its own. “End access” or a new password in a calendar's subscribe dialog ends all accesses to it, also those of profiles. Android: DAVx⁵ with the credentials from that dialog.",
              )}
            </p>
            {link && (
              <div className="caldav-profile-link" role="status">
                {qr && (
                  <svg className="totp-qr" role="img" aria-label={t("QR-Code für das Profil", "QR code for the profile")} viewBox={`-4 -4 ${qr.size + 8} ${qr.size + 8}`} shapeRendering="crispEdges">
                    <rect x={-4} y={-4} width={qr.size + 8} height={qr.size + 8} fill="#fff" />
                    <path d={qr.path} fill="#000" />
                  </svg>
                )}
                <p className="muted small">
                  {t(
                    "Mit der Kamera des iPhones oder iPads scannen und in Safari öffnen. Der Link gilt zehn Minuten und nur einmal.",
                    "Scan with the camera of the iPhone or iPad and open it in Safari. The link works for ten minutes and only once.",
                  )}{" "}
                  <a href={link}>{t("Auf diesem Gerät laden", "Download on this device")}</a>
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </SettingGroup>
  );
}
