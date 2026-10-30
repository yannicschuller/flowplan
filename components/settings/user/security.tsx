"use client";
// Settings → Sicherheitscheck (GET /api/security, lib/my-security.ts): how
// well one's own account is protected, with the next step for each point;
// what one has shared (links, public pages, people with access to one's
// pages) to close right here; the latest sign-ins and changes; tips that fit
// this account. Anchors: #settings/security/<checks|shared|activity|tips>.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { CheckCircle, Circle, Info, ShieldCheck, ShieldWarning, WarningCircle } from "@phosphor-icons/react";
import type { MySecurity, SecurityCheck } from "@/lib/my-security";
import { securityKinds, type SecurityKind } from "@/lib/security-kinds";
import { settingsHash } from "@/lib/settings-sections";
import { useT } from "../../i18n";
import { api } from "../../ui";
import { EmptyState, ResponsiveTable, SettingGroup, StatusBadge } from "../../settings-ui";
import { useUserSettings } from "../user-context";
import { AdminLoading } from "../shell";
import { ago, dateTime } from "../admin/monitoring-format";

type T = (de: string, en: string) => string;
const account = (anchor: string) => settingsHash({ area: "settings", section: "account", anchor });

export default function SecuritySection() {
  const t = useT();
  const { mutate, onError } = useUserSettings();
  const [data, setData] = useState<MySecurity | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setData(await api<MySecurity>("/api/security"));
    } catch (e) {
      onError((e as Error).message);
    }
  }, [onError]);
  useEffect(() => {
    void load();
  }, [load]);
  // Closing a link or an access: the existing commands, then a fresh check.
  const act = async (body: Record<string, unknown>, question: string) => {
    if (!confirm(question)) return;
    setBusy(true);
    try {
      await mutate(body);
      await load();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!data) return <AdminLoading />;
  return (
    <div className="my-security" aria-busy={busy}>
      <Checks data={data} />
      <Shared data={data} act={act} busy={busy} />
      <Activity data={data} />
      <Tips data={data} />
    </div>
  );
}

/* ---------- The check ---------- */

