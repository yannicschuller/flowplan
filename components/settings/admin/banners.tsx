"use client";
// Administration → Maintenance & notices → Banners to click away
// (lib/instance-banners.ts): every banner with its state and how many
// closed it or followed its link, a form with a live preview and two
// ready-made starts (the apps, the community), and pause, show again and
// delete for banners that already went out.
import { useEffect, useRef, useState } from "react";
import { Megaphone } from "@phosphor-icons/react";
import { LOCALE_TAG } from "@/lib/locale-tag";
import type { AdminBanner, Banner } from "@/lib/instance-banners";
import { useT } from "../../i18n";
import { api } from "../../ui";
import { Select } from "../../select";
import { EmptyState, SaveState, SettingGroup, SettingRow, StatusBadge, useSaveState } from "../../settings-ui";
import { InstanceBanners } from "../../instance-banners";

type Draft = {
  id?: string;
  title: string;
  message: string;
  linkUrl: string;
  linkLabel: string;
  tone: Banner["tone"];
  audience: Banner["audience"];
  surface: Banner["surface"];
  start: string;
  end: string;
  paused: boolean;
};
const EMPTY: Draft = { title: "", message: "", linkUrl: "", linkLabel: "", tone: "info", audience: "all", surface: "everywhere", start: "", end: "", paused: false };
// "2026-10-22T14:30" for datetime-local fields, in local time.
const localInput = (ms: number | null) => (ms ? new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : "");
const fromInput = (value: string) => (value ? new Date(value).getTime() : null);
const when = (ms: number) => new Date(ms).toLocaleString(LOCALE_TAG, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

export function BannersSection() {
  const t = useT();
  const [banners, setBanners] = useState<AdminBanner[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const [status, run] = useSaveState();
  const act = async (body: Record<string, unknown>) => {
    setError("");
    try {
      const answer = await api<{ banners: AdminBanner[] }>("/api/admin/operations", body);
      setBanners(answer.banners);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };
  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    void act({ action: "banners.list" });
  }, []);
  const presets: { label: string; draft: Draft }[] = [
    {
      label: t("Vorlage: Apps", "Template: apps"),
      draft: {
        ...EMPTY,
        tone: "promo",
        surface: "browser",
        title: t("Flowplan als App", "Flowplan as an app"),
        message: t("Für iPhone, iPad, Android und den Computer – mit Widgets, Mitteilungen und Schnellerfassung.", "For iPhone, iPad, Android and your computer – with widgets, notifications and quick capture."),
        linkUrl: "https://flowplan.org/download",
        linkLabel: t("Apps ansehen", "See the apps"),
      },
    },
    {
      label: t("Vorlage: Discord", "Template: Discord"),
      draft: {
        ...EMPTY,
        tone: "promo",
        title: t("Komm in die Community", "Join the community"),
        message: t("Fragen, Ideen und Neuigkeiten rund um Flowplan auf unserem Discord-Server.", "Questions, ideas and news about Flowplan on our Discord server."),
        linkUrl: "https://discord.gg/bCEdB6MPrR",
        linkLabel: t("Zum Discord", "Open Discord"),
      },
    },
  ];
  const stateBadge = (b: AdminBanner) =>
    b.state === "active" ? (
      <StatusBadge tone="ok">{t("Wird angezeigt", "Shown")}</StatusBadge>
    ) : b.state === "planned" ? (
      <StatusBadge tone="info">{t("Geplant", "Planned")}</StatusBadge>
    ) : b.state === "paused" ? (
      <StatusBadge tone="off">{t("Pausiert", "Paused")}</StatusBadge>
    ) : (
      <StatusBadge tone="off">{t("Beendet", "Ended")}</StatusBadge>
    );
  const save = (d: Draft) =>
    run(async () => {
      const ok = await act({
        action: "banners.save",
        banner: {
          id: d.id,
          title: d.title,
          message: d.message,
          linkUrl: d.linkUrl,
          linkLabel: d.linkLabel,
          tone: d.tone,
          audience: d.audience,
          surface: d.surface,
          startsAt: fromInput(d.start),
          endsAt: fromInput(d.end),
          paused: d.paused,
        },
      });
      if (ok) setDraft(null);
      return ok;
    });
  return (
    <SettingGroup
      id="banners"
      title={t("Banner zum Wegklicken", "Banners to click away")}
      description={t(
        "Jede Person sieht den Banner beim nächsten Öffnen von Flowplan, bis sie ihn schließt oder dem Link folgt – danach nie wieder, auf keinem Gerät. Gut für Neuigkeiten wie die Apps oder eine Community.",
        "Everyone sees the banner the next time they open Flowplan until they close it or follow its link – then never again, on no device. Good for news like the apps or a community.",
      )}
      actions={
        !draft && (
          <button type="button" className="button" onClick={() => setDraft({ ...EMPTY })}>
            {t("Neuer Banner", "New banner")}
          </button>
        )
      }
    >
      {error && (
        <p className="admin-banner-error" role="alert">
          {error}
        </p>
      )}
      {draft ? (
        <form
          className="admin-banner-form"
          aria-label={t("Banner bearbeiten", "Edit banner")}
          onSubmit={(e) => {
            e.preventDefault();
            void save(draft);
          }}
        >
          {!draft.id && (
            <div className="setting-row wide admin-banner-presets">
              {presets.map((p) => (
                <button key={p.label} type="button" className="chip" onClick={() => setDraft({ ...p.draft })}>
                  {p.label}
                </button>
              ))}
            </div>
          )}
          <SettingRow id="banner-title" label={t("Überschrift", "Heading")} description={t("Optional, fett vor dem Text.", "Optional, bold before the text.")}>
            <input id="banner-title" className="control-lg" maxLength={80} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          </SettingRow>
          <SettingRow id="banner-text" label={t("Text", "Text")} description={t("Höchstens 300 Zeichen.", "At most 300 characters.")}>
            <textarea id="banner-text" className="control-lg" required rows={2} maxLength={300} value={draft.message} onChange={(e) => setDraft({ ...draft, message: e.target.value })} />
          </SettingRow>
          <SettingRow id="banner-link" label={t("Link", "Link")} description={t("Optional: https://… oder eine Seite dieser Instanz (#… oder /…).", "Optional: https://… or a page of this instance (#… or /…).")}>
            <input id="banner-link" className="control-lg" inputMode="url" maxLength={500} placeholder="https://" value={draft.linkUrl} onChange={(e) => setDraft({ ...draft, linkUrl: e.target.value })} />
          </SettingRow>
          {draft.linkUrl.trim() && (
            <SettingRow id="banner-link-label" label={t("Beschriftung des Links", "Link label")} description={t("Leer = „Mehr erfahren“.", "Empty = “Learn more”.")}>
              <input id="banner-link-label" className="control-md" maxLength={40} value={draft.linkLabel} onChange={(e) => setDraft({ ...draft, linkLabel: e.target.value })} />
            </SettingRow>
          )}
          <SettingRow id="banner-tone" label={t("Farbe", "Colour")}>
            <Select id="banner-tone" value={draft.tone} onChange={(e) => setDraft({ ...draft, tone: e.target.value as Draft["tone"] })}>
              <option value="info">{t("Hinweis (blau)", "Notice (blue)")}</option>
              <option value="promo">{t("Werbung (Akzent)", "Promotion (accent)")}</option>
              <option value="success">{t("Neuigkeit (grün)", "News (green)")}</option>
              <option value="warning">{t("Wichtig (gelb)", "Important (yellow)")}</option>
            </Select>
          </SettingRow>
          <SettingRow id="banner-audience" label={t("Wer sieht ihn", "Who sees it")}>
            <Select id="banner-audience" value={draft.audience} onChange={(e) => setDraft({ ...draft, audience: e.target.value as Draft["audience"] })}>
              <option value="all">{t("Alle Personen", "Everyone")}</option>
              <option value="admins">{t("Nur Administratoren", "Administrators only")}</option>
            </Select>
          </SettingRow>
          <SettingRow id="banner-surface" label={t("Wo", "Where")} description={t("„Nur im Browser“ zeigt ihn nicht in der Desktop-App und den Apps – etwa für Werbung für die Apps.", "“Browser only” keeps it out of the desktop app and the apps – e.g. for promoting the apps.")}>
            <Select id="banner-surface" value={draft.surface} onChange={(e) => setDraft({ ...draft, surface: e.target.value as Draft["surface"] })}>
              <option value="everywhere">{t("Überall", "Everywhere")}</option>
              <option value="browser">{t("Nur im Browser", "Browser only")}</option>
            </Select>
          </SettingRow>
          <SettingRow id="banner-start" label={t("Ab", "From")} description={t("Optional, in deiner Zeitzone. Leer = sofort.", "Optional, in your time zone. Empty = right away.")}>
            <input id="banner-start" className="control-md" type="datetime-local" value={draft.start} onChange={(e) => setDraft({ ...draft, start: e.target.value })} />
          </SettingRow>
          <SettingRow id="banner-end" label={t("Bis", "Until")} description={t("Optional. Leer = bis du ihn beendest.", "Optional. Empty = until you end it.")}>
            <input id="banner-end" className="control-md" type="datetime-local" min={draft.start || undefined} value={draft.end} onChange={(e) => setDraft({ ...draft, end: e.target.value })} />
          </SettingRow>
          <div className="setting-row wide admin-banner-preview">
            <span className="muted small">{t("Vorschau", "Preview")}</span>
            <InstanceBanners
              key={JSON.stringify(draft)}
              preview
              initial={[
                {
                  id: "preview",
                  title: draft.title.trim(),
                  message: draft.message.trim() || t("Dein Text", "Your text"),
                  linkUrl: draft.linkUrl.trim() || null,
                  linkLabel: draft.linkLabel.trim() || null,
                  tone: draft.tone,
                  audience: draft.audience,
                  surface: "everywhere",
                  startsAt: null,
                  endsAt: null,
                },
              ]}
            />
          </div>
          <div className="setting-row admin-form-actions">
            <SaveState status={status} />
            <button type="button" className="button" onClick={() => setDraft(null)}>
              {t("Abbrechen", "Cancel")}
            </button>
            <button className="button primary" disabled={status.state === "saving"}>
              {draft.id ? t("Speichern", "Save") : t("Banner veröffentlichen", "Publish banner")}
            </button>
          </div>
        </form>
      ) : banners === null ? null : banners.length === 0 ? (
        <div className="setting-row wide">
          <EmptyState icon={<Megaphone size={18} />} title={t("Noch keine Banner", "No banners yet")}>
            {t("Etwa für die Apps oder euren Discord-Server – mit „Neuer Banner“ oder einer Vorlage.", "For instance for the apps or your Discord server – with “New banner” or a template.")}
          </EmptyState>
        </div>
      ) : (
        <ul className="admin-banner-list">
          {banners.map((b) => (
            <li key={b.id}>
              <div className="admin-banner-head">
                <span className="admin-banner-text">
                  {b.title && <strong>{b.title}</strong>} {b.message}
                </span>
                {stateBadge(b)}
              </div>
              <small className="muted">
                {t(`${b.closed} von ${b.reach} weggeklickt`, `${b.closed} of ${b.reach} closed`)}
                {b.linkUrl && ` · ${t(`${b.clicked} dem Link gefolgt`, `${b.clicked} followed the link`)}`}
                {b.audience === "admins" && ` · ${t("nur Admins", "admins only")}`}
                {b.surface === "browser" && ` · ${t("nur im Browser", "browser only")}`}
                {b.startsAt && ` · ${t("ab", "from")} ${when(b.startsAt)}`}
                {b.endsAt && ` · ${t("bis", "until")} ${when(b.endsAt)}`}
              </small>
              <div className="admin-banner-actions">
                <button
                  type="button"
                  className="text-button"
                  onClick={() =>
                    setDraft({
                      id: b.id,
                      title: b.title,
                      message: b.message,
                      linkUrl: b.linkUrl || "",
                      linkLabel: b.linkLabel || "",
                      tone: b.tone,
                      audience: b.audience,
                      surface: b.surface,
                      start: localInput(b.startsAt),
                      end: localInput(b.endsAt),
                      paused: b.paused,
                    })
                  }
                >
                  {t("Bearbeiten", "Edit")}
                </button>
                {b.state !== "ended" && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      void act({
                        action: "banners.save",
                        banner: { id: b.id, title: b.title, message: b.message, linkUrl: b.linkUrl || "", linkLabel: b.linkLabel || "", tone: b.tone, audience: b.audience, surface: b.surface, startsAt: b.startsAt, endsAt: b.endsAt, paused: !b.paused },
                      })
                    }
                  >
                    {b.paused ? t("Fortsetzen", "Resume") : t("Pausieren", "Pause")}
                  </button>
                )}
                {b.closed > 0 && (
                  <button
                    type="button"
                    className="text-button"
                    title={t("Auch wer ihn schon geschlossen hat, sieht ihn wieder.", "Also those who closed it see it again.")}
                    onClick={() => {
                      if (confirm(t(`Allen wieder anzeigen? ${b.closed} Personen haben ihn geschlossen; sie sehen ihn beim nächsten Öffnen wieder.`, `Show to everyone again? ${b.closed} people closed it; they see it again the next time they open Flowplan.`)))
                        void act({ action: "banners.reset", id: b.id });
                    }}
                  >
                    {t("Wieder anzeigen", "Show again")}
                  </button>
                )}
                <button
                  type="button"
                  className="text-button admin-banner-delete"
                  onClick={() => {
                    if (confirm(t("Banner löschen? Er verschwindet sofort für alle; die Zahlen dazu gehen mit.", "Delete the banner? It disappears for everyone right away; its numbers go with it.")))
                      void act({ action: "banners.delete", id: b.id });
                  }}
                >
                  {t("Löschen", "Delete")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </SettingGroup>
  );
}
