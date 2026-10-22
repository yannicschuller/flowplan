"use client";
// Settings → Arbeitsbereich → Mitglieder: roles, guests, invitations.
import { useState } from "react";
import { EnvelopeSimple, Plus, X } from "@phosphor-icons/react";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useT } from "../../i18n";
import { Avatar } from "../../ui";
import { Select } from "../../select";
import { useUserSettings } from "../user-context";
import { useSsoVia } from "./sso-via";

export default function MembersSection() {
  const t = useT();
  const { boot, owner, workspace: settings, act, onError } = useUserSettings();
  const { ssoVia, ssoNotice } = useSsoVia();
  const [email, setEmail] = useState(""),
    [role, setRole] = useState("editor"),
    [inviteGuest, setInviteGuest] = useState(false);
  return (
    <>
      <section className="settings-section">
        <h2>{t("Mitglieder ·", "Members ·")}{" "}{boot.members.length}</h2>
        {boot.members.map((m) => (
          <div className="member-row" key={m.id}>
            <Avatar name={m.name} userId={m.id} />
            <span>
              {m.name}
              {!!m.guest && <span className="tag tag-yellow">{t("Gast", "Guest")}</span>}
              {(() => {
                const via = ssoVia(m.id, "");
                return via ? (
                  <span className="tag" title={t("Diese Mitgliedschaft wird über die SSO-Gruppen verwaltet. Eine Änderung hier gilt nur bis zur nächsten SSO-Anmeldung der Person – dann setzt die Zuordnung die Rolle wieder.", "This membership is managed through SSO groups. A change here lasts only until the person's next SSO sign-in – then the mapping sets the role again.")}>
                    {t(`über SSO-Gruppe „${via}“`, `via SSO group “${via}”`)}
                  </span>
                ) : null;
              })()}
              <small>{m.email}</small>
            </span>
            {owner && m.role !== "owner" && (
              <button
                className="button compact"
                aria-label={m.guest ? t(`${m.name} zum Mitglied machen`, `Make ${m.name} a member`) : t(`${m.name} zum Gast machen`, `Make ${m.name} a guest`)}
                onClick={() => act({ action: "member.guest", userId: m.id, guest: !m.guest })}
              >
                {m.guest ? t("Zum Mitglied machen", "Make member") : t("Zum Gast machen", "Make guest")}
              </button>
            )}
            {owner ? (
              <Select
                aria-label={t(`Rolle für ${m.name}`, `Role for ${m.name}`)}
                value={m.role}
                onChange={async (e) => {
                  const changed = await act({ action: "member.role", userId: m.id, role: e.target.value });
                  if (changed && e.target.value !== "remove" && ssoVia(m.id, "")) onError(ssoNotice);
                }}
              >
                <option value="owner">{t("Eigentümer", "Owner")}</option>
                <option value="editor">{t("Bearbeiten", "Edit")}</option>
                <option value="viewer">{t("Ansehen", "View")}</option>
                <option value="remove">{t("Entfernen", "Remove")}</option>
              </Select>
            ) : (
              <span className="tag">{m.role}</span>
            )}
          </div>
        ))}
      </section>
      {owner && (
        <section className="settings-section">
          <h2>{t("Mitglied einladen", "Invite member")}</h2>
          <p className="muted">
            {boot.instance?.mail
              ? t(
                  "Die Person bekommt eine Einladung per E-Mail. Mit einem bestehenden Konto sieht sie den Arbeitsbereich beim nächsten Öffnen von Flowplan, sonst nach der Registrierung mit dieser Adresse – auch wenn die Registrierung sonst geschlossen ist.",
                  "The person gets an invitation by e-mail. With an existing account they see the workspace the next time they open Flowplan, otherwise after signing up with this address – even if sign-ups are otherwise closed.",
                )
              : t(
                  "Auf dieser Instanz werden keine E-Mails verschickt: Kopiere bei der Einladung unten den Link und schick ihn der Person. Wer ihn angemeldet öffnet (oder sich darüber registriert), nimmt die Einladung an.",
                  "This instance sends no e-mail: copy the link of the invitation below and send it to the person. Whoever opens it signed in (or signs up through it) takes the invitation.",
                )}
          </p>
          <form
            className="invite-form"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await act({ action: "member.invite", email, role, guest: inviteGuest })) setEmail("");
            }}
          >
            <input
              required
              type="email"
              placeholder={t("name@unternehmen.de", "name@company.com")}
              aria-label={t("E-Mail des neuen Mitglieds", "E-mail of the new member")}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Select value={role} aria-label={t("Rolle", "Role")} onChange={(e) => setRole(e.target.value)}>
              <option value="editor">{t("Bearbeiten", "Edit")}</option>
              <option value="viewer">{t("Ansehen", "View")}</option>
            </Select>
            <label className="checkbox-label">
              <input type="checkbox" checked={inviteGuest} onChange={(e) => setInviteGuest(e.target.checked)} />
              {t("Als Gast (nur freigegebene Seiten)", "As a guest (shared pages only)")}
            </label>
            <button className="button primary">
              <Plus />
              {t("Einladen", "Invite")}
            </button>
          </form>
          {!!settings?.invites.length && (
            <div className="pending-invites">
              <h3>{t("Ausstehende Einladungen", "Pending invitations")}</h3>
              {settings.invites.map((i) => (
                <div className="member-row pending-invite" key={i.id}>
                  <span className="pending-invite-icon" aria-hidden>
                    <EnvelopeSimple size={18} />
                  </span>
                  <span>
                    {i.email}
                    <small>
                      {[
                        i.role === "editor" ? t("Bearbeiten", "Edit") : t("Ansehen", "View"),
                        i.guest ? (i.pages?.length ? t(`Gast für ${i.pages.join(", ")}`, `Guest for ${i.pages.join(", ")}`) : t("Gast", "Guest")) : null,
                        i.created_at ? t(`eingeladen am ${new Date(i.created_at).toLocaleDateString(LOCALE_TAG)}`, `invited on ${new Date(i.created_at).toLocaleDateString(LOCALE_TAG)}`) : null,
                        i.inviter ? t(`von ${i.inviter}`, `by ${i.inviter}`) : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </small>
                  </span>
                  <span className="tag tag-yellow">{t("Ausstehend", "Pending")}</span>
                  {boot.instance?.mail && (
                    <button
                      type="button"
                      className="button compact"
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
                      className="button compact"
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
                    className="icon-button"
                    title={t("Einladung zurückziehen", "Withdraw invitation")}
                    aria-label={t(`Einladung an ${i.email} zurückziehen`, `Withdraw the invitation to ${i.email}`)}
                    onClick={() => void act({ action: "invite.cancel", inviteId: i.id })}
                  >
                    <X size={16} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </>
  );
}
