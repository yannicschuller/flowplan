"use client";
// Settings → Arbeitsbereich → Erscheinungsbild (#196): the workspace's
// accent colour, background tint and typefaces, with a preview in light and
// dark, and the faces its owners uploaded. Owners change it; everyone sees
// it (each person may choose Flowplan's own look in Darstellung & Sprache).
// No custom CSS: lib/workspace-theme.ts says why.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ArrowCounterClockwise, Check, Info, Palette, TextAa, Trash, UploadSimple } from "@phosphor-icons/react";
import { useT } from "../../i18n";
import { Select } from "../../select";
import { CONTROL, EmptyState, SaveBar, SettingGroup, SettingRow } from "../../settings-ui";
import { ColorPicker } from "../../ink/color-picker";
import { api } from "../../ui";
import { idempotencyHeaders } from "@/lib/idempotency-key";
import {
  BACKGROUND_PRESETS,
  appFontUrl,
  backgroundPreset,
  derivePalette,
  fontFaceRule,
  normalizeTheme,
  themeVariables,
  type BackgroundId,
  type Mode,
  type ThemeFont,
  type WorkspaceLook,
  type WorkspaceTheme,
} from "@/lib/workspace-theme";
import { BUNDLED_FONTS, CUSTOM_PREFIX, DEFAULT_FONTS, FONT_SLOTS, SYSTEM_FONT, bundledFont, bundledFontFaces, fontStack, type FontCategory, type FontSlot } from "@/lib/theme-fonts";
import { useUserSettings } from "../user-context";

// A few accents to start from; any other colour through the picker.
const SWATCHES = ["#3b3fd8", "#2563eb", "#0e7490", "#0f766e", "#15803d", "#a16207", "#c2410c", "#be123c", "#be185d", "#7c3aed", "#475569"];
// Flowplan's own colours (app/globals.css), for the preview of the default.
const DEFAULT_COLOURS: Record<Mode, { text: string; muted: string; blue: string; blueLight: string; onAccent: string }> = {
  light: { text: "#1d1c22", muted: "#6f6b78", blue: "#3b3fd8", blueLight: "#ecebfc", onAccent: "#ffffff" },
  dark: { text: "#ecebf1", muted: "#8e8a98", blue: "#959bff", blueLight: "#2a2a55", onAccent: "#121117" },
};

const sameTheme = (a: WorkspaceTheme | null, b: WorkspaceTheme | null) => JSON.stringify(normalizeTheme(a ?? {})) === JSON.stringify(normalizeTheme(b ?? {}));

