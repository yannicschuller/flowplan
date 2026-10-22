"use client";
// Settings → Konto & Sicherheit: profile, password and second factor,
// signed-in devices, end-to-end encryption keys, one's limits on this
// instance and deleting the account.
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useT } from "../../i18n";
import { Avatar } from "../../ui";
import { SettingGroup, SettingRow, UsageMeter } from "../../settings-ui";
import { AccountSecurity } from "../../account-security";
import { TwoFactorSettings } from "../../two-factor";
import { DeleteOwnAccount } from "../../delete-own-account";
import { MySessions } from "../../my-sessions";
import { E2eeKeySettings } from "../../e2ee";
import { useUserSettings } from "../user-context";

export default function AccountSection() {
  const t = useT();
  const { boot, onRefresh, onError } = useUserSettings();
  return (
    <>
      <SettingGroup title={t("Dein Profil", "Your profile")}>
        <div className="setting-row wide profile-row">
          <div className="member-row">
            <Avatar name={boot.user.name} userId={boot.user.id} />
            <span>
              {boot.user.name}
              <small>{boot.user.email}</small>
            </span>
            <span className="tag tag-blue">{boot.localAccount ? "E-Mail" : boot.ldapAccount ? "LDAP" : "SSO"}</span>
          </div>
          {boot.localAccount ? (
            <AccountSecurity name={boot.user.name} onRenamed={onRefresh} />
          ) : (
            <p className="muted small">{t("Name und E-Mail werden von deinem Identitätsanbieter übernommen.", "Your name and e-mail come from your identity provider.")}</p>
          )}
          {/* LDAP accounts sign in with a password: the authenticator app applies to them too. */}
          {!boot.localAccount && boot.ldapAccount && <TwoFactorSettings />}
          {!boot.user.demo && <MySessions onError={onError} />}
          {!boot.user.demo && <E2eeKeySettings userId={boot.user.id} onError={onError} />}
        </div>
        {!boot.user.demo && (
          <SettingRow
            label={t("Konto löschen", "Delete account")}
            description={t("Löscht dein Konto und deine persönlichen Daten. Vorher siehst du, was mit deinen Arbeitsbereichen passiert.", "Deletes your account and your personal data. You see first what happens to your workspaces.")}
          >
            <DeleteOwnAccount />
          </SettingRow>
        )}
      </SettingGroup>
      {boot.myLimits && (
        <SettingGroup
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
    </>
  );
}
