"use client";
// PROTOTYPE – graphical parts of the settings (lib/settings-variant.ts):
// a live preview of a page in Darstellung & Sprache, rings and a trend in
// Speicher & KI, a preview of a notification per channel, the instance's
// features as tiles. No style attributes (CSP): sizes come from SVG
// attributes and <progress>, colours from the chart tokens.
import { useState } from "react";
import {
  Bell,
  BookOpen,
  CalendarDots,
  Cards,
  ChalkboardSimple,
  ChartBar,
  ChatCircleDots,
  CheckSquare,
  ClipboardText,
  DeviceMobile,
  EnvelopeSimple,
  FlowArrow,
  Notebook,
  SquaresFour,
  Sparkle,
  TreeStructure,
  UsersFour,
  type Icon,
} from "@phosphor-icons/react";
import type { FeatureModule } from "@/lib/feature-modules";
import { FEATURE_MODULES } from "@/lib/feature-modules";
import { usePageIconPref } from "@/lib/page-icon-pref-client";
import { useFullWidthPages } from "@/lib/page-width-pref-client";
import { useStrikeDoneTasks } from "@/lib/done-strike-pref-client";
import { personalFontOf } from "@/lib/personal-font";
import { bundledFont, SYSTEM_FONT } from "@/lib/theme-fonts";
import { aiSummary, storageSummary } from "@/lib/limits-summary";
import { LOCALE_TAG } from "@/lib/locale-tag";
import type { QuotaStatus } from "@/lib/ai/quota-shared";
import { useT } from "../i18n";
import { Sparkline } from "../sparkline";
import { SettingGroup } from "../settings-ui";
import { useUserSettings } from "./user-context";
import { moduleTexts } from "./user/feature-modules";