export default function WorkspaceLookSection() {
  const t = useT();
  const { boot, owner, mutate, onError } = useUserSettings();
  const workspaceId = boot.workspace.id;
  const [look, setLook] = useState<WorkspaceLook>(boot.look ?? { theme: null, fonts: [] });
  const [draft, setDraft] = useState<WorkspaceTheme>(boot.look?.theme ?? {});
  const [busy, setBusy] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  // The app's callbacks may change identity on every render.
  const errorRef = useRef(onError);
  errorRef.current = onError;
  // Every uploaded face (the bootstrap has only those in use).
  useEffect(() => {
    let live = true;
    api<WorkspaceLook>("/api/command", { action: "workspace.look", workspaceId })
      .then((result) => {
        if (!live) return;
        setLook(result);
        setDraft(result.theme ?? {});
      })
      .catch((e) => errorRef.current((e as Error).message));
    return () => {
      live = false;
    };
  }, [workspaceId]);
  const dirty = !sameTheme(draft, look.theme);
  const save = async () => {
    setBusy(true);
    try {
      const result = (await mutate({ action: "workspace.theme", workspaceId, theme: normalizeTheme(draft) })) as WorkspaceLook;
      setLook(result);
      setDraft(result.theme ?? {});
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const setFont = (slot: FontSlot, value: string) => setDraft((d) => ({ ...d, fonts: { ...d.fonts, [slot]: value || undefined } }));
  const accent = draft.accent ?? null;
  const palettes = useMemo(
    () => (accent ? { light: derivePalette(accent, "light", draft.background), dark: derivePalette(accent, "dark", draft.background) } : null),
    [accent, draft.background],
  );
  // The faces the choices are shown in: downloaded only when shown.
  const faces = useMemo(
    () =>
      [
        ...BUNDLED_FONTS.map((f) => bundledFontFaces(f.id)).filter(Boolean),
        ...look.fonts.map((f) => fontFaceRule(f, appFontUrl(f.id))),
      ].join("\n"),
    [look.fonts],
  );
  const isDefault = !normalizeTheme(draft);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (owner && dirty) void save();
      }}
    >
      <style dangerouslySetInnerHTML={{ __html: faces }} />
      <SettingGroup
        id="look-colours"
        title={t("Erscheinungsbild des Arbeitsbereichs", "Workspace appearance")}
        description={
          owner
            ? t(
                "Gilt für alle in diesem Arbeitsbereich, für seine veröffentlichten Seiten und Formulare. Hell oder dunkel wählt jede Person selbst, und jede kann für sich Flowplans eigene Darstellung wählen.",
                "Applies to everyone in this workspace and to its published pages and forms. Light or dark stays each person's choice, and anyone can choose Flowplan's own look for themselves.",
              )
            : t("Nur Eigentümer ändern das Erscheinungsbild. Für dich selbst kannst du unter Darstellung & Sprache Flowplans eigene Darstellung wählen.", "Only owners change the appearance. For yourself, you can choose Flowplan's own look under Appearance & language.")
        }
        actions={
          owner && (
            <button type="button" className="button compact" disabled={isDefault || busy} onClick={() => setDraft({})}>
              <ArrowCounterClockwise aria-hidden /> {t("Auf Standard zurücksetzen", "Reset to default")}
            </button>
          )
        }
      >
        <div className="look-preview-row">
          <LookPreview theme={draft} fonts={look.fonts} mode="light" label={t("Hell", "Light")} />
          <LookPreview theme={draft} fonts={look.fonts} mode="dark" label={t("Dunkel", "Dark")} />
        </div>
        <SettingRow label={t("Akzentfarbe", "Accent colour")} description={t("Für Links, Schaltflächen, Auswahl und Markierungen.", "For links, buttons, selections and highlights.")} wide>
          <div className="look-accent">
            <div className="look-swatches" role="radiogroup" aria-label={t("Akzentfarbe", "Accent colour")}>
              <button
                type="button"
                role="radio"
                aria-checked={!accent}
                className={`look-swatch look-swatch-default${!accent ? " active" : ""}`}
                disabled={!owner}
                title={t("Standard", "Default")}
                onClick={() => setDraft((d) => ({ ...d, accent: null }))}
              >
                <span className="sr-only">{t("Standard", "Default")}</span>
              </button>
              {SWATCHES.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={accent === c}
                  aria-label={c}
                  title={c}
                  className={`look-swatch${accent === c ? " active" : ""}`}
                  style={{ "--swatch": c } as CSSProperties}
                  disabled={!owner}
                  onClick={() => setDraft((d) => ({ ...d, accent: c }))}
                >
                  {accent === c && <Check size={14} weight="bold" aria-hidden />}
                </button>
              ))}
              <button
                type="button"
                className={`button compact look-custom${accent && !SWATCHES.includes(accent) ? " active" : ""}`}
                aria-expanded={customOpen}
                disabled={!owner}
                onClick={() => setCustomOpen((v) => !v)}
              >
                <Palette aria-hidden />
                {accent && !SWATCHES.includes(accent) ? <code>{accent}</code> : t("Eigene Farbe", "Own colour")}
              </button>
            </div>
            {customOpen && owner && (
              <div className="look-picker">
                <ColorPicker value={accent ?? "#3b3fd8"} onChange={(c) => setDraft((d) => ({ ...d, accent: c }))} />
              </div>
            )}
            {palettes && (palettes.light.adjusted || palettes.dark.adjusted) && (
              <p className="look-adjusted" role="status">
                <Info size={16} aria-hidden />
                <span>
                  {t(
                    "Für die Lesbarkeit angepasst, damit Text auf der Farbe und die Farbe als Text mindestens 4,5 : 1 Kontrast haben. Flowplan verwendet:",
                    "Adjusted for readability, so that text on the colour and the colour as text have a contrast of at least 4.5 : 1. Flowplan uses:",
                  )}
                  {(["light", "dark"] as const)
                    .filter((mode) => palettes[mode].adjusted)
                    .map((mode) => (
                      <span key={mode} className="look-adjusted-value">
                        {mode === "light" ? t("Hell", "Light") : t("Dunkel", "Dark")}{" "}
                        <span className="look-chip-swatch" style={{ "--swatch": palettes[mode].blue } as CSSProperties} /> <code>{palettes[mode].blue}</code>
                      </span>
                    ))}
                </span>
              </p>
            )}
          </div>
        </SettingRow>
        <SettingRow label={t("Hintergrund", "Background")} description={t("Ein Farbton für Seiten, Seitenleiste und Linien – jeweils mit dunkler Fassung.", "A tint for pages, sidebar and lines – each with a dark counterpart.")} wide>
          <div className="look-backgrounds" role="radiogroup" aria-label={t("Hintergrund", "Background")}>
            {BACKGROUND_PRESETS.map((p) => {
              const active = (draft.background ?? "standard") === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={`look-background${active ? " active" : ""}`}
                  disabled={!owner}
                  onClick={() => setDraft((d) => ({ ...d, background: p.id as BackgroundId }))}
                >
                  <span className="look-background-sample" aria-hidden>
                    <span style={{ background: p.light.sidebar }} />
                    <span style={{ background: p.light.bg, borderColor: p.light.border }} />
                    <span style={{ background: p.dark.sidebar }} />
                    <span style={{ background: p.dark.bg, borderColor: p.dark.border }} />
                  </span>
                  {backgroundName(p.id, t)}
                </button>
              );
            })}
          </div>
        </SettingRow>
      </SettingGroup>
      <SettingGroup id="look-fonts" title={t("Schriften", "Typefaces")} description={t("Alle Schriften liegen auf diesem Server – der Browser lädt nur die gewählten, und keine kommt von einem fremden Dienst.", "All typefaces are on this server – the browser loads only the chosen ones, and none comes from an outside service.")}>
        {FONT_SLOTS.map((slot) => (
          <SettingRow key={slot} label={slotLabel(slot, t)} description={slotDescription(slot, t)} id={`look-font-${slot}`}>
            <FontSelect slot={slot} value={draft.fonts?.[slot] ?? ""} fonts={look.fonts} disabled={!owner} onChange={(v) => setFont(slot, v)} />
          </SettingRow>
        ))}
      </SettingGroup>
      <FontUploads workspaceId={workspaceId} owner={owner} fonts={look.fonts} theme={draft} onLook={(next) => {
        setLook(next);
        // Slots that used a deleted face go back to the default.
        setDraft((d) => {
          const ids = new Set(next.fonts.map((f) => `${CUSTOM_PREFIX}${f.id}`));
          const fonts = Object.fromEntries(Object.entries(d.fonts ?? {}).filter(([, v]) => !v?.startsWith(CUSTOM_PREFIX) || ids.has(v)));
          return { ...d, fonts };
        });
      }} />
      {owner && (
        <SaveBar
          dirty={dirty}
          busy={busy}
          onDiscard={() => setDraft(look.theme ?? {})}
          saveLabel={t("Speichern", "Save")}
          discardLabel={t("Verwerfen", "Discard")}
          message={t("Ungespeicherte Änderungen am Erscheinungsbild", "Unsaved changes to the appearance")}
        />
      )}
    </form>
  );
}

