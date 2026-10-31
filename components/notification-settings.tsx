"use client";
// Settings → Benachrichtigungen: which kinds of notifications reach the
// inbox and, from there, push, e-mail and – where the instance allows any –
// chat apps (lib/messengers.ts). One card; each kind is a row with a switch
// per channel – a matrix with column heads on wide screens, a stacked card
// with labelled switches on phones.
import { useT } from "./i18n";
import { useEffect, useRef, useState } from "react";
import { notificationDefaults, notificationKinds, type NotificationChannels, type NotificationKind, type NotificationPrefs } from "@/lib/notification-kinds";
import { SaveState, SettingGroup, Switch, useSaveState } from "./settings-ui";

// i18n-table: 1 – what each kind is about
const kindHints: Record<NotificationKind, [string, string]> = {
  mention: ["Jemand erwähnt dich mit @ oder weist dir eine Aufgabe zu.", "Someone @mentions you or assigns you a task."],
  share: ["Eine Seite oder ein Arbeitsbereich wurde mit dir geteilt.", "A page or workspace was shared with you."],
  comment: ["Kommentare und Antworten in deinen Unterhaltungen.", "Comments and replies in your conversations."],
  reminder: ["Fällige Aufgaben und Datums-Erinnerungen.", "Due tasks and date reminders."],
  guest: ["Kommentare und Einträge über Freigabelinks und Formulare.", "Comments and records through share links and forms."],
  change: ["Jemand bearbeitet eine Seite, der du folgst – auch eigene Seiten, denen du beim Anlegen folgst.", "Someone edits a page you follow – also your own pages, which you follow when creating them."],
  automation: ["Benachrichtigungen aus Automationen in Datenbanken.", "Notifications from automations in databases."],
  security: ["Jemand gibt mehrmals eine falsche PIN für dein Journal ein.", "Someone enters a wrong PIN for your journal several times."],
};

type Channels = NotificationChannels;

export function NotificationSettings({
  prefs,
  onChange,
  onReset,
  messenger = false,
}: {
  prefs: NotificationPrefs;
  // The chat-app column: when the instance allows at least one chat app.
  messenger?: boolean;
  // Rejects when saving failed; the error is shown next to the switches.
  onReset?: () => Promise<unknown>;
  onChange: (kind: NotificationKind, value: Channels) => Promise<unknown>;
}) {
  const t = useT();
  const [status, run] = useSaveState();
  // Switches react at once; the saved state arrives with the next refresh.
  // While someone is clicking, an answer to an earlier click must not undo
  // later ones: the saved state is taken over only after a quiet moment.
  const [local, setLocal] = useState(prefs);
  const lastChange = useRef(0);
  useEffect(() => {
    if (Date.now() - lastChange.current > 3000) setLocal(prefs);
  }, [prefs]);
  // Saves go out one after the other, so a later click always wins.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const change = (kind: NotificationKind, value: Channels) => {
    lastChange.current = Date.now();
    setLocal((current) => ({ ...current, [kind]: value }));
    const next = queue.current.catch(() => {}).then(() => onChange(kind, value));
    queue.current = next;
    void run(() => next);
  };
  const kinds = Object.keys(notificationKinds) as NotificationKind[];
  const shown = (["inbox", "push", "email", ...(messenger ? (["messenger"] as const) : [])] as const);
  const changed = kinds.some((kind) => shown.some((channel) => local[kind][channel] !== notificationDefaults[kind][channel]));
  const allChannels = [
    { key: "inbox", name: t("Posteingang", "Inbox"), label: (kind: NotificationKind) => t(`${notificationKinds[kind]} im Posteingang`, `${t(notificationKinds[kind])} in the inbox`) },
    { key: "push", name: t("Push", "Push"), label: (kind: NotificationKind) => t(`${notificationKinds[kind]} als Push`, `${t(notificationKinds[kind])} as push`) },
    { key: "email", name: "E-Mail", label: (kind: NotificationKind) => t(`${notificationKinds[kind]} per E-Mail`, `${t(notificationKinds[kind])} by email`) },
    { key: "messenger", name: t("Chat-Apps", "Chat apps"), label: (kind: NotificationKind) => t(`${notificationKinds[kind]} in Chat-Apps`, `${t(notificationKinds[kind])} in chat apps`) },
  ] as const;
  const channels = allChannels.filter((c) => c.key !== "messenger" || messenger);
  return (
    <SettingGroup
      id="kinds"
      title={t("Benachrichtigungsarten", "Notification kinds")}
      description={`${t(
        "Was dich direkt betrifft, kommt standardmäßig überall an; Änderungen an Seiten, denen du folgst, und Automationen nur im Posteingang. Per E-Mail kommt eine Zusammenfassung, wenn eine Benachrichtigung zehn Minuten ungelesen bleibt (geteilte Seiten sofort) – sofern die Instanz E-Mails versenden kann.",
        "What concerns you directly arrives everywhere by default; changes on pages you follow and automations only in the inbox. By e-mail you get a summary when a notification stays unread for ten minutes (shared pages right away) – if the instance can send e-mail.",
      )}${messenger ? ` ${t("Chat-Apps bekommen sie sofort, sobald du unten eine verbunden hast.", "Chat apps get them right away once you connected one below.")}` : ""}`}
      actions={
        <>
          <SaveState status={status} />
          {onReset && changed && (
            <button
              type="button"
              className="button"
              onClick={() => {
                lastChange.current = 0;
                setLocal(notificationDefaults);
                void run(onReset);
              }}
            >
              {t("Auf Standard zurücksetzen", "Reset to defaults")}
            </button>
          )}
        </>
      }
    >
      <div className="notif-matrix" data-columns={channels.length} role="group" aria-label={t("Benachrichtigungsarten", "Notification kinds")}>
        <div className="notif-head" aria-hidden>
          <span>{t("Art", "Kind")}</span>
          {channels.map((c) => (
            <span key={c.key}>{c.name}</span>
          ))}
        </div>
        {kinds.map((kind) => (
          <div className="notif-kind" key={kind}>
            <div className="setting-text">
              <span className="setting-label">{t(notificationKinds[kind])}</span>
              <small>{t(...kindHints[kind])}</small>
            </div>
            {channels.map((c) => (
              <label className="notif-channel" key={c.key}>
                <span className="notif-channel-name">{c.name}</span>
                <Switch
                  label={c.label(kind)}
                  checked={local[kind][c.key]}
                  disabled={c.key !== "inbox" && !local[kind].inbox}
                  onChange={(on) =>
                    change(
                      kind,
                      c.key === "inbox"
                        ? { inbox: on, push: on && local[kind].push, email: on && local[kind].email, messenger: on && local[kind].messenger }
                        : { ...local[kind], [c.key]: on },
                    )
                  }
                />
              </label>
            ))}
          </div>
        ))}
      </div>
    </SettingGroup>
  );
}