// A ring of a share (0–1); null: no limit (a full, quiet ring).
export function Ring({ share, center, label, size = 92, tone = 1 }: { share: number | null; center: string; label: string; size?: number; tone?: 1 | 2 | 3 }) {
  const r = size / 2 - 8;
  const c = 2 * Math.PI * r;
  const value = share === null ? 0 : Math.max(0.015, Math.min(1, share));
  const level = share !== null && share >= 0.95 ? " full" : share !== null && share >= 0.8 ? " high" : "";
  return (
    <svg className={`sv-ring tone-${tone}${level}`} width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${label}: ${center}`}>
      <circle cx={size / 2} cy={size / 2} r={r} className={`sv-ring-track${share === null ? " unlimited" : ""}`} strokeWidth={10} fill="none" strokeDasharray={share === null ? "3 5" : undefined} />
      {share !== null && (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          className="sv-ring-value"
          strokeWidth={10}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${value * c} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      )}
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" className="sv-ring-text">
        {center}
      </text>
    </svg>
  );
}

// ------------------------------------------------ Darstellung & Sprache

export function AppearancePreview() {
  const t = useT();
  const { boot, theme } = useUserSettings();
  const pageIcon = usePageIconPref();
  const fullWidth = useFullWidthPages();
  const strike = useStrikeDoneTasks();
  const font = personalFontOf(boot.uiFont);
  const fontName = !font ? t("Standard", "Default") : font === SYSTEM_FONT ? t("Systemschrift", "System font") : (bundledFont(font)?.name ?? font);
  const themeName = theme === "dark" ? t("Dunkel", "Dark") : theme === "light" ? t("Hell", "Light") : t("Automatisch", "Automatic");
  return (
    <section className="sv-preview" aria-label={t("Vorschau", "Preview")} data-icon={pageIcon} data-full={fullWidth ? "true" : "false"} data-strike={strike ? "true" : "false"}>
      <div className="sv-preview-head">
        <strong>{t("Vorschau", "Preview")}</strong>
        <span className="sv-live">{t("Live", "Live")}</span>
      </div>
      <div className="sv-preview-window" aria-hidden>
        <div className="sv-preview-bar">
          <i />
          <i />
          <i />
        </div>
        <div className="sv-preview-page">
          <div className="sv-preview-title">
            <span className="sv-preview-icon">🚀</span>
            <span>{t("Projekt Apollo", "Project Apollo")}</span>
          </div>
          <p>
            {t("Ziele für das Quartal und was als Nächstes ansteht. ", "Goals for the quarter and what comes next. ")}
            <a>{t("Kickoff-Notizen", "Kickoff notes")}</a>
          </p>
          <ul>
            <li className="done">
              <CheckSquare size={15} weight="fill" /> {t("Zeitplan abstimmen", "Agree on the schedule")}
            </li>
            <li className="done">
              <CheckSquare size={15} weight="fill" /> {t("Team einladen", "Invite the team")}
            </li>
            <li>
              <span className="sv-preview-box" /> {t("Erste Version testen", "Test the first version")}
            </li>
          </ul>
        </div>
      </div>
      <ul className="sv-preview-facts">
        <li>{themeName}</li>
        <li>{t(`Schrift: ${fontName}`, `Font: ${fontName}`)}</li>
        <li>{pageIcon === "inline" ? t("Symbol neben dem Titel", "Icon next to the title") : t("Symbol über dem Titel", "Icon above the title")}</li>
        <li>{fullWidth ? t("Volle Breite", "Full width") : t("Normale Breite", "Normal width")}</li>
        <li>{strike ? t("Erledigtes durchgestrichen", "Done struck through") : t("Erledigtes nicht durchgestrichen", "Done not struck through")}</li>
        <li>{boot.plainLook ? t("Flowplans Akzent", "Flowplan's accent") : t("Akzent des Arbeitsbereichs", "Workspace accent")}</li>
      </ul>
    </section>
  );
}

// ------------------------------------------------------------ Speicher & KI

// The trend of the last 14 days. PROTOTYPE: there is no history of a
// person's storage yet – example values, marked as such.
const EXAMPLE_TREND = [0.62, 0.63, 0.63, 0.66, 0.66, 0.7, 0.71, 0.71, 0.74, 0.78, 0.79, 0.8, 0.83, 0.86];

export function UsageOverview({ quota }: { quota: QuotaStatus | null }) {
  const t = useT();
  const { boot } = useUserSettings();
  const limits = boot.myLimits;
  const storage = limits ? storageSummary(limits, t, LOCALE_TAG) : null;
  const ai = aiSummary(boot.ai, quota, t, LOCALE_TAG);
  const used = limits ? limits.usedBytes : 0;
  const trend = EXAMPLE_TREND.map((f) => f * Math.max(used, 1));
  return (
    <SettingGroup id="usage-overview" title={t("Auf einen Blick", "At a glance")}>
      <div className="sv-usage">
        {storage && (
          <div className="sv-usage-item">
            <Ring share={storage.share} center={storage.share === null ? "∞" : `${Math.round(storage.share * 100)} %`} label={t("Speicher", "Storage")} />
            <div>
              <strong>{t("Speicher", "Storage")}</strong>
              <span>{storage.text}</span>
            </div>
          </div>
        )}
        <div className="sv-usage-item">
          <Ring share={ai.share} tone={2} center={ai.share === null ? (ai.state === "off" ? "–" : "∞") : `${Math.round(ai.share * 100)} %`} label={t("KI-Kontingent", "AI quota")} />
          <div>
            <strong>{t("KI-Kontingent", "AI quota")}</strong>
            <span>{ai.text || t("keine KI auf dieser Instanz", "no AI on this instance")}</span>
          </div>
        </div>
        <div className="sv-usage-item trend">
          <div>
            <strong>{t("Speicher, letzte 14 Tage", "Storage, last 14 days")}</strong>
            <span className="sv-example">{t("Beispieldaten", "Example data")}</span>
          </div>
          <Sparkline values={trend} label={t("Speicher der letzten 14 Tage", "Storage of the last 14 days")} tone={1} height={44} />
        </div>
      </div>
    </SettingGroup>
  );
}

// ------------------------------------------------------- Benachrichtigungen

type Channel = "inbox" | "push" | "email" | "messenger";

export function NotificationPreview() {
  const t = useT();
  const { boot } = useUserSettings();
  const [channel, setChannel] = useState<Channel>("push");
  const on = boot.notificationPrefs?.mention?.[channel] ?? true;
  const channels: { id: Channel; label: string; Icon: Icon }[] = [
    { id: "inbox", label: t("In der App", "In the app"), Icon: Bell },
    { id: "push", label: t("Push", "Push"), Icon: DeviceMobile },
    { id: "email", label: t("E-Mail", "E-mail"), Icon: EnvelopeSimple },
    { id: "messenger", label: t("Chat-App", "Chat app"), Icon: ChatCircleDots },
  ];
  const who = "Anna";
  const page = t("Q3-Planung", "Q3 planning");
  const text = t(`${who} hat dich in „${page}“ erwähnt: „Kannst du bis Freitag drüberschauen?“`, `${who} mentioned you in “${page}”: “Could you take a look by Friday?”`);
  return (
    <section className="sv-preview sv-notify" aria-label={t("Vorschau einer Benachrichtigung", "Preview of a notification")}>
      <div className="sv-preview-head">
        <strong>{t("So sieht eine Erwähnung aus", "What a mention looks like")}</strong>
        <span className={`sv-state ${on ? "on" : "off"}`}>{on ? t("an", "on") : t("aus", "off")}</span>
      </div>
      <div className="sv-scope small" role="tablist" aria-label={t("Kanal", "Channel")}>
        {channels.map((c) => (
          <button key={c.id} type="button" role="tab" aria-selected={channel === c.id} onClick={() => setChannel(c.id)}>
            <c.Icon size={14} aria-hidden /> {c.label}
          </button>
        ))}
      </div>
      <div className={`sv-notify-stage ${channel}${on ? "" : " muted"}`} aria-hidden>
        {channel === "push" && (
          <div className="sv-notify-phone">
            <div className="sv-notify-card">
              <span className="sv-notify-app">F</span>
              <div>
                <strong>Flowplan</strong>
                <span>{text}</span>
              </div>
              <small>{t("jetzt", "now")}</small>
            </div>
          </div>
        )}
        {channel === "inbox" && (
          <div className="sv-notify-inbox">
            <span className="sv-notify-avatar">A</span>
            <div>
              <span>{text}</span>
              <small>{t("vor 1 Min. · Posteingang", "1 min ago · Inbox")}</small>
            </div>
            <i className="sv-notify-dot" />
          </div>
        )}
        {channel === "email" && (
          <div className="sv-notify-mail">
            <div className="sv-notify-mail-head">
              <strong>{t(`${who} hat dich erwähnt`, `${who} mentioned you`)}</strong>
              <small>Flowplan · {t("an dich", "to you")}</small>
            </div>
            <p>{text}</p>
            <span className="sv-notify-button">{t("Seite öffnen", "Open page")}</span>
          </div>
        )}
        {channel === "messenger" && (
          <div className="sv-notify-chat">
            <span className="sv-notify-app">F</span>
            <div>
              <strong>Flowplan Bot</strong>
              <span>{text}</span>
            </div>
          </div>
        )}
        {!on && <p className="sv-notify-off">{t("Auf diesem Kanal bekommst du keine Erwähnungen.", "You get no mentions on this channel.")}</p>}
      </div>
      <p className="sv-preview-note">{t("Beispiel – an/aus gilt für deine Einstellung „Erwähnungen“.", "Example – on/off follows your “Mentions” setting.")}</p>
    </section>
  );
}

// ------------------------------------------------- Instanz → Funktionen

const MODULE_ICONS: Record<FeatureModule, Icon> = {
  flashcards: Cards,
  whiteboards: ChalkboardSimple,
  notebooks: Notebook,
  journal: BookOpen,
  dashboards: SquaresFour,
  workflows: FlowArrow,
  drawio: TreeStructure,
  ai: Sparkle,
  views: CalendarDots,
  forms: ClipboardText,
  meetings: UsersFour,
};

// The instance's features as tiles that switch on and off, and what
// disappears for everyone: a "Neue Seite" menu with the switched-off kinds
// struck out.
export function FeatureTiles({ off, disabled, onToggle }: { off: readonly FeatureModule[]; disabled?: boolean; onToggle: (module: FeatureModule, on: boolean) => void }) {
  const t = useT();
  const texts = moduleTexts(t);
  const gone = FEATURE_MODULES.filter((m) => off.includes(m));
  const menu: { label: string; module?: FeatureModule; Icon: Icon }[] = [
    { label: t("Dokument", "Document"), Icon: ClipboardText },
    { label: t("Datenbank", "Database"), Icon: ChartBar },
    { label: texts.whiteboards.label, module: "whiteboards", Icon: ChalkboardSimple },
    { label: texts.notebooks.label, module: "notebooks", Icon: Notebook },
    { label: texts.journal.label, module: "journal", Icon: BookOpen },
    { label: texts.dashboards.label, module: "dashboards", Icon: SquaresFour },
    { label: texts.flashcards.label, module: "flashcards", Icon: Cards },
    { label: t("Mit KI erstellen", "Create with AI"), module: "ai", Icon: Sparkle },
  ];
  return (
    <div className="sv-features">
      <ul className="sv-feature-tiles">
        {FEATURE_MODULES.map((m) => {
          const Icon = MODULE_ICONS[m];
          const isOn = !off.includes(m);
          return (
            <li key={m}>
              <button type="button" className="sv-feature" aria-pressed={isOn} disabled={disabled} onClick={() => onToggle(m, !isOn)} title={texts[m].description}>
                <span className="sv-feature-icon" aria-hidden>
                  <Icon size={22} />
                </span>
                <span className="sv-feature-label">{texts[m].label}</span>
                <span className={`sv-state ${isOn ? "on" : "off"}`}>{isOn ? t("an", "on") : t("aus", "off")}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="sv-features-preview" aria-label={t("Was Personen sehen", "What people see")}>
        <strong>{t("„Neue Seite“ für alle", "“New page” for everyone")}</strong>
        <ul>
          {menu.map((item) => {
            const hidden = !!item.module && off.includes(item.module);
            return (
              <li key={item.label} className={hidden ? "gone" : undefined}>
                <item.Icon size={15} aria-hidden /> {item.label}
              </li>
            );
          })}
        </ul>
        <p>
          {gone.length
            ? t(`Verschwindet für alle: ${gone.map((m) => texts[m].label).join(", ")}.`, `Disappears for everyone: ${gone.map((m) => texts[m].label).join(", ")}.`)
            : t("Alles eingeschaltet – niemand vermisst etwas.", "Everything on – nobody misses anything.")}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------- Administration → Speicher

const sizeText = (bytes: number) => {
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toLocaleString(LOCALE_TAG, { maximumFractionDigits: 1 })} GB` : `${mb.toLocaleString(LOCALE_TAG, { maximumFractionDigits: mb < 10 ? 1 : 0 })} MB`;
};

// What the instance stores: database and files as one stacked bar, and the
// accounts with the most files as bars (live, /api/admin).
export function InstanceStorageChart({ databaseBytes, uploadBytes, accounts }: { databaseBytes: number; uploadBytes: number; accounts: { name: string; bytes: number }[] }) {
  const t = useT();
  const total = databaseBytes + uploadBytes || 1;
  const db = (databaseBytes / total) * 100;
  const top = [...accounts].sort((a, b) => b.bytes - a.bytes).slice(0, 5);
  const max = Math.max(1, ...top.map((a) => a.bytes));
  return (
    <SettingGroup id="storage-chart" title={t("Belegung", "Usage")} description={t(`Zusammen ${sizeText(databaseBytes + uploadBytes)} – live aus der Instanz.`, `${sizeText(databaseBytes + uploadBytes)} in total – live from the instance.`)}>
      <div className="sv-stack">
        <svg viewBox="0 0 100 10" preserveAspectRatio="none" role="img" aria-label={t(`Datenbank ${sizeText(databaseBytes)}, Dateien ${sizeText(uploadBytes)}`, `Database ${sizeText(databaseBytes)}, files ${sizeText(uploadBytes)}`)}>
          <rect x={0} y={0} width={db} height={10} className="sv-stack-a" />
          <rect x={db} y={0} width={100 - db} height={10} className="sv-stack-b" />
        </svg>
        <ul className="sv-legend">
          <li>
            <i className="a" /> {t("Datenbank", "Database")} <strong>{sizeText(databaseBytes)}</strong>
          </li>
          <li>
            <i className="b" /> {t("Dateien", "Files")} <strong>{sizeText(uploadBytes)}</strong>
          </li>
        </ul>
      </div>
      {top.length > 0 && (
        <div className="sv-hbars">
          <strong>{t("Die meisten Dateien", "Most files")}</strong>
          {top.map((a) => (
            <div key={a.name} className="sv-hbar">
              <span>{a.name}</span>
              <progress max={1000} value={Math.round((a.bytes / max) * 1000)} aria-label={`${a.name}: ${sizeText(a.bytes)}`} />
              <strong>{sizeText(a.bytes)}</strong>
            </div>
          ))}
        </div>
      )}
    </SettingGroup>
  );
}
