"use client";
import { useT } from "./i18n";
import { Select } from "./select";
import { useState } from "react";
import {
  rowAccessLabels,
  rowAccessModes,
  type RowAccessMode,
} from "@/lib/row-access-modes";
import type { Row, User } from "@/lib/types";

type Grant = { userId?: string; groupId?: string; role: "viewer" | "editor" };

// Record permissions: read-only or private records with exceptions for
// people and groups. Shown to database owners and the record's creator.
export const rowAccessSummary = (row: Row, t: (de: string, en: string) => string = (de) => de) =>
  (row.access || "inherit") === "inherit"
    ? t("Rechte wie Datenbank", "Same as database")
    : row.access === "private"
      ? t("Privater Eintrag", "Private record")
      : t("Schreibgeschützter Eintrag", "Read-only record");

// The panel; the button that opens it sits in the record's header.
export function RowAccess({
  row,
  members,
  groups,
  act,
}: {
  row: Row;
  members: User[];
  groups: { id: string; name: string }[];
  act: (b: Record<string, unknown>) => Promise<unknown>;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false),
    [access, setAccess] = useState<RowAccessMode>(row.access || "inherit"),
    [grants, setGrants] = useState<Grant[]>(
      (row.grants || []).map((g) => ({
        ...(g.user_id ? { userId: g.user_id } : { groupId: g.group_id }),
        role: g.role,
      })),
    ),
    [status, setStatus] = useState("");
  const key = (g: Grant) => (g.userId ? `u:${g.userId}` : `g:${g.groupId}`);
  const name = (g: Grant) =>
    g.userId
      ? members.find((m) => m.id === g.userId)?.name || t("Unbekannt", "Unknown")
      : t(`Gruppe ${groups.find((x) => x.id === g.groupId)?.name || "?"}`, `Group ${groups.find((x) => x.id === g.groupId)?.name || "?"}`);
  const candidates = [
    ...members
      .filter((m) => !grants.some((g) => g.userId === m.id))
      .map((m) => ({ value: `u:${m.id}`, label: m.name })),
    ...groups
      .filter((x) => !grants.some((g) => g.groupId === x.id))
      .map((x) => ({ value: `g:${x.id}`, label: t(`Gruppe ${x.name}`, `Group ${x.name}`) })),
  ];
  async function save() {
    setBusy(true);
    setStatus("");
    const result = await act({
      action: "row.access",
      rowId: row.id,
      access,
      grants: access === "inherit" ? [] : grants,
    });
    setBusy(false);
    if (result) setStatus(t("Rechte gespeichert", "Permissions saved"));
  }
  return (
    <div className="row-access">
      {(
        <div
          className="row-access-panel"
          role="group"
          aria-label={t("Eintragsrechte", "Record permissions")}
        >
          <label>
            {t("Zugriff", "Access")}
            <Select
              value={access}
              disabled={busy}
              onChange={(e) => setAccess(e.target.value as RowAccessMode)}
            >
              {rowAccessModes.map((mode) => (
                <option key={mode} value={mode}>
                  {t(rowAccessLabels[mode])}
                </option>
              ))}
            </Select>
          </label>
          {access !== "inherit" && (
            <>
              <p className="muted">
                {access === "private"
                  ? t("Nur Besitzer der Datenbank, wer den Eintrag angelegt hat und die Freigaben unten sehen ihn.", "Only the database's owners, whoever created the record and the shares below see it.")
                  : t("Alle mit Zugriff auf die Datenbank sehen den Eintrag; ändern dürfen ihn nur Besitzer, wer ihn angelegt hat und Freigaben mit „Bearbeiten“.", "Everyone with access to the database sees the record; only owners, whoever created it and shares with “Edit” may change it.")}{" "}
                {t("Freigaben gehen nie über die Rechte an der Datenbank hinaus.", "Shares never go beyond the permissions on the database.")}
              </p>
              {grants.map((g) => (
                <div className="row-access-grant" key={key(g)}>
                  <span>{name(g)}</span>
                  <Select
                    aria-label={t(`Recht für ${name(g)}`, `Permission for ${name(g)}`)}
                    value={g.role}
                    disabled={busy}
                    onChange={(e) =>
                      setGrants(
                        grants.map((x) =>
                          key(x) === key(g)
                            ? { ...x, role: e.target.value as Grant["role"] }
                            : x,
                        ),
                      )
                    }
                  >
                    <option value="viewer">{t("Ansehen", "View")}</option>
                    <option value="editor">{t("Bearbeiten", "Edit")}</option>
                  </Select>
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    aria-label={t(`Freigabe für ${name(g)} entfernen`, `Remove share for ${name(g)}`)}
                    onClick={() =>
                      setGrants(grants.filter((x) => key(x) !== key(g)))
                    }
                  >
                    {t("Entfernen", "Remove")}
                  </button>
                </div>
              ))}
              {candidates.length > 0 && (
                <Select
                  aria-label={t("Person oder Gruppe freigeben", "Share with a person or group")}
                  value=""
                  disabled={busy}
                  onChange={(e) => {
                    const [kind, value] = e.target.value.split(":");
                    if (value)
                      setGrants([
                        ...grants,
                        kind === "u"
                          ? { userId: value, role: "viewer" }
                          : { groupId: value, role: "viewer" },
                      ]);
                  }}
                >
                  <option value="">{t("Person oder Gruppe hinzufügen …", "Add person or group …")}</option>
                  {candidates.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </Select>
              )}
            </>
          )}
          <div className="row-access-actions">
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={() => void save()}
            >
              {t("Rechte speichern", "Save permissions")}
            </button>
            {status && <span role="status">{status}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
