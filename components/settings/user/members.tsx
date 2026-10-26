"use client";
// Settings → Arbeitsbereich → Mitglieder: the people of the workspace with
// their role and badges (guest, SSO), the invitations still open, and the
// invitation itself in a sheet.
import { useState } from "react";
import { EnvelopeSimple, Plus, UserPlus, X } from "@phosphor-icons/react";
import { LOCALE_TAG } from "@/lib/locale-tag";
import type { Bootstrap } from "@/lib/types";
import { useT } from "../../i18n";
import { Avatar, Modal } from "../../ui";
import { Select } from "../../select";
import { EmptyState, SaveState, SettingGroup, StatusBadge, useSaveState } from "../../settings-ui";
import { useUserSettings, type WorkspaceSettingsData } from "../user-context";
import { useSsoVia } from "./sso-via";

type Member = Bootstrap["members"][number];
type Invite = WorkspaceSettingsData["invites"][number];

function useRoleName() {
  const t = useT();
  return (role: string) => (role === "owner" ? t("Eigentümer", "Owner") : role === "editor" ? t("Bearbeiten", "Edit") : role === "viewer" ? t("Ansehen", "View") : role);
}

function MemberItem({ member: m }: { member: Member }) {
  const t = useT();
  const roleName = useRoleName();
  const { boot, owner, mutate, reload, onError } = useUserSettings();
  const { ssoVia, ssoNotice } = useSsoVia();
  const [status, run] = useSaveState();
  const via = ssoVia(m.id, "");
  const save = (body: Record<string, unknown>) =>
    run(async () => {
      await mutate({ workspaceId: boot.workspace.id, ...body });
      await reload();
      return true;
    });
  return (
    <li className="ws-item ws-member">
      <Avatar name={m.name} userId={m.id} />
      <div className="ws-item-text">
        <strong>
          {m.name}
          {m.id === boot.user.id && <span className="ws-you">{t("du", "you")}</span>}
        </strong>
        <small className="ws-break">{m.email}</small>
        <span className="ws-badges">
          {(m.role === "owner" || !owner) && <StatusBadge tone={m.role === "owner" ? "info" : "off"}>{roleName(m.role)}</StatusBadge>}
          {!!m.guest && <StatusBadge tone="warn">{t("Gast", "Guest")}</StatusBadge>}
          {via && (
            <StatusBadge
              tone="info"
              title={t(
                "Diese Mitgliedschaft wird über die SSO-Gruppen verwaltet. Eine Änderung hier gilt nur bis zur nächsten SSO-Anmeldung der Person – dann setzt die Zuordnung die Rolle wieder.",
                "This membership is managed through SSO groups. A change here lasts only until the person's next SSO sign-in – then the mapping sets the role again.",
              )}
            >
              {t(`über SSO-Gruppe „${via}“`, `via SSO group “${via}”`)}
            </StatusBadge>
          )}
        </span>
      </div>
      {owner && (
        <div className="ws-item-controls">
          <Select
            className="ws-role"
            aria-label={t(`Rolle für ${m.name}`, `Role for ${m.name}`)}
            value={m.role}
            disabled={status.state === "saving"}
            onChange={async (e) => {
              const role = e.target.value;
              if (role === "remove" && !confirm(t(`${m.name} aus dem Arbeitsbereich entfernen?`, `Remove ${m.name} from the workspace?`))) {
                e.target.value = m.role;
                return;
              }
              const changed = await save({ action: "member.role", userId: m.id, role });
              if (changed && role !== "remove" && via) onError(ssoNotice);
            }}
          >
            <option value="owner">{t("Eigentümer", "Owner")}</option>
            <option value="editor">{t("Bearbeiten", "Edit")}</option>
            <option value="viewer">{t("Ansehen", "View")}</option>
            <option value="remove">{t("Entfernen", "Remove")}</option>
          </Select>
          {m.role !== "owner" && (
            <button
              type="button"
              className="button"
              disabled={status.state === "saving"}
              aria-label={m.guest ? t(`${m.name} zum Mitglied machen`, `Make ${m.name} a member`) : t(`${m.name} zum Gast machen`, `Make ${m.name} a guest`)}
              onClick={() => void save({ action: "member.guest", userId: m.id, guest: !m.guest })}
            >
              {m.guest ? t("Zum Mitglied machen", "Make member") : t("Zum Gast machen", "Make guest")}
            </button>
          )}
          <SaveState status={status} />
        </div>
      )}
    </li>
  );
}

