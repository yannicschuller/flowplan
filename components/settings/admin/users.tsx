"use client";
// Administration → Benutzer: the accounts of the instance with their limits,
// sessions, blocking and deleting, and – with e-mail sign-in – whether
// people may sign up themselves.
import { useState } from "react";
import { LOCALE_TAG } from "@/lib/locale-tag";
import type { User } from "@/lib/types";
import type { InstanceSettings } from "@/lib/instance-settings";
import { useT } from "../../i18n";
import { Avatar, Modal } from "../../ui";
import { Select } from "../../select";
import { NumberField, UsageMeter } from "../../settings-ui";
import { AiUserSwitch } from "../../ai-settings";
import { useAdminData, type AdminData } from "../admin-context";
import { AdminLoading } from "../shell";
import { mbText } from "./format";

export default function UsersSection() {
  const t = useT();
  const { data, act, load } = useAdminData();
  const [query, setQuery] = useState(""),
    [status, setStatus] = useState("all");
  // A reset link for an account with e-mail and password, to hand over.
  const [resetLink, setResetLink] = useState<{ userId: string; url: string } | null>(null);
  if (!data) return <AdminLoading />;
  return (
    <>
      {data.localLogin && <SignupSwitch open={!!data.settings.allowSignup} onChange={(allowSignup) => act({ action: "admin.settings", settings: { ...data.settings, allowSignup } })} />}
      <section className="settings-section">
        <div className="settings-list-head">
          <h2>{t("Benutzer ·", "Users ·")}{" "}{data.users.length}</h2>
          <input type="search" aria-label={t("Benutzer suchen", "Search users")} placeholder={t("Name oder E-Mail suchen …", "Search name or email …")} value={query} onChange={(e) => setQuery(e.target.value)} />
          <Select aria-label={t("Status", "Status")} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="all">{t("Alle", "All")}</option>
            <option value="active">{t("Aktiv", "Active")}</option>
            <option value="disabled">{t("Deaktiviert", "Disabled")}</option>
          </Select>
        </div>
        <div className="settings-list">
          {data.users
            .filter((u) => (status === "all" || (status === "disabled") === !!u.disabled) && `${u.name} ${u.email}`.toLowerCase().includes(query.toLowerCase()))
            .map((u) => (
              <UserRow
                key={u.id}
                user={u}
                usage={data.userUsage?.find((x) => x.id === u.id)}
                settings={data.settings}
                ai={data.aiPolicy?.enabled && data.aiPolicy.access === "selected" ? { allowed: data.aiPolicy.allowed.includes(u.id), onChange: load } : null}
                local={data.localAccounts?.[u.id]}
                resetLink={resetLink?.userId === u.id ? resetLink.url : null}
                act={act}
                onResetLink={(url) => setResetLink({ userId: u.id, url })}
              />
            ))}
        </div>
      </section>
    </>
  );
}

// Whether people can create an account themselves; saved right away.
function SignupSwitch({ open, onChange }: { open: boolean; onChange: (open: boolean) => Promise<unknown> }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  return (
    <section className="settings-section signup-switch" aria-label={t("Registrierung", "Sign-up")}>
      <label className="js-switch">
        <input
          type="checkbox"
          role="switch"
          checked={open}
          disabled={busy}
          onChange={async (e) => {
            setBusy(true);
            await onChange(e.target.checked);
            setBusy(false);
          }}
        />
        <span>
          <strong>
            {t("Registrierung", "Sign-up")}: {open ? t("offen", "open") : t("geschlossen", "closed")}
          </strong>
          <small>
            {open
              ? t("Jede Person kann sich mit E-Mail und Passwort ein Konto anlegen.", "Anyone can create an account with email and password.")
              : t("Nur eingeladene Adressen können ein Konto anlegen. Der Knopf „Registrieren“ ist ausgeblendet.", "Only invited addresses can create an account. The “Sign up” button is hidden.")}
          </small>
        </span>
      </label>
    </section>
  );
}

