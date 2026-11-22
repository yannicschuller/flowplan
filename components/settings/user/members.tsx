"use client";
// Settings → Arbeitsbereich → Mitglieder: the people of the workspace with
// their role and badges (guest, SSO), the invitations still open, the
// invitation links for several people (#320) and the invitation itself in
// a sheet.
import { useState } from "react";
import { Copy, EnvelopeSimple, LinkSimple, Plus, UserPlus, X } from "@phosphor-icons/react";
import { LOCALE_TAG } from "@/lib/locale-tag";
import type { Bootstrap } from "@/lib/types";
import { useT } from "../../i18n";
import { Avatar, Modal } from "../../ui";
import { showToast } from "../../toast";
import { Select } from "../../select";
import { EmptyState, SaveState, SettingGroup, StatusBadge, useSaveState } from "../../settings-ui";
import { useUserSettings, type InviteLinkRow, type WorkspaceSettingsData } from "../user-context";
import { useSsoVia } from "./sso-via";

type Member = Bootstrap["members"][number];
type Invite = WorkspaceSettingsData["invites"][number];

function useRoleName() {
  const t = useT();
  return (role: string) => (role === "owner" ? t("Eigentümer", "Owner") : role === "editor" ? t("Bearbeiten", "Edit") : role === "viewer" ? t("Ansehen", "View||role") : role);
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
              if (changed && role !== "remove" && via) showToast({ text: ssoNotice });
            }}
          >
            <option value="owner">{t("Eigentümer", "Owner")}</option>
            <option value="editor">{t("Bearbeiten", "Edit")}</option>
            <option value="viewer">{t("Ansehen", "View||role")}</option>
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
              if (await act({ action: "invite.resend", inviteId: i.id })) showToast({ text: t(`Einladung an ${i.email} erneut gesendet.`, `Invitation sent to ${i.email} again.`) });
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
                showToast({ text: t("Einladungslink kopiert.", "Invitation link copied.") });
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

// Copies a link; where the clipboard is refused, the link shows as the error.
function useCopyLink() {
  const t = useT();
  const { onError } = useUserSettings();
  return async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      showToast({ text: t("Einladungslink kopiert.", "Invitation link copied.") });
    } catch {
      onError(url);
    }
  };
}

