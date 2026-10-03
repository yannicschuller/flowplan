"use client";
import { useT } from "./i18n";
import { useEffect, useRef, useState } from "react";
import {
  notificationKinds,
  type NotificationKind,
  type NotificationPrefs,
} from "@/lib/notification-kinds";

// Which kinds of notifications reach the inbox and, from there, push.
export function NotificationSettings({
  prefs,
  onChange,
}: {
  prefs: NotificationPrefs;
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
        {t("Ausgeschaltete Arten erscheinen weder im Posteingang noch als Push. Per E-Mail kommt eine Zusammenfassung, wenn eine Benachrichtigung zehn Minuten ungelesen bleibt – sofern die Instanz E-Mails versenden kann.", "Kinds turned off appear neither in the inbox nor as push. By email you get a digest when a notification stays unread for ten minutes – if the instance can send email.")}
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
                <td>{t(notificationKinds[kind])}</td>
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
    </section>
  );
}
