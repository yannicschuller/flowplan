"use client";
// Settings → Konto & Sicherheit, as cards: Profil, Anmeldung & Sicherheit
// (password, two-factor, passkeys, signed-in devices), Ende-zu-Ende-
// Verschlüsselung, one's limits on this instance and – at the end – the
// danger zone (reset encryption keys, delete the account).
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useT } from "../../i18n";
import { Avatar } from "../../ui";
import { DangerZone, SettingGroup, SettingRow, StatusBadge, UsageMeter } from "../../settings-ui";
import { PasskeysRow, PasswordRow, ProfileNameRow } from "../../account-security";
import { TwoFactorSettings } from "../../two-factor";
import { DeleteOwnAccount } from "../../delete-own-account";
import { MySessions } from "../../my-sessions";
import { E2eeKeySettings, E2eeResetRow } from "../../e2ee";
import { useUserSettings } from "../user-context";

export default function AccountSection() {
  const t = useT();
  const { boot, onRefresh, onError } = useUserSettings();
  const local = !!boot.localAccount;
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
          </span>
          <StatusBadge tone="info">{local ? t("E-Mail-Konto", "E-mail account") : boot.ldapAccount ? "LDAP" : "SSO"}</StatusBadge>
        </div>
        {local ? (
          <ProfileNameRow name={boot.user.name} onRenamed={onRefresh} />
        ) : (
          <SettingRow label={t("Name und E-Mail", "Name and e-mail")} description={t("Werden von deinem Identitätsanbieter übernommen und lassen sich nur dort ändern.", "Come from your identity provider and can only be changed there.")}>
            {null}
          </SettingRow>
        )}
      </SettingGroup>

      {(local || twoFactor || !demo) && (
        <SettingGroup id="signin" title={t("Anmeldung & Sicherheit", "Sign-in & security")} description={t("Passwort, zweiter Faktor, Passkeys und die Geräte, auf denen du angemeldet bist.", "Password, second factor, passkeys and the devices you are signed in on.")}>
          {local && <PasswordRow />}
          {twoFactor && <TwoFactorSettings row />}
          {local && <PasskeysRow />}
          {!demo && <MySessions onError={onError} />}
        </SettingGroup>
      )}

      {!demo && <E2eeKeySettings userId={boot.user.id} onError={onError} />}

      {boot.myLimits && (
        <SettingGroup
          id="limits"
          title={t("Deine Grenzen", "Your limits")}
          description={t("So viel steht dir auf dieser Instanz zur Verfügung. Mehr gibt es bei den Admins.", "This is what you have on this instance. Admins can give you more.")}
        >
          <div className="setting-row wide">
            <div className="limits-overview">
              <UsageMeter
                label={t("Speicher (deine Dateien und Bilder)", "Storage (your files and images)")}
                used={boot.myLimits.usedBytes}
                limit={boot.myLimits.storageMb * 1024 * 1024}
                format={(n) => `${(n / 1024 / 1024).toLocaleString(LOCALE_TAG, { maximumFractionDigits: n < 10 * 1024 * 1024 ? 1 : 0 })} MB`}
              />
              <UsageMeter label={t("Eigene Arbeitsbereiche", "Own workspaces")} used={boot.myLimits.ownedWorkspaces} limit={boot.myLimits.workspaces} format={(n) => String(n)} />
            </div>
          </div>
          <SettingRow label={t("Größte Datei beim Hochladen", "Largest upload")}>
            <strong className="setting-value">{boot.myLimits.uploadMb} MB</strong>
          </SettingRow>
        </SettingGroup>
      )}

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