function checkText(c: SecurityCheck, t: T): { title: string; text: string; link?: [string, string] } {
  const n = c.count ?? 0;
  switch (c.id) {
    case "second-factor":
      return c.state === "ok"
        ? { title: t("Zweiter Faktor ist an", "Second factor is on"), text: t("Ein gestohlenes Passwort allein reicht nicht für dein Konto.", "A stolen password alone is not enough for your account.") }
        : {
            title: t("Zweiten Faktor einschalten", "Turn on a second factor"),
            text: t("Mit einer Authenticator-App oder einem Passkey braucht ein Angreifer mehr als dein Passwort.", "With an authenticator app or a passkey an attacker needs more than your password."),
            link: [account("two-factor"), t("Einrichten", "Set up")],
          };
    case "passkey":
      return c.state === "ok"
        ? { title: n === 1 ? t("1 Passkey eingerichtet", "1 passkey set up") : t(`${n} Passkeys eingerichtet`, `${n} passkeys set up`), text: t("Anmelden ohne Passwort – sicher gegen Phishing.", "Sign in without a password – safe against phishing.") }
        : {
            title: t("Passkey anlegen", "Add a passkey"),
            text: t("Fingerabdruck, Gesicht oder Geräte-PIN statt Passwort. Passkeys lassen sich nicht abfischen.", "Fingerprint, face or device PIN instead of a password. Passkeys cannot be phished."),
            link: [account("passkeys"), t("Passkey anlegen", "Add passkey")],
          };
    case "recovery":
      return c.state === "ok"
        ? { title: t(`${n} Wiederherstellungscodes übrig`, `${n} recovery codes left`), text: t("Damit kommst du hinein, wenn das Telefon fehlt. Bewahre sie getrennt vom Telefon auf.", "They get you in when the phone is missing. Keep them apart from the phone.") }
        : {
            title: n ? t(`Nur noch ${n} Wiederherstellungscodes`, `Only ${n} recovery codes left`) : t("Keine Wiederherstellungscodes mehr", "No recovery codes left"),
            text: t("Erzeuge neue, bevor du sie brauchst.", "Create new ones before you need them."),
            link: [account("two-factor"), t("Neue Codes", "New codes")],
          };
    case "email":
      return { title: t("E-Mail-Adresse bestätigen", "Confirm your e-mail address"), text: t("Ohne bestätigte Adresse kannst du dein Passwort nicht zurücksetzen.", "Without a confirmed address you cannot reset your password."), link: [account("profile"), t("Zum Profil", "To profile")] };
    case "provider":
      return { title: t("Anmeldung über deinen Anbieter", "Sign-in through your provider"), text: t("Passwort, zweiter Faktor und Passkeys richtest du bei deinem Anmeldeanbieter (SSO) ein.", "Password, second factor and passkeys are set up with your sign-in provider (SSO).") };
    case "directory":
      return { title: t("Anmeldung über das Verzeichnis", "Sign-in through the directory"), text: t("Dein Passwort kommt aus dem Firmenverzeichnis (LDAP); geändert wird es dort.", "Your password comes from the company directory (LDAP); it is changed there.") };
    case "devices":
      return c.state === "ok"
        ? { title: t("Alle Geräte in Gebrauch", "All devices in use"), text: t("Kein angemeldetes Gerät ist seit über einem Monat ungenutzt.", "No signed-in device has been unused for over a month.") }
        : {
            title: n === 1 ? t("1 Gerät seit über einem Monat ungenutzt", "1 device unused for over a month") : t(`${n} Geräte seit über einem Monat ungenutzt`, `${n} devices unused for over a month`),
            text: t("Alte Sitzungen auf verkauften oder verlorenen Geräten sind ein offenes Tor. Melde sie ab.", "Old sessions on sold or lost devices are an open door. Sign them out."),
            link: [account("sessions"), t("Geräte ansehen", "See devices")],
          };
    case "tokens":
      return c.state === "ok"
        ? { title: t("API-Tokens sind aufgeräumt", "API tokens are tidy"), text: t("Alle haben ein Ablaufdatum und werden benutzt.", "All have an end date and are in use.") }
        : {
            title: t(`${n} API-Tokens ohne Ablauf oder ungenutzt`, `${n} API tokens without end or unused`),
            text: t("Tokens ohne Ablaufdatum oder seit drei Monaten ungenutzt besser widerrufen.", "Better revoke tokens without an end date or unused for three months."),
            link: [settingsHash({ area: "settings", section: "api" }), t("Tokens ansehen", "See tokens")],
          };
    case "links":
      return c.state === "ok"
        ? { title: t("Bearbeiten-Links sind geschützt", "Edit links are protected"), text: t("Kein Link zum Bearbeiten ist ohne Passwort und Ablaufdatum offen.", "No edit link is open without a password and an end date.") }
        : {
            title: n === 1 ? t("1 Bearbeiten-Link ohne Schutz", "1 edit link without protection") : t(`${n} Bearbeiten-Links ohne Schutz`, `${n} edit links without protection`),
            text: t("Wer den Link hat, kann ändern. Gib ihm ein Passwort oder ein Ablaufdatum – oder lösche ihn unten.", "Whoever has the link can change things. Give it a password or an end date – or delete it below."),
            link: ["#settings/security/shared", t("Zu den Links", "To the links")],
          };
    case "notices":
      return c.state === "ok"
        ? { title: t("Sicherheitshinweise kommen an", "Security notices arrive"), text: t("Neue Anmeldungen und Auffälliges erfährst du per Push oder E-Mail.", "You hear about new sign-ins and anything unusual by push or e-mail.") }
        : {
            title: t("Sicherheitshinweise einschalten", "Turn on security notices"),
            text: t("Bisher landen sie nur im Posteingang – per E-Mail oder Push merkst du eine fremde Anmeldung sofort.", "So far they only reach the inbox – by e-mail or push you notice a strange sign-in right away."),
            link: [settingsHash({ area: "settings", section: "notifications" }), t("Benachrichtigungen", "Notifications")],
          };
    case "failures":
      return c.state === "ok"
        ? { title: t("Keine fehlgeschlagenen Anmeldungen", "No failed sign-ins"), text: t("In den letzten 30 Tagen hat niemand ein falsches Passwort für dein Konto eingegeben.", "Nobody entered a wrong password for your account in the last 30 days.") }
        : {
            title: n === 1 ? t("1 fehlgeschlagene Anmeldung (30 Tage)", "1 failed sign-in (30 days)") : t(`${n} fehlgeschlagene Anmeldungen (30 Tage)`, `${n} failed sign-ins (30 days)`),
            text:
              c.state === "todo"
                ? t("Jemand probiert Passwörter für dein Konto. Ein zweiter Faktor oder Passkey hält ihn draußen.", "Someone is trying passwords for your account. A second factor or a passkey keeps them out.")
                : t("Vermutlich ein Tippfehler – sieh unten nach, wann und woher.", "Probably a typo – see below when and from where."),
            link: ["#settings/security/activity", t("Ansehen", "See")],
          };
  }
  return { title: c.id, text: "" };
}