// One account: who, when last seen, how much storage; "Verwalten" opens its
// limits (empty = the instance default) and actions.
function UserRow({
  user: u,
  usage,
  settings,
  ai,
  local,
  resetLink,
  act,
  onResetLink,
}: {
  // The AI switch, when only selected people may use AI.
  ai: { allowed: boolean; onChange: () => void } | null;
  user: User;
  usage?: NonNullable<AdminData["userUsage"]>[number];
  settings: InstanceSettings;
  local?: { admin: boolean; verified: boolean; passkeys: number; totp?: boolean };
  resetLink: string | null;
  act: (body: Record<string, unknown>) => Promise<unknown>;
  onResetLink: (url: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [limits, setLimits] = useState(usage?.limits || {});
  const [busy, setBusy] = useState(false);
  // Deleting: what would happen, shown before it happens.
  const [plan, setPlan] = useState<{
    removed: { name: string }[];
    handedOver: { name: string; to: string }[];
    kept: { name: string; disabled: number }[];
    privateSpaces: number;
  } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const clean = (l: object) => JSON.stringify(Object.entries(l).filter(([, v]) => v !== null && v !== undefined).sort());
  const changed = clean(limits) !== clean(usage?.limits || {});
  const storage = usage?.effective.storageMb ?? 0;
  const defaults = {
    storage: settings.defaultUserStorageMb ? `${settings.defaultUserStorageMb} MB` : t("unbegrenzt", "unlimited"),
    workspaces: settings.defaultUserWorkspaces ? String(settings.defaultUserWorkspaces) : t("unbegrenzt", "unlimited"),
    upload: `${settings.maxUploadMb} MB`,
  };
  const panel = `user-panel-${u.id}`;
  return (
    <div className={`user-row${u.disabled ? " is-disabled" : ""}${open ? " open" : ""}`}>
      <div className="user-row-summary">
        <Avatar name={u.name} userId={u.id} />
        <span className="user-row-who">
          <strong>{u.name}</strong>
          <small>
            {u.email} ·{" "}
            {u.last_login_at
              ? t(`zuletzt angemeldet ${new Date(u.last_login_at).toLocaleDateString(LOCALE_TAG)}`, `last signed in ${new Date(u.last_login_at).toLocaleDateString(LOCALE_TAG)}`)
              : t("noch nie angemeldet", "never signed in")}
          </small>
        </span>
        <span className="user-row-chips">
          {ai && <AiUserSwitch userId={u.id} name={u.name} allowed={ai.allowed} onChange={ai.onChange} />}
          {!!u.disabled && <span className="status-chip muted-chip">{t("Deaktiviert", "Disabled")}</span>}
          {local?.admin && <span className="status-chip">{t("Admin", "Admin")}</span>}
          {local && !local.verified && (
            <span className="status-chip warning-chip" title={t("Die Person hat den Link aus der Bestätigungs-E-Mail noch nicht geöffnet.", "The person has not opened the link from the confirmation e-mail yet.")}>
              {t("E-Mail unbestätigt", "E-mail unconfirmed")}
            </span>
          )}
          {local && (
            <span className="status-chip muted-chip" title={t("Meldet sich mit E-Mail und Passwort an", "Signs in with email and password")}>
              E-Mail{local.passkeys ? ` · ${local.passkeys} Passkey` : ""}
            </span>
          )}
          {local && (
            <span className={`status-chip ${local.totp || local.passkeys ? "" : "muted-chip"}`} title={t("Zwei-Faktor-Anmeldung: Authenticator-App oder Passkey", "Two-factor sign-in: authenticator app or passkey")}>
              {local.totp ? t("2FA an", "2FA on") : local.passkeys ? t("2FA per Passkey", "2FA via passkey") : t("2FA aus", "2FA off")}
            </span>
          )}
          {usage && (
            <span className="user-row-storage" title={t("Belegter Speicher", "Storage used")}>
              {mbText(usage.bytes)}
              {storage ? ` / ${storage} MB` : ""}
            </span>
          )}
        </span>
        <button type="button" className="button compact" aria-expanded={open} aria-controls={panel} onClick={() => setOpen(!open)}>
          {t("Verwalten", "Manage")}
        </button>
      </div>
      {open && (
        <div className="user-row-panel" id={panel}>
          {usage && (
            <div className="user-row-meters">
              <UsageMeter label={t("Speicher", "Storage")} used={usage.bytes} limit={storage * 1024 * 1024} format={mbText} />
              <UsageMeter label={t("Eigene Arbeitsbereiche", "Own workspaces")} used={usage.workspaces} limit={usage.effective.workspaces} format={(n) => String(n)} />
            </div>
          )}
          <form
            className="user-row-limits"
            aria-label={t(`Grenzen für ${u.name}`, `Limits for ${u.name}`)}
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await act({ action: "admin.userLimits", userId: u.id, limits });
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              <span>{t("Speicher", "Storage")}</span>
              <NumberField label={t(`Speicher für ${u.name}`, `Storage for ${u.name}`)} value={limits.storageMb} unit="MB" placeholder={t(`Standard: ${defaults.storage}`, `Default: ${defaults.storage}`)} onChange={(storageMb) => setLimits({ ...limits, storageMb })} />
            </label>
            <label>
              <span>{t("Arbeitsbereiche", "Workspaces")}</span>
              <NumberField label={t(`Eigene Arbeitsbereiche für ${u.name}`, `Own workspaces for ${u.name}`)} value={limits.workspaces} max={10000} placeholder={t(`Standard: ${defaults.workspaces}`, `Default: ${defaults.workspaces}`)} onChange={(workspaces) => setLimits({ ...limits, workspaces })} />
            </label>
            <label>
              <span>{t("Größte Datei", "Largest file")}</span>
              <NumberField label={t(`Größte Datei für ${u.name}`, `Largest file for ${u.name}`)} value={limits.uploadMb} min={1} max={1024} unit="MB" placeholder={t(`Standard: ${defaults.upload}`, `Default: ${defaults.upload}`)} onChange={(uploadMb) => setLimits({ ...limits, uploadMb })} />
            </label>
            <button className="button primary compact" disabled={!changed || busy}>
              {busy ? t("Speichert …", "Saving …") : t("Grenzen speichern", "Save limits")}
            </button>
            <small className="muted">{t("Leer = Standard der Instanz, 0 = unbegrenzt. Für Admins gelten keine Grenzen.", "Empty = instance default, 0 = unlimited. Admins are not limited.")}</small>
          </form>
          <div className="user-row-actions">
            {local && (
              <>
                <button type="button" className="button compact" onClick={() => act({ action: "admin.localAdmin", userId: u.id, admin: !local.admin })}>
                  {local.admin ? t("Admin entziehen", "Revoke admin") : t("Zum Admin machen", "Make admin")}
                </button>
                <button
                  type="button"
                  className="button compact"
                  onClick={async () => {
                    const result = (await act({ action: "admin.resetLink", userId: u.id })) as { url?: string } | undefined;
                    if (result?.url) onResetLink(result.url);
                  }}
                >
                  {t("Link zum Zurücksetzen", "Reset link")}
                </button>
                {local.totp && (
                  <button
                    type="button"
                    className="button compact"
                    title={t("Etwa bei verlorenem Telefon. Die Person wird per E-Mail informiert.", "E.g. for a lost phone. The person is told by e-mail.")}
                    onClick={() => {
                      if (confirm(t(`Authenticator-App für ${u.name} ausschalten? Danach meldet sich ${u.name} nur mit Passwort (oder Passkey) an und kann sie neu einrichten.`, `Turn off the authenticator app for ${u.name}? ${u.name} then signs in with the password (or a passkey) and can set it up again.`)))
                        void act({ action: "admin.twoFactorReset", userId: u.id });
                    }}
                  >
                    {t("Zwei-Faktor zurücksetzen", "Reset two-factor")}
                  </button>
                )}
              </>
            )}
            <button type="button" className="button compact" onClick={() => act({ action: "admin.revoke", userId: u.id })}>
              {t("Sitzungen beenden", "End sessions")}
            </button>
            {local && !local.verified && (
              <button type="button" className="button compact" onClick={() => act({ action: "admin.confirmEmail", userId: u.id })}>
                {t("E-Mail als bestätigt markieren", "Mark e-mail as confirmed")}
              </button>
            )}
            <button type="button" className={`button compact ${u.disabled ? "" : "danger"}`} onClick={() => act({ action: "admin.user", userId: u.id, disabled: !u.disabled })}>
              {u.disabled ? t("Aktivieren", "Enable") : t("Deaktivieren", "Disable")}
            </button>
            {!!u.disabled && (
              <button
                type="button"
                className="button compact danger"
                onClick={async () => {
                  const result = (await act({ action: "admin.deletePlan", userId: u.id })) as typeof plan;
                  if (result) setPlan(result);
                }}
              >
                {t("Konto löschen …", "Delete account …")}
              </button>
            )}
          </div>
          {!u.disabled && <small className="muted">{t("Löschen ist möglich, sobald das Konto deaktiviert ist.", "Deleting is possible once the account is disabled.")}</small>}
          <Modal open={!!plan} onClose={() => !deleting && setPlan(null)} title={t(`${u.name} löschen?`, `Delete ${u.name}?`)}>
            {plan && (
              <div className="delete-account">
                <p>{t("Das lässt sich nicht rückgängig machen.", "This cannot be undone.")}</p>
                <ul>
                  <li>{t("Name, E-Mail-Adresse, Passwort, Passkeys, Sitzungen und persönliche Einstellungen werden gelöscht.", "Name, e-mail address, password, passkeys, sessions and personal settings are deleted.")}</li>
                  {plan.removed.length > 0 && (
                    <li>
                      {t("Diese Arbeitsbereiche hatten nur diese Person als Mitglied und werden mit allen Inhalten gelöscht:", "These workspaces had only this person as a member and are deleted with all content:")}{" "}
                      <strong>{plan.removed.map((w) => w.name).join(", ")}</strong>
                    </li>
                  )}
                  {plan.handedOver.map((w) => (
                    <li key={w.name}>{t(`„${w.name}“ bekommt ${w.to} als Eigentümer.`, `“${w.name}” gets ${w.to} as owner.`)}</li>
                  ))}
                  {plan.kept.map((w) => (
                    <li key={w.name}>
                      {w.disabled === 1
                        ? t(`„${w.name}“ bleibt erhalten – 1 deaktiviertes Mitglied.`, `“${w.name}” is kept – 1 deactivated member.`)
                        : t(`„${w.name}“ bleibt erhalten – ${w.disabled} deaktivierte Mitglieder.`, `“${w.name}” is kept – ${w.disabled} deactivated members.`)}
                    </li>
                  ))}
                  {plan.privateSpaces > 0 && <li>{t(`${plan.privateSpaces} private Bereiche werden gelöscht.`, `${plan.privateSpaces} private spaces are deleted.`)}</li>}
                  <li>{t("Beiträge in gemeinsamen Arbeitsbereichen (Seiten, Einträge, Kommentare, Dateien) bleiben und erscheinen als „Gelöschtes Konto“.", "Contributions to shared workspaces (pages, records, comments, files) stay and appear as “Deleted account”.")}</li>
                </ul>
                <div className="modal-actions">
                  <button type="button" className="button" disabled={deleting} onClick={() => setPlan(null)}>
                    {t("Abbrechen", "Cancel")}
                  </button>
                  <button
                    type="button"
                    className="button danger-solid"
                    disabled={deleting}
                    onClick={async () => {
                      setDeleting(true);
                      try {
                        if (await act({ action: "admin.deleteUser", userId: u.id })) setPlan(null);
                      } finally {
                        setDeleting(false);
                      }
                    }}
                  >
                    {deleting ? t("Löscht …", "Deleting …") : t("Endgültig löschen", "Delete permanently")}
                  </button>
                </div>
              </div>
            )}
          </Modal>
          {resetLink && (
            <label className="reset-link">
              {t(`Zwei Stunden gültig – an ${u.name} weitergeben:`, `Valid for two hours – send to ${u.name}:`)}
              <input readOnly value={resetLink} onFocus={(e) => e.currentTarget.select()} />
            </label>
          )}
        </div>
      )}
    </div>
  );
}