function InviteLinkItem({ link: l }: { link: InviteLinkRow }) {
  const t = useT();
  const roleName = useRoleName();
  const { act } = useUserSettings();
  const copy = useCopyLink();
  const until = new Date(l.expiresAt).toLocaleString(LOCALE_TAG, { dateStyle: "medium", timeStyle: "short" });
  return (
    <li className="ws-item ws-invite" data-invite-link={l.id}>
      <span className="ws-item-icon" aria-hidden>
        <LinkSimple size={18} />
      </span>
      <div className="ws-item-text">
        <strong>{t("Einladungslink", "Invite link")}</strong>
        <span className="ws-badges">
          {l.usedUp ? <StatusBadge tone="warn">{t("Ausgeschöpft", "Used up")}</StatusBadge> : <StatusBadge tone="ok">{t("Aktiv", "Active")}</StatusBadge>}
          <StatusBadge tone="off">{roleName(l.role)}</StatusBadge>
          {l.guest && <StatusBadge tone="off">{t("Gast", "Guest")}</StatusBadge>}
        </span>
        <small data-invite-link-uses>
          {[
            l.maxUses ? t(`${l.uses} von ${l.maxUses} Beitritten`, `${l.uses} of ${l.maxUses} joins`) : t(`${l.uses} Beitritte`, `${l.uses} joins`),
            t(`gültig bis ${until}`, `valid until ${until}`),
            l.creator ? t(`von ${l.creator}`, `by ${l.creator}`) : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </small>
      </div>
      <div className="ws-item-controls">
        {l.url && (
          <button type="button" className="button" onClick={() => void copy(l.url!)}>
            <Copy aria-hidden />
            {t("Kopieren", "Copy")}
          </button>
        )}
        <button
          type="button"
          className="button"
          onClick={async () => {
            if (!confirm(t("Einladungslink zurückziehen? Wer ihn noch hat, kann damit nicht mehr beitreten. Wer schon beigetreten ist, bleibt Mitglied.", "Revoke the invite link? Whoever still has it can no longer join with it. People who already joined stay members."))) return;
            if (await act({ action: "inviteLink.revoke", linkId: l.id })) showToast({ text: t("Einladungslink zurückgezogen.", "Invite link revoked.") });
          }}
        >
          {t("Zurückziehen", "Revoke")}
        </button>
      </div>
    </li>
  );
}

function InviteLinkSheet({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { boot, mutate, reload, onError } = useUserSettings();
  const copy = useCopyLink();
  const [role, setRole] = useState("editor"),
    [guest, setGuest] = useState(false),
    [expires, setExpires] = useState("7d"),
    [maxUses, setMaxUses] = useState(""),
    [busy, setBusy] = useState(false),
    [created, setCreated] = useState<string | null>(null);
  return (
    <Modal open sheet className="ws-sheet" title={t("Einladungslink erstellen", "Create invite link")} onClose={() => !busy && onClose()}>
      {created ? (
        <div className="ws-form">
          <div className="ws-field">
            <label htmlFor="invite-link-url">{t("Einladungslink", "Invite link")}</label>
            <input id="invite-link-url" readOnly value={created} onFocus={(e) => e.currentTarget.select()} />
            <small>{t("Wer den Link hat, kann beitreten, solange er gilt. Teile ihn nur mit Personen, die dazugehören sollen.", "Whoever has the link can join while it is valid. Share it only with people who should belong.")}</small>
          </div>
          <div className="modal-actions ws-form-actions">
            <button type="button" className="button" onClick={onClose}>
              {t("Fertig", "Done")}
            </button>
            <button type="button" className="button primary" onClick={() => void copy(created)}>
              <Copy aria-hidden />
              {t("Kopieren", "Copy")}
            </button>
          </div>
        </div>
      ) : (
        <form
          className="ws-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const limit = maxUses.trim() ? Number(maxUses) : null;
              const result = (await mutate({ workspaceId: boot.workspace.id, action: "inviteLink.create", role, guest, expires, maxUses: limit })) as { url: string };
              setCreated(result.url);
              await reload();
            } catch (error) {
              onError((error as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="ws-field">
            <label htmlFor="invite-link-role">{t("Rolle", "Role")}</label>
            <Select id="invite-link-role" value={role} onChange={(e) => setRole(e.target.value)} disabled={busy}>
              <option value="editor">{t("Bearbeiten", "Edit")}</option>
              <option value="viewer">{t("Ansehen", "View||role")}</option>
            </Select>
          </div>
          <label className="ws-check">
            <input type="checkbox" checked={guest} onChange={(e) => setGuest(e.target.checked)} disabled={busy} />
            <span>
              {t("Als Gast beitreten", "Join as a guest")}
              <small>{t("Gäste sehen nur Seiten, die mit ihnen geteilt sind.", "Guests see only pages shared with them.")}</small>
            </span>
          </label>
          <div className="ws-field">
            <label htmlFor="invite-link-expires">{t("Gültig für", "Valid for")}</label>
            <Select id="invite-link-expires" value={expires} onChange={(e) => setExpires(e.target.value)} disabled={busy}>
              <option value="24h">{t("24 Stunden", "24 hours")}</option>
              <option value="7d">{t("7 Tage", "7 days")}</option>
              <option value="30d">{t("30 Tage", "30 days")}</option>
            </Select>
          </div>
          <div className="ws-field">
            <label htmlFor="invite-link-max">{t("Höchstens so viele Beitritte", "At most this many joins")}</label>
            <input id="invite-link-max" type="number" inputMode="numeric" min={1} max={1000} placeholder={t("unbegrenzt", "unlimited")} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} disabled={busy} />
            <small>{t("Leer lassen für beliebig viele, bis der Link abläuft.", "Leave empty for any number until the link expires.")}</small>
          </div>
          <p className="ws-note">
            {t(
              "Wer den Link öffnet, meldet sich an oder registriert sich – auch wenn die Registrierung sonst geschlossen ist – und tritt mit dieser Rolle bei. Du kannst den Link jederzeit zurückziehen.",
              "Whoever opens the link signs in or signs up – even if sign-ups are otherwise closed – and joins with this role. You can revoke the link at any time.",
            )}
          </p>
          <div className="modal-actions ws-form-actions">
            <button type="button" className="button" onClick={onClose} disabled={busy}>
              {t("Abbrechen", "Cancel")}
            </button>
            <button className="button primary" disabled={busy}>
              <LinkSimple aria-hidden />
              {t("Link erstellen", "Create link")}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function InviteSheet({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { boot, act, onRefresh } = useUserSettings();
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
          if (ok) {
            // An account with a confirmed address is a member now (#320):
            // the list of members follows.
            void onRefresh();
            onClose();
          }
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
            <option value="viewer">{t("Ansehen", "View||role")}</option>
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
  const [inviting, setInviting] = useState(false),
    [linking, setLinking] = useState(false);
  const links = settings?.inviteLinks || [];
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
            ? guests === 1
              ? t("Davon 1 Gast – Gäste sehen nur geteilte Seiten.", "1 guest among them – guests see only shared pages.")
              : t(`Davon ${guests} Gäste – Gäste sehen nur geteilte Seiten.`, `${guests} guests among them – guests see only shared pages.`)
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
      {owner && settings && (
        <SettingGroup
          id="invite-links"
          title={t(`Einladungslinks · ${links.length}`, `Invite links · ${links.length}`)}
          description={
            settings.inviteLinksEnabled === false
              ? t("Auf dieser Instanz von der Administration ausgeschaltet.", "Switched off on this instance by the administrators.")
              : t("Ein Link für mehrere Personen – mit Rolle, Ablauf und auf Wunsch einer Höchstzahl an Beitritten.", "One link for several people – with a role, an expiry and, if you like, a maximum number of joins.")
          }
          actions={
            settings.inviteLinksEnabled === false ? undefined : (
              <button type="button" className="button" onClick={() => setLinking(true)}>
                <LinkSimple aria-hidden />
                {t("Einladungslink erstellen", "Create invite link")}
              </button>
            )
          }
        >
          {links.length ? (
            <ul className="ws-list" aria-label={t("Einladungslinks", "Invite links")}>
              {links.map((l) => (
                <InviteLinkItem key={l.id} link={l} />
              ))}
            </ul>
          ) : (
            <div className="setting-row wide">
              <EmptyState icon={<LinkSimple size={20} />} title={t("Keine offenen Einladungslinks", "No open invite links")}>
                {t("Links erscheinen hier, bis sie ablaufen oder du sie zurückziehst.", "Links show here until they expire or you revoke them.")}
              </EmptyState>
            </div>
          )}
        </SettingGroup>
      )}
      {inviting && <InviteSheet onClose={() => setInviting(false)} />}
      {linking && <InviteLinkSheet onClose={() => setLinking(false)} />}
    </>
  );
}