function Checks({ data }: { data: MySecurity }) {
  const t = useT();
  const scored = data.checks.filter((c) => c.state !== "info");
  const done = scored.filter((c) => c.state === "ok").length;
  const share = scored.length ? done / scored.length : 1;
  const todo = scored.length - done;
  const order = [...data.checks].sort((a, b) => Number(a.state === "ok") - Number(b.state === "ok"));
  return (
    <>
      <div className={`security-verdict ${share === 1 ? "ok" : share >= 0.6 ? "warn" : "error"}`} role="status">
        {share === 1 ? <ShieldCheck size={28} aria-hidden /> : <ShieldWarning size={28} aria-hidden />}
        <div>
          <strong>
            {share === 1
              ? t("Dein Konto ist gut geschützt", "Your account is well protected")
              : todo === 1
                ? t("1 Punkt ist noch offen", "1 point is still open")
                : t(`${todo} Punkte sind noch offen`, `${todo} points are still open`)}
          </strong>
          <span>{t(`${done} von ${scored.length} erledigt`, `${done} of ${scored.length} done`)}</span>
          <div className="my-security-meter" role="progressbar" aria-valuemin={0} aria-valuemax={scored.length} aria-valuenow={done} aria-label={t("Erledigt", "Done")}>
            <i style={{ width: `${Math.round(share * 100)}%` }} />
          </div>
        </div>
      </div>
      <SettingGroup id="checks" title={t("Sicherheitscheck", "Security check")} description={t("Zugeschnitten auf dein Konto. Offene Punkte stehen oben.", "Tailored to your account. Open points come first.")}>
        <ul className="my-security-checks">
          {order.map((c) => {
            const text = checkText(c, t);
            return (
              <li key={c.id} className={c.state}>
                {c.state === "ok" ? <CheckCircle size={22} weight="fill" aria-hidden /> : c.state === "info" ? <Info size={22} aria-hidden /> : <Circle size={22} aria-hidden />}
                <div>
                  <strong>{text.title}</strong>
                  <small>{text.text}</small>
                </div>
                {text.link && c.state !== "ok" && (
                  <a className="button" href={text.link[0]}>
                    {text.link[1]}
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      </SettingGroup>
    </>
  );
}

/* ---------- What you shared ---------- */

type Act = (body: Record<string, unknown>, question: string) => Promise<void>;

function Shared({ data, act, busy }: { data: MySecurity; act: Act; busy: boolean }) {
  const t = useT();
  const roles: Record<string, string> = { editor: t("bearbeiten", "edit"), commenter: t("kommentieren", "comment"), viewer: t("ansehen", "view") };
  const page = (id: string, title: string) => <a href={`#page=${id}`}>{title || t("Ohne Titel", "Untitled")}</a>;
  const nothing = !data.links.length && !data.published.length && !data.people.length;
  return (
    <SettingGroup id="shared" title={t("Was du geteilt hast", "What you shared")} description={t("Links, öffentliche Seiten und Personen mit eigenem Zugriff auf Seiten, die du angelegt hast. Was nicht mehr gebraucht wird, schließt du hier.", "Links, public pages and people with their own access to pages you created. Close what is no longer needed here.")}>
      {nothing && (
        <EmptyState icon={<ShieldCheck size={20} />} title={t("Nichts geteilt", "Nothing shared")}>
          {t("Du hast keine Freigabelinks, öffentlichen Seiten oder einzeln geteilten Seiten.", "You have no share links, public pages or individually shared pages.")}
        </EmptyState>
      )}
      {!!data.links.length && (
        <>
          <h3 className="security-sub">{t(`Freigabelinks (${data.links.length})`, `Share links (${data.links.length})`)}</h3>
          <ResponsiveTable
            label={t("Freigabelinks", "Share links")}
            rows={data.links}
            rowKey={(l) => l.token}
            columns={[
              { key: "page", header: t("Seite", "Page"), primary: true, render: (l) => page(l.pageId, l.page) },
              { key: "name", header: t("Link", "Link"), render: (l) => l.name + (l.subpages ? t(" · mit Unterseiten", " · with subpages") : "") },
              { key: "role", header: t("Recht", "Right"), render: (l) => (l.role === "editor" ? <StatusBadge tone="warn">{roles.editor}</StatusBadge> : roles[l.role] || l.role) },
              {
                key: "protection",
                header: t("Schutz", "Protection"),
                render: (l) =>
                  l.password || l.expiresAt ? (
                    [l.password && t("Passwort", "Password"), l.expiresAt && t(`bis ${dateTime(l.expiresAt)}`, `until ${dateTime(l.expiresAt)}`)].filter(Boolean).join(" · ")
                  ) : (
                    <StatusBadge tone={l.role === "editor" ? "warn" : "off"}>{t("ohne", "none")}</StatusBadge>
                  ),
              },
              {
                key: "action",
                header: "",
                render: (l) => (
                  <button type="button" className="text-button danger" disabled={busy} onClick={() => void act({ action: "share.revoke", pageId: l.pageId, token: l.token }, t(`Den Link „${l.name}“ löschen? Wer ihn hat, kommt nicht mehr hinein.`, `Delete the link “${l.name}”? Whoever has it can no longer get in.`))}>
                    {t("Löschen", "Delete")}
                  </button>
                ),
              },
            ]}
          />
        </>
      )}
      {!!data.published.length && (
        <>
          <h3 className="security-sub">{t(`Öffentliche Seiten (${data.published.length})`, `Public pages (${data.published.length})`)}</h3>
          <ResponsiveTable
            label={t("Öffentliche Seiten", "Public pages")}
            rows={data.published}
            rowKey={(p) => p.pageId}
            columns={[
              { key: "page", header: t("Seite", "Page"), primary: true, render: (p) => page(p.pageId, p.page) },
              {
                key: "action",
                header: "",
                render: (p) => (
                  <button type="button" className="text-button danger" disabled={busy} onClick={() => void act({ action: "page.publish", pageId: p.pageId, enabled: false }, t(`„${p.page}“ nicht mehr veröffentlichen? Die öffentliche Adresse funktioniert dann nicht mehr.`, `Stop publishing “${p.page}”? The public address stops working.`))}>
                    {t("Veröffentlichung beenden", "Stop publishing")}
                  </button>
                ),
              },
            ]}
          />
        </>
      )}
      {!!data.people.length && (
        <>
          <h3 className="security-sub">{t(`Personen mit Zugriff auf deine Seiten (${data.people.length})`, `People with access to your pages (${data.people.length})`)}</h3>
          <ResponsiveTable
            label={t("Personen mit Zugriff", "People with access")}
            rows={data.people}
            rowKey={(p) => `${p.pageId}:${p.userId || p.email}`}
            columns={[
              { key: "who", header: t("Person", "Person"), primary: true, render: (p) => <span>{p.name || p.email} {p.guest && <StatusBadge tone="info">{p.pending ? t("eingeladen", "invited") : t("Gast", "Guest")}</StatusBadge>}</span> },
              { key: "page", header: t("Seite", "Page"), render: (p) => page(p.pageId, p.page) },
              { key: "role", header: t("Recht", "Right"), render: (p) => roles[p.role] || p.role },
              {
                key: "action",
                header: "",
                render: (p) => (
                  <button
                    type="button"
                    className="text-button danger"
                    disabled={busy}
                    onClick={() =>
                      void act(
                        { action: "page.shareUpdate", pageId: p.pageId, role: "remove", ...(p.userId ? { userId: p.userId } : { email: p.email }) },
                        t(`${p.name || p.email} den Zugriff auf „${p.page}“ entziehen?`, `Remove the access of ${p.name || p.email} to “${p.page}”?`),
                      )
                    }
                  >
                    {t("Entfernen", "Remove")}
                  </button>
                ),
              },
            ]}
          />
        </>
      )}
    </SettingGroup>
  );
}

/* ---------- Sign-ins and changes ---------- */

function Activity({ data }: { data: MySecurity }) {
  const t = useT();
  const title = (kind: string) => {
    const k = securityKinds[kind as SecurityKind];
    return k ? t(k.de, k.en) : kind;
  };
  return (
    <SettingGroup
      id="activity"
      title={t("Anmeldungen & Änderungen", "Sign-ins & changes")}
      description={t("Die letzten 30 Tage. Etwas, das du nicht warst? Ändere dein Passwort und melde unter Geräte alle anderen ab.", "The last 30 days. Something that was not you? Change your password and sign out all others under Devices.")}
      actions={
        <a className="button" href={account("sessions")}>
          {t("Geräte", "Devices")}
        </a>
      }
    >
      <ResponsiveTable
        label={t("Anmeldungen & Änderungen", "Sign-ins & changes")}
        rows={data.activity}
        rowKey={(e) => String(e.id)}
        empty={<p className="muted">{t("Noch nichts aufgezeichnet.", "Nothing recorded yet.")}</p>}
        columns={[
          { key: "at", header: t("Wann", "When"), render: (e) => <span title={dateTime(e.at)}>{ago(e.at, t)}</span> },
          {
            key: "kind",
            header: t("Was", "What"),
            primary: true,
            render: (e) => (
              <span className="security-event-kind">
                {e.kind === "login.failure" || e.kind === "login.refused" ? <WarningCircle size={16} className="my-security-warn" aria-hidden /> : null}
                {title(e.kind)}
              </span>
            ),
          },
          { key: "where", header: t("Woher", "From"), render: (e) => [e.device, e.network, e.country].filter(Boolean).join(" · ") || "–" },
        ]}
      />
    </SettingGroup>
  );
}

/* ---------- Tips ---------- */

function Tips({ data }: { data: MySecurity }) {
  const t = useT();
  const tips: ReactNode[] = [];
  if (data.account.kind === "local")
    tips.push(t("Nutze einen Passwortmanager und für Flowplan ein Passwort, das du nirgends sonst verwendest.", "Use a password manager and a password for Flowplan that you use nowhere else."));
  tips.push(t("Teile Seiten lieber mit einzelnen Personen als per Link – dann siehst du, wer Zugriff hat, und kannst ihn gezielt entziehen.", "Prefer sharing pages with people over links – you see who has access and can remove it one by one."));
  tips.push(t("Gib Links zum Bearbeiten immer ein Passwort oder ein Ablaufdatum.", "Always give edit links a password or an end date."));
  if (data.tokens.length) tips.push(t("Gib API-Tokens nur so viel Recht wie nötig (Lesen statt Schreiben) und ein Ablaufdatum.", "Give API tokens only the rights they need (read instead of write) and an end date."));
  tips.push(t("Melde dich auf fremden oder geteilten Geräten ab und lass „Angemeldet bleiben“ dort aus.", "Sign out on other people's or shared devices and leave “Stay signed in” off there."));
  tips.push(t("Flowplan fragt nie per E-Mail oder Chat nach deinem Passwort oder Codes. Gib sie nur auf dieser Seite ein.", "Flowplan never asks for your password or codes by e-mail or chat. Only enter them on this site."));
  return (
    <SettingGroup id="tips" title={t("Tipps", "Tips")}>
      <ul className="my-security-tips">
        {tips.map((tip, i) => (
          <li key={i}>{tip}</li>
        ))}
      </ul>
    </SettingGroup>
  );
}