function InviteItem({ invite: i }: { invite: Invite }) {
  const t = useT();
  const roleName = useRoleName();
  const { boot, act, onError } = useUserSettings();
  return (
    <li className="ws-item ws-invite">
      <span className="ws-item-icon" aria-hidden>
        <EnvelopeSimple size={18} />
      </span>
      <div className="ws-item-text">
        <strong className="ws-break">{i.email}</strong>
        <span className="ws-badges">
          <StatusBadge tone="warn">{t("Ausstehend", "Pending")}</StatusBadge>
          <StatusBadge tone="off">{roleName(i.role)}</StatusBadge>
          {!!i.guest && <StatusBadge tone="off">{i.pages?.length ? t(`Gast für ${i.pages.join(", ")}`, `Guest for ${i.pages.join(", ")}`) : t("Gast", "Guest")}</StatusBadge>}
        </span>
        <small>
          {[
            i.created_at ? t(`eingeladen am ${new Date(i.created_at).toLocaleDateString(LOCALE_TAG)}`, `invited on ${new Date(i.created_at).toLocaleDateString(LOCALE_TAG)}`) : null,
            i.inviter ? t(`von ${i.inviter}`, `by ${i.inviter}`) : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </small>
      </div>
      <div className="ws-item-controls">
        {boot.instance?.mail && (
          <button
            type="button"
            className="button"
            onClick={async () => {
              if (await act({ action: "invite.resend", inviteId: i.id })) onError(t(`Einladung an ${i.email} erneut gesendet.`, `Invitation sent to ${i.email} again.`));
            }}
          >
            {t("Erneut senden", "Send again")}
          </button>
        )}
        {i.token && (
          <button
            type="button"
            className="button"
            title={t("Wer den Link angemeldet öffnet, nimmt die Einladung an – gib ihn nur der eingeladenen Person.", "Whoever opens the link signed in takes the invitation – give it only to the invited person.")}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(`${location.origin}/?invite=${i.token}`);
                onError(t("Einladungslink kopiert.", "Invitation link copied."));
              } catch {
                onError(`${location.origin}/?invite=${i.token}`);
              }
            }}
          >
            {t("Link kopieren", "Copy link")}
          </button>
        )}
        <button
          type="button"
          className="icon-button ws-danger-icon"
          title={t("Einladung zurückziehen", "Withdraw invitation")}
          aria-label={t(`Einladung an ${i.email} zurückziehen`, `Withdraw the invitation to ${i.email}`)}
          onClick={() => void act({ action: "invite.cancel", inviteId: i.id })}
        >
          <X size={18} />
        </button>
      </div>
    </li>
  );
}

