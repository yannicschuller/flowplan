"use client";
// Password and end date of a share link or a publication
// (lib/share-access.ts): the state as small badges, changes in two editors
// the share dialog unfolds (components/share-dialog.tsx).
import { LOCALE_TAG } from "@/lib/locale-tag";
import { CalendarBlank, LockSimple } from "@phosphor-icons/react";
import { useState } from "react";
import { useT } from "./i18n";

export type ProtectionPatch = { password?: string | null; expiresAt?: number | null };

// "2026-11-12T14:00" in local time, as <input type="datetime-local"> wants it.
export function localInputValue(ms: number | null | undefined) {
  if (!ms) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export const fromLocalInput = (value: string) => (value ? new Date(value).getTime() : null);
export const formatExpiry = (ms: number) =>
  new Date(ms).toLocaleString(LOCALE_TAG, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

export function ProtectionChips({ password, expiresAt }: { password: boolean; expiresAt: number | null }) {
  const t = useT();
  const [now] = useState(() => Date.now());
  const expired = !!expiresAt && expiresAt <= now;
  return (
    <>
      {password && (
        <span className="tag">
          <LockSimple aria-hidden />
          {t("Passwort", "Password")}
        </span>
      )}
      {expiresAt &&
        (expired ? (
          <span className="tag tag-red">{t("abgelaufen", "expired")}</span>
        ) : (
          <span className="tag">
            <CalendarBlank aria-hidden />
            {t(`läuft ab am ${formatExpiry(expiresAt)}`, `expires on ${formatExpiry(expiresAt)}`)}
          </span>
        ))}
    </>
  );
}

// Saves one change; clears the field the change came from on success.
function useSave(onSave: (patch: ProtectionPatch) => Promise<unknown>) {
  const [busy, setBusy] = useState(false);
  const save = async (patch: ProtectionPatch, done: () => void) => {
    setBusy(true);
    try {
      if (await onSave(patch)) done();
    } finally {
      setBusy(false);
    }
  };
  return { busy, save };
}

// Groups, no <label>s: WebKit passes taps on their buttons ("Kein Ablauf",
// "Entfernen") to the first input, opening the date picker.
export function PasswordEditor({
  label,
  password,
  disabled,
  onSave,
}: {
  label: string;
  password: boolean;
  disabled?: boolean;
  onSave: (patch: ProtectionPatch) => Promise<unknown>;
}) {
  const t = useT();
  const [value, setValue] = useState("");
  const { busy, save } = useSave(onSave);
  const off = disabled || busy;
  return (
    <div className="field-group protection-field">
      {password ? t("Neues Passwort", "New password") : t("Passwort", "Password")}
      <span className="protection-row">
        <input
          type="password"
          autoComplete="new-password"
          aria-label={t(`Passwort für ${label}`, `Password for ${label}`)}
          minLength={6}
          maxLength={200}
          placeholder={password ? t("Bleibt unverändert", "Stays unchanged") : t("Ohne Passwort", "No password")}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="button" className="button compact" disabled={off || value.length < 6} onClick={() => void save({ password: value }, () => setValue(""))}>
          {password ? t("Ändern", "Change") : t("Festlegen", "Set")}
        </button>
        {password && (
          <button type="button" className="button compact" disabled={off} onClick={() => void save({ password: null }, () => setValue(""))}>
            {t("Entfernen", "Remove")}
          </button>
        )}
      </span>
      <small className="muted">{t("Mindestens 6 Zeichen. Besucher geben es einmal pro Gerät ein.", "At least 6 characters. Visitors enter it once per device.")}</small>
    </div>
  );
}

export function ExpiryEditor({
  label,
  expiresAt,
  disabled,
  onSave,
}: {
  label: string;
  expiresAt: number | null;
  disabled?: boolean;
  onSave: (patch: ProtectionPatch) => Promise<unknown>;
}) {
  const t = useT();
  const [value, setValue] = useState(localInputValue(expiresAt));
  const { busy, save } = useSave(onSave);
  const off = disabled || busy;
  return (
    <div className="field-group protection-field">
      {t("Läuft ab am", "Expires on")}
      <span className="protection-row">
        <input
          type="datetime-local"
          aria-label={t(`Ablaufdatum für ${label}`, `Expiry date for ${label}`)}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button
          type="button"
          className="button compact"
          disabled={off || !value || value === localInputValue(expiresAt)}
          onClick={() => void save({ expiresAt: fromLocalInput(value) }, () => {})}
        >
          {t("Speichern", "Save")}
        </button>
        {expiresAt && (
          <button type="button" className="button compact" disabled={off} onClick={() => void save({ expiresAt: null }, () => setValue(""))}>
            {t("Kein Ablauf", "No expiry")}
          </button>
        )}
      </span>
      <small className="muted">{t("Danach zeigt der Link nur noch „abgelaufen“ – auch für Dateien.", "Afterwards the link only shows “expired” – files included.")}</small>
    </div>
  );
}