type Say = (de: string, en: string) => string;
function backgroundName(id: string, t: Say) {
  return id === "neutral" ? t("Neutral", "Neutral") : id === "cool" ? t("Kühl", "Cool") : id === "sepia" ? t("Sepia", "Sepia") : t("Standard (warm)", "Standard (warm)");
}
function slotLabel(slot: FontSlot, t: Say) {
  return slot === "ui" ? t("Schrift der Oberfläche", "Interface font") : slot === "display" ? t("Schrift für Überschriften", "Heading font") : t("Schrift für Code", "Code font");
}
function slotDescription(slot: FontSlot, t: Say) {
  return slot === "ui"
    ? t("Menüs, Texte und Seiten.", "Menus, text and pages.")
    : slot === "display"
      ? t("Große Überschriften und Seiten, deren Schrift auf Serif gewechselt wurde.", "Large headings and pages whose font was changed to serif.")
      : t("Code und Codeblöcke.", "Code and code blocks.");
}

const CATEGORY_ORDER: Record<FontSlot, FontCategory[]> = { ui: ["sans", "serif", "mono"], display: ["serif", "sans", "mono"], mono: ["mono", "sans", "serif"] };
function FontSelect({ slot, value, fonts, disabled, onChange }: { slot: FontSlot; value: string; fonts: ThemeFont[]; disabled: boolean; onChange: (value: string) => void }) {
  const t = useT();
  const groupName = (c: FontCategory) => (c === "sans" ? t("Serifenlos", "Sans serif") : c === "serif" ? t("Mit Serifen", "Serif") : t("Monospace", "Monospace"));
  const fallback = bundledFont(DEFAULT_FONTS[slot])!;
  return (
    <Select id={`look-font-${slot}`} className={CONTROL.md} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value="" data-font={fontStack(slot, DEFAULT_FONTS[slot]) ?? undefined}>{`${t("Standard", "Default")} (${fallback.name})`}</option>
      <option value={SYSTEM_FONT} data-font={fontStack(slot, SYSTEM_FONT) ?? undefined}>
        {t("Systemschrift", "System font")}
      </option>
      {CATEGORY_ORDER[slot].map((category) => (
        <optgroup key={category} label={groupName(category)}>
          {BUNDLED_FONTS.filter((f) => f.category === category && f.id !== SYSTEM_FONT && f.id !== DEFAULT_FONTS[slot]).map((f) => (
            <option key={f.id} value={f.id} data-font={fontStack(slot, f.id) ?? undefined}>
              {f.name}
            </option>
          ))}
        </optgroup>
      ))}
      {fonts.length > 0 && (
        <optgroup label={t("Eigene Schriften", "Own fonts")}>
          {fonts.map((f) => (
            <option key={f.id} value={`${CUSTOM_PREFIX}${f.id}`} data-font={fontStack(slot, `${CUSTOM_PREFIX}${f.id}`) ?? undefined}>
              {f.name}
            </option>
          ))}
        </optgroup>
      )}
    </Select>
  );
}

