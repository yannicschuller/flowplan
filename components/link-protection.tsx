"use client";
// Password and end date of a share link or a publication
// (lib/share-access.ts): the state as small chips, changes in a fold-out.
import { LOCALE_TAG } from "@/lib/locale-tag";
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
  if (!password && !expiresAt) return null;
  return (
    <span className="link-protection-chips">
      {password && <span className="status-chip">{t("Passwort", "Password")}</span>}
      {expiresAt &&
        (expired ? (
          <span className="status-chip warning-chip">{t("abgelaufen", "expired")}</span>
        ) : (
          <span className="status-chip muted-chip">{t(`läuft ab am ${formatExpiry(expiresAt)}`, `expires on ${formatExpiry(expiresAt)}`)}</span>
        ))}
    </span>
  );
}

export function LinkProtection({
  label,
  password,
  expiresAt,
  disabled,
  onSave,
}: {
  label: string;
  password: boolean;
  expiresAt: number | null;
  disabled?: boolean;
  onSave: (patch: ProtectionPatch) => Promise<unknown>;
}) {
  const t = useT();
  const [newPassword, setNewPassword] = useState(""),
    [expiry, setExpiry] = useState(localInputValue(expiresAt)),
    [busy, setBusy] = useState(false);
  const save = async (patch: ProtectionPatch) => {
    setBusy(true);
    try {
      const result = await onSave(patch);
      if (result && patch.password !== undefined) setNewPassword("");
      if (result && patch.expiresAt === null) setExpiry("");
    } finally {
      setBusy(false);
    }
  };
  const off = disabled || busy;
  return (
    <details className="link-protection">
      <summary>{t("Passwort und Ablaufdatum", "Password and expiry date")}</summary>
      {/* Groups, no <label>s: WebKit passes taps on their buttons ("Kein
          Ablauf", "Entfernen") to the first input, opening the date picker. */}
      <div className="link-protection-body">
        <div className="field-group">
          {password ? t("Neues Passwort", "New password") : t("Passwort", "Password")}
          <span className="link-protection-row">
            <input
              type="password"
              autoComplete="new-password"
              aria-label={t(`Passwort für ${label}`, `Password for ${label}`)}
              minLength={6}
              maxLength={200}
              placeholder={password ? t("Bleibt unverändert", "Stays unchanged") : t("Ohne Passwort", "No password")}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
            <button type="button" className="button compact" disabled={off || newPassword.length < 6} onClick={() => void save({ password: newPassword })}>
              {password ? t("Ändern", "Change") : t("Festlegen", "Set")}
            </button>
            {password && (
              <button type="button" className="button compact" disabled={off} onClick={() => void save({ password: null })}>
                {t("Entfernen", "Remove")}
              </button>
            )}
          </span>
          <small className="muted">{t("Mindestens 6 Zeichen. Besucher geben es einmal pro Gerät ein.", "At least 6 characters. Visitors enter it once per device.")}</small>
        </div>
        <div className="field-group">
          {t("Läuft ab am", "Expires on")}
          <span className="link-protection-row">
            <input
              type="datetime-local"
              aria-label={t(`Ablaufdatum für ${label}`, `Expiry date for ${label}`)}
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
            />
            <button
              type="button"
              className="button compact"
              disabled={off || !expiry || expiry === localInputValue(expiresAt)}
              onClick={() => void save({ expiresAt: fromLocalInput(expiry) })}
            >
              {t("Speichern", "Save")}
            </button>
            {expiresAt && (
              <button type="button" className="button compact" disabled={off} onClick={() => void save({ expiresAt: null })}>
                {t("Kein Ablauf", "No expiry")}
              </button>
            )}
          </span>
          <small className="muted">{t("Danach zeigt der Link nur noch „abgelaufen“ – auch für Dateien.", "Afterwards the link only shows “expired” – files included.")}</small>
        </div>
      </div>
    </details>
  );
}