function InviteSheet({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { boot, act } = useUserSettings();
  const [email, setEmail] = useState(""),
    [role, setRole] = useState("editor"),
    [guest, setGuest] = useState(false),
    [busy, setBusy] = useState(false);
  return (
    <Modal open sheet className="ws-sheet" title={t("Mitglied einladen", "Invite member")} onClose={() => !busy && onClose()}>
      <form
        className="ws-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const ok = await act({ action: "member.invite", email, role, guest });
          setBusy(false);
          if (ok) onClose();
        }}
      >
        <div className="ws-field">
          <label htmlFor="invite-email">{t("E-Mail-Adresse", "E-mail address")}</label>
          <input id="invite-email" required type="email" autoComplete="off" placeholder={t("name@unternehmen.de", "name@company.com")} value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
        </div>
        <div className="ws-field">
          <label htmlFor="invite-role">{t("Rolle", "Role")}</label>
          <Select id="invite-role" value={role} onChange={(e) => setRole(e.target.value)} disabled={busy}>
            <option value="editor">{t("Bearbeiten", "Edit")}</option>
            <option value="viewer">{t("Ansehen", "View")}</option>
          </Select>
        </div>
        <label className="ws-check">
          <input type="checkbox" checked={guest} onChange={(e) => setGuest(e.target.checked)} disabled={busy} />
          <span>
            {t("Als Gast einladen", "Invite as a guest")}
            <small>{t("Gäste sehen nur Seiten, die mit ihnen geteilt sind.", "Guests see only pages shared with them.")}</small>
          </span>
        </label>
        <p className="ws-note">
          {boot.instance?.mail
            ? t(
                "Die Person bekommt eine Einladung per E-Mail. Mit einem bestehenden Konto sieht sie den Arbeitsbereich beim nächsten Öffnen von Flowplan, sonst nach der Registrierung mit dieser Adresse – auch wenn die Registrierung sonst geschlossen ist.",
                "The person gets an invitation by e-mail. With an existing account they see the workspace the next time they open Flowplan, otherwise after signing up with this address – even if sign-ups are otherwise closed.",
              )
            : t(
                "Auf dieser Instanz werden keine E-Mails verschickt: Kopiere danach unter „Ausstehende Einladungen“ den Link und schick ihn der Person. Wer ihn angemeldet öffnet (oder sich darüber registriert), nimmt die Einladung an.",
                "This instance sends no e-mail: afterwards copy the link under “Pending invitations” and send it to the person. Whoever opens it signed in (or signs up through it) takes the invitation.",
              )}
        </p>
        <div className="modal-actions ws-form-actions">
          <button type="button" className="button" onClick={onClose} disabled={busy}>
            {t("Abbrechen", "Cancel")}
          </button>
          <button className="button primary" disabled={busy || !email.trim()}>
            <Plus aria-hidden />
            {t("Einladen", "Invite")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function MembersSection() {
  const t = useT();
  const { boot, owner, workspace: settings } = useUserSettings();
  const [inviting, setInviting] = useState(false);
  const guests = boot.members.filter((m) => m.guest).length;
  const invites = settings?.invites || [];
  const members = [...boot.members].sort((a, b) => Number(b.id === boot.user.id) - Number(a.id === boot.user.id) || (a.role === "owner" ? 0 : 1) - (b.role === "owner" ? 0 : 1) || a.name.localeCompare(b.name));
  const inviteButton = (
    <button type="button" className="button primary" onClick={() => setInviting(true)}>
      <UserPlus aria-hidden />
      {t("Mitglied einladen", "Invite member")}
    </button>
  );
  return (
    <>
      <SettingGroup
        id="members"
        title={t(`Mitglieder · ${boot.members.length}`, `Members · ${boot.members.length}`)}
        description={
          guests
            ? t(`Davon ${guests === 1 ? "1 Gast" : `${guests} Gäste`} – Gäste sehen nur geteilte Seiten.`, `${guests === 1 ? "1 guest" : `${guests} guests`} among them – guests see only shared pages.`)
            : t("Eigentümer verwalten den Arbeitsbereich, „Bearbeiten“ darf Inhalte ändern, „Ansehen“ nur lesen.", "Owners manage the workspace, “Edit” may change content, “View” may only read.")
        }
        actions={owner ? inviteButton : undefined}
      >
        <ul className="ws-list" aria-label={t("Mitglieder", "Members")}>
          {members.map((m) => (
            <MemberItem key={m.id} member={m} />
          ))}
        </ul>
      </SettingGroup>
      {owner && (
        <SettingGroup id="invitations" title={t(`Ausstehende Einladungen · ${invites.length}`, `Pending invitations · ${invites.length}`)} description={t("Eingeladen, aber noch nicht angenommen.", "Invited, but not accepted yet.")}>
          {invites.length ? (
            <ul className="ws-list" aria-label={t("Ausstehende Einladungen", "Pending invitations")}>
              {invites.map((i) => (
                <InviteItem key={i.id} invite={i} />
              ))}
            </ul>
          ) : (
            <div className="setting-row wide">
              <EmptyState icon={<EnvelopeSimple size={20} />} title={t("Keine offenen Einladungen", "No open invitations")}>
                {t("Neue Einladungen erscheinen hier, bis die Person sie annimmt.", "New invitations show here until the person accepts them.")}
              </EmptyState>
            </div>
          )}
        </SettingGroup>
      )}
      {inviting && <InviteSheet onClose={() => setInviting(false)} />}
    </>
  );
}