// A small page in the look being edited, light or dark: the variables are
// set on the card itself, so it shows the draft whatever the app shows.
function LookPreview({ theme, fonts, mode, label }: { theme: WorkspaceTheme; fonts: ThemeFont[]; mode: Mode; label: string }) {
  const t = useT();
  const s = backgroundPreset(theme.background)[mode];
  const base = DEFAULT_COLOURS[mode];
  const vars = themeVariables(normalizeTheme(theme), mode, fonts);
  const style = {
    "--bg": s.bg,
    "--surface": s.surface,
    "--sidebar": s.sidebar,
    "--hover": s.hover,
    "--border": s.border,
    "--text": base.text,
    "--muted": base.muted,
    "--blue": vars["--blue"] ?? base.blue,
    "--blue-light": vars["--blue-light"] ?? base.blueLight,
    "--on-accent": vars["--on-accent"] ?? base.onAccent,
    "--font-ui": vars["--font-ui"] ?? fontStack("ui", DEFAULT_FONTS.ui),
    "--font-display": vars["--font-display"] ?? fontStack("display", DEFAULT_FONTS.display),
    "--font-mono": vars["--font-mono"] ?? fontStack("mono", DEFAULT_FONTS.mono),
    fontFeatureSettings: vars["--font-ui"] ? "normal" : undefined,
    colorScheme: mode,
  } as CSSProperties;
  return (
    <figure className="look-preview" style={style} aria-label={t(`Vorschau: ${label}`, `Preview: ${label}`)}>
      <div className="look-preview-sidebar" aria-hidden>
        <span className="look-preview-item active">
          <TextAa size={13} /> {t("Projekte", "Projects")}
        </span>
        <span className="look-preview-item">{t("Journal", "Journal")}</span>
        <span className="look-preview-item">{t("Aufgaben", "Tasks")}</span>
      </div>
      <div className="look-preview-page">
        <span className="look-preview-title">{t("Frühjahrsplanung", "Spring planning")}</span>
        <p>{t("Nächste Schritte und Termine", "Next steps and dates")}</p>
        <span className="look-preview-link">{t("Zur Roadmap", "Open the roadmap")}</span>
        <code>status = &quot;bereit&quot;</code>
        <span className="look-preview-actions">
          <span className="look-preview-button">{t("Teilen", "Share")}</span>
          <span className="look-preview-tag">{t("In Arbeit", "In progress")}</span>
        </span>
      </div>
      <figcaption>{label}</figcaption>
    </figure>
  );
}

