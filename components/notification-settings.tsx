"use client";
import { useEffect, useState } from "react";
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
    value: { inbox: boolean; push: boolean },
  ) => void;
}) {
  // Checkboxes react at once; the saved state arrives with the next refresh.
  const [local, setLocal] = useState(prefs);
  useEffect(() => setLocal(prefs), [prefs]);
  const change = (
    kind: NotificationKind,
    value: { inbox: boolean; push: boolean },
  ) => {
    setLocal((current) => ({ ...current, [kind]: value }));
    onChange(kind, value);
  };
  return (
    <section className="settings-section">
      <h2>Benachrichtigungsarten</h2>
      <p className="muted">
        Ausgeschaltete Arten erscheinen weder im Posteingang noch als Push.
      </p>
      <table className="notification-prefs">
        <thead>
          <tr>
            <th>Art</th>
            <th>Posteingang</th>
            <th>Push</th>
          </tr>
        </thead>
        <tbody>
          {(Object.keys(notificationKinds) as NotificationKind[]).map(
            (kind) => (
              <tr key={kind}>
                <td>{notificationKinds[kind]}</td>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`${notificationKinds[kind]} im Posteingang`}
                    checked={local[kind].inbox}
                    onChange={(e) =>
                      change(kind, {
                        inbox: e.target.checked,
                        push: e.target.checked && local[kind].push,
                      })
                    }
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`${notificationKinds[kind]} als Push`}
                    checked={local[kind].push}
                    disabled={!local[kind].inbox}
                    onChange={(e) =>
                      change(kind, {
                        inbox: local[kind].inbox,
                        push: e.target.checked,
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
