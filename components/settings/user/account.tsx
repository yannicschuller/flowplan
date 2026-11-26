"use client";
// Settings → Konto & Sicherheit, as cards: Profil, Anmeldung & Sicherheit
// (password, two-factor, passkeys, signed-in devices), Ende-zu-Ende-
// Verschlüsselung, Notfallzugriff (trusted contacts, #281), Nachricht bei
// Inaktivität (#282), a line pointing to Speicher & KI (one's limits) and –
// at the end – the danger zone (reset encryption keys, delete the account).
import { useRef, useState } from "react";
import { Trash, UploadSimple } from "@phosphor-icons/react";
import { idempotencyHeaders } from "@/lib/idempotency-key";
import { serverMessage } from "@/lib/server-message";
import { useT } from "../../i18n";
import { Avatar } from "../../ui";
import { DangerZone, SettingGroup, SettingRow, StatusBadge } from "../../settings-ui";
import { EmailChangeRow, PasskeysRow, PasswordRow, ProfileNameRow } from "../../account-security";
import { TwoFactorSettings } from "../../two-factor";
import { DeleteOwnAccount } from "../../delete-own-account";
import { MySessions } from "../../my-sessions";
import { E2eeKeySettings, E2eeResetRow } from "../../e2ee";
import { EmergencyAccessSettings } from "../../emergency-access";
import { DeadManSwitchSettings } from "../../dead-man-switch";
import { SignInMethods } from "../../sign-in-methods";
import { useUserSettings } from "../user-context";
import { UsageMovedNote } from "./usage";

// One's own profile picture (#559), for local accounts: sent as the raw
// body to /api/avatars (the server checks the type by its content, at most
// 2 MB). The reloaded boot carries the new version, so the picture's URL
// changes and every Avatar shows it.
function ProfilePictureActions({ hasPicture, onChanged, onError }: { hasPicture: boolean; onChanged: () => Promise<unknown>; onError: (message: string) => void }) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"upload" | "remove" | null>(null);
  const send = async (init: RequestInit) => {
    setBusy(init.method === "DELETE" ? "remove" : "upload");
    try {
      const response = await fetch("/api/avatars", { ...init, headers: { ...idempotencyHeaders(), ...(init.headers as Record<string, string> | undefined) } });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(serverMessage(body.error) || t("Das hat nicht geklappt.", "That did not work."));
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(null);
      if (input.current) input.current.value = "";
    }
  };
  return (
    <span className="account-picture-actions">
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void send({ method: "POST", body: file, headers: { "Content-Type": "application/octet-stream" } });
        }}
      />
      <button type="button" className="button compact" disabled={!!busy} onClick={() => input.current?.click()}>
        <UploadSimple size={14} aria-hidden /> {busy === "upload" ? t("Wird hochgeladen …", "Uploading …") : t("Bild hochladen …", "Upload picture …")}
      </button>
      {hasPicture && (
        <button type="button" className="button compact" disabled={!!busy} onClick={() => void send({ method: "DELETE" })}>
          <Trash size={14} aria-hidden /> {t("Bild entfernen", "Remove picture")}
        </button>
      )}
    </span>
  );
}

export default function AccountSection() {
  const t = useT();
  const { boot, onRefresh, onError } = useUserSettings();
  const local = !!boot.localAccount;
  // A local account whose password was removed (SSO only, #101) changes none.
  const password = local && boot.hasPassword !== false;
  const demo = !!boot.user.demo;
  // LDAP accounts sign in with a password: the authenticator app applies to them too.
  const twoFactor = local || !!boot.ldapAccount;
  return (
    <>
      <SettingGroup id="profile" title={t("Profil", "Profile")} description={t("So sehen dich andere in Kommentaren, Erwähnungen und der Mitgliederliste.", "How others see you in comments, mentions and the member list.")}>
        <div className="setting-row account-identity">
          <Avatar name={boot.user.name} userId={boot.user.id} />
          <span className="account-identity-text">
            <strong>{boot.user.name}</strong>
            <small>{boot.user.email}</small>
            {local ? (
              <ProfilePictureActions hasPicture={!!boot.user.avatar} onChanged={onRefresh} onError={onError} />
            ) : (
              !boot.ldapAccount && (
                <small className="account-picture-hint">
                  {t("Dein Profilbild kommt von deinem Identitätsanbieter und wird bei jeder Anmeldung aktualisiert.", "Your profile picture comes from your identity provider and is updated at each sign-in.")}
                </small>
              )
            )}
          </span>
          <StatusBadge tone="info">{local ? (boot.ssoLinked ? t("E-Mail-Konto · SSO", "E-mail account · SSO") : t("E-Mail-Konto", "E-mail account")) : boot.ldapAccount ? "LDAP" : "SSO"}</StatusBadge>
        </div>
        {local ? (
          <>
            <ProfileNameRow name={boot.user.name} onRenamed={onRefresh} />
            {!demo && <EmailChangeRow />}
          </>
        ) : (
          <SettingRow label={t("Name und E-Mail", "Name and e-mail")} description={t("Werden von deinem Identitätsanbieter übernommen und lassen sich nur dort ändern.", "Come from your identity provider and can only be changed there.")}>
            {null}
          </SettingRow>
        )}
      </SettingGroup>

      {!demo && <SignInMethods onChanged={onRefresh} />}

      {(local || twoFactor || !demo) && (
        <SettingGroup id="signin" title={t("Anmeldung & Sicherheit", "Sign-in & security")} description={t("Passwort, zweiter Faktor, Passkeys und die Geräte, auf denen du angemeldet bist.", "Password, second factor, passkeys and the devices you are signed in on.")}>
          {password && <PasswordRow />}
          {twoFactor && <TwoFactorSettings row />}
          {local && <PasskeysRow />}
          {!demo && <MySessions onError={onError} />}
        </SettingGroup>
      )}

      {!demo && <E2eeKeySettings userId={boot.user.id} onError={onError} />}

      {!demo && <EmergencyAccessSettings userId={boot.user.id} onError={onError} />}

      {!demo && <DeadManSwitchSettings onError={onError} />}

      {/* "Deine Grenzen" moved to Speicher & KI (0.11.3). */}
      <UsageMovedNote />

      {!demo && (
        <DangerZone id="danger" description={t("Was du hier tust, lässt sich nicht rückgängig machen.", "What you do here cannot be undone.")}>
          <E2eeResetRow onError={onError} />
          <SettingRow
            anchor="delete-account"
            label={t("Konto löschen", "Delete account")}
            description={t("Löscht dein Konto und deine persönlichen Daten. Vorher siehst du, was mit deinen Arbeitsbereichen passiert.", "Deletes your account and your personal data. You see first what happens to your workspaces.")}
          >
            <DeleteOwnAccount />
          </SettingRow>
        </DangerZone>
      )}
    </>
  );
}