// Uploaded faces: WOFF2, WOFF, TTF or OTF up to 5 MB, counted against the
// workspace's storage.
function FontUploads({ workspaceId, owner, fonts, theme, onLook }: { workspaceId: string; owner: boolean; fonts: ThemeFont[]; theme: WorkspaceTheme; onLook: (look: WorkspaceLook) => void }) {
  const t = useT();
  const { mutate, onError } = useUserSettings();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const upload = async (file: File) => {
    setBusy(true);
    try {
      const form = new FormData();
      form.append("workspaceId", workspaceId);
      form.append("file", file);
      form.append("name", file.name.replace(/\.[^.]+$/, ""));
      const response = await fetch("/api/workspace-fonts", { method: "POST", body: form, headers: idempotencyHeaders() });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || t("Hochladen fehlgeschlagen.", "Upload failed."));
      onLook(await api<WorkspaceLook>("/api/command", { action: "workspace.look", workspaceId }));
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  const used = (id: string) => FONT_SLOTS.some((s) => theme.fonts?.[s] === `${CUSTOM_PREFIX}${id}`);
  return (
    <SettingGroup
      id="look-uploads"
      title={t("Eigene Schriften", "Own fonts")}
      description={t(
        "Eine Hausschrift als WOFF2, WOFF, TTF oder OTF (bis 5 MB). Sie zählt zum Speicher des Arbeitsbereichs. Bitte nur Schriften hochladen, deren Lizenz die Nutzung im Web erlaubt.",
        "A house font as WOFF2, WOFF, TTF or OTF (up to 5 MB). It counts toward the workspace's storage. Please only upload fonts whose licence allows use on the web.",
      )}
      actions={
        owner && (
          <>
            <input ref={input} type="file" accept=".woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf" hidden onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
            <button type="button" className="button compact" disabled={busy} onClick={() => input.current?.click()}>
              <UploadSimple aria-hidden /> {busy ? t("Lädt hoch …", "Uploading …") : t("Schrift hochladen", "Upload font")}
            </button>
          </>
        )
      }
    >
      {fonts.length === 0 ? (
        <div className="look-uploads-empty">
          <EmptyState icon={<TextAa size={20} />} title={t("Noch keine eigenen Schriften", "No own fonts yet")}>
            {t("Hochgeladene Schriften lassen sich oben für jeden Bereich der Oberfläche wählen.", "Uploaded fonts can be chosen above for any part of the interface.")}
          </EmptyState>
        </div>
      ) : (
        <ul className="look-uploads">
          {fonts.map((f) => (
            <li key={f.id}>
              <span className="look-upload-name" style={{ fontFamily: fontStack("ui", `${CUSTOM_PREFIX}${f.id}`) ?? undefined }}>
                {f.name}
              </span>
              <small>
                {f.format.toUpperCase()}
                {f.variable ? ` · ${t("variabel", "variable")}` : ""}
                {used(f.id) ? ` · ${t("in Verwendung", "in use")}` : ""}
              </small>
              {owner && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t(`${f.name} löschen`, `Delete ${f.name}`)}
                  title={t("Löschen", "Delete")}
                  onClick={() =>
                    void (async () => {
                      if (!confirm(t(`Schrift „${f.name}“ löschen? Wo sie gewählt ist, gilt wieder die Standardschrift.`, `Delete the font “${f.name}”? Where it is chosen, the default font applies again.`))) return;
                      try {
                        onLook((await mutate({ action: "workspace.font.delete", workspaceId, fontId: f.id })) as WorkspaceLook);
                      } catch (e) {
                        onError((e as Error).message);
                      }
                    })()
                  }
                >
                  <Trash size={16} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </SettingGroup>
  );
}
