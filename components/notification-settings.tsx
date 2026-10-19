"use client";
import { useT } from "./i18n";
import { useEffect, useRef, useState } from "react";
import {
  notificationDefaults,
  notificationKinds,
  type NotificationKind,
  type NotificationPrefs,
} from "@/lib/notification-kinds";

// Which kinds of notifications reach the inbox and, from there, push.
// i18n-table: 1 – what each kind is about
const kindHints: Record<NotificationKind, [string, string]> = {
  mention: ["Jemand erwähnt dich mit @ oder weist dir eine Aufgabe zu.", "Someone @mentions you or assigns you a task."],
  share: ["Eine Seite oder ein Arbeitsbereich wurde mit dir geteilt.", "A page or workspace was shared with you."],
  comment: ["Kommentare und Antworten in deinen Unterhaltungen.", "Comments and replies in your conversations."],
  reminder: ["Fällige Aufgaben und Datums-Erinnerungen.", "Due tasks and date reminders."],
  guest: ["Kommentare und Einträge über Freigabelinks und Formulare.", "Comments and records through share links and forms."],
  change: ["Jemand bearbeitet eine Seite, der du folgst – auch eigene Seiten, denen du beim Anlegen folgst.", "Someone edits a page you follow – also your own pages, which you follow when creating them."],
  automation: ["Benachrichtigungen aus Automationen in Datenbanken.", "Notifications from automations in databases."],
};

export function NotificationSettings({
  prefs,
  onChange,
  onReset,
}: {
  prefs: NotificationPrefs;
  onReset?: () => void;
  onChange: (
    kind: NotificationKind,
    value: { inbox: boolean; push: boolean; email: boolean },
  ) => void;
}) {
  const t = useT();
  // Checkboxes react at once; the saved state arrives with the next refresh.
  // While someone is clicking, an answer to an earlier click must not undo
  // later ones: the saved state is taken over only after a quiet moment.
  const [local, setLocal] = useState(prefs);
  const lastChange = useRef(0);
  useEffect(() => {
    if (Date.now() - lastChange.current > 3000) setLocal(prefs);
  }, [prefs]);
  const change = (
    kind: NotificationKind,
    value: { inbox: boolean; push: boolean; email: boolean },
  ) => {
    lastChange.current = Date.now();
    setLocal((current) => ({ ...current, [kind]: value }));
    onChange(kind, value);
  };
  return (
    <section className="settings-section">
      <h2>{t("Benachrichtigungsarten", "Notification kinds")}</h2>
      <p className="muted">
        {t(
          "Was dich direkt betrifft, kommt standardmäßig überall an; Änderungen an Seiten, denen du folgst, und Automationen nur im Posteingang. Per E-Mail kommt eine Zusammenfassung, wenn eine Benachrichtigung zehn Minuten ungelesen bleibt (geteilte Seiten sofort) – sofern die Instanz E-Mails versenden kann.",
          "What concerns you directly arrives everywhere by default; changes on pages you follow and automations only in the inbox. By e-mail you get a summary when a notification stays unread for ten minutes (shared pages right away) – if the instance can send e-mail.",
        )}
      </p>
      <table className="notification-prefs">
        <thead>
          <tr>
            <th>{t("Art", "Kind")}</th>
            <th>{t("Posteingang", "Inbox")}</th>
            <th>{t("Push", "Push")}</th>
            <th>E-Mail</th>
          </tr>
        </thead>
        <tbody>
          {(Object.keys(notificationKinds) as NotificationKind[]).map(
            (kind) => (
              <tr key={kind}>
                <td>
                  {t(notificationKinds[kind])}
                  <small className="notification-hint">{t(...kindHints[kind])}</small>
                </td>
                <td>
                  <input
                    type="checkbox"
                    aria-label={t(`${notificationKinds[kind]} im Posteingang`, `${t(notificationKinds[kind])} in the inbox`)}
                    checked={local[kind].inbox}
                    onChange={(e) =>
                      change(kind, {
                        inbox: e.target.checked,
                        push: e.target.checked && local[kind].push,
                        email: e.target.checked && local[kind].email,
                      })
                    }
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    aria-label={t(`${notificationKinds[kind]} als Push`, `${t(notificationKinds[kind])} as push`)}
                    checked={local[kind].push}
                    disabled={!local[kind].inbox}
                    onChange={(e) =>
                      change(kind, {
                        inbox: local[kind].inbox,
                        push: e.target.checked,
                        email: local[kind].email,
                      })
                    }
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    aria-label={t(`${notificationKinds[kind]} per E-Mail`, `${t(notificationKinds[kind])} by email`)}
                    checked={local[kind].email}
                    disabled={!local[kind].inbox}
                    onChange={(e) =>
                      change(kind, {
                        inbox: local[kind].inbox,
                        push: local[kind].push,
                        email: e.target.checked,
                      })
                    }
                  />
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
      {onReset &&
        (Object.keys(notificationKinds) as NotificationKind[]).some((kind) =>
          (["inbox", "push", "email"] as const).some((channel) => local[kind][channel] !== notificationDefaults[kind][channel]),
        ) && (
          <button
            type="button"
            className="button"
            onClick={() => {
              lastChange.current = 0;
              setLocal(notificationDefaults);
              onReset();
            }}
          >
            {t("Auf Standard zurücksetzen", "Reset to defaults")}
          </button>
        )}
    </section>
  );
}
