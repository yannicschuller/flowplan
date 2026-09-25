"use client";
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
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
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
      ? members.find((m) => m.id === g.userId)?.name || "Unbekannt"
      : `Gruppe ${groups.find((x) => x.id === g.groupId)?.name || "?"}`;
  const candidates = [
    ...members
      .filter((m) => !grants.some((g) => g.userId === m.id))
      .map((m) => ({ value: `u:${m.id}`, label: m.name })),
    ...groups
      .filter((x) => !grants.some((g) => g.groupId === x.id))
      .map((x) => ({ value: `g:${x.id}`, label: `Gruppe ${x.name}` })),
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
    if (result) setStatus("Rechte gespeichert");
  }
  const summary =
    (row.access || "inherit") === "inherit"
      ? "Rechte wie Datenbank"
      : row.access === "private"
        ? "Privater Eintrag"
        : "Schreibgeschützter Eintrag";
  return (
    <div className="row-access">
      <button
        type="button"
        className="text-button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {summary} · Rechte des Eintrags
      </button>
      {open && (
        <div
          className="row-access-panel"
          role="group"
          aria-label="Eintragsrechte"
        >
          <label>
            Zugriff
            <Select
              value={access}
              disabled={busy}
              onChange={(e) => setAccess(e.target.value as RowAccessMode)}
            >
              {rowAccessModes.map((mode) => (
                <option key={mode} value={mode}>
                  {rowAccessLabels[mode]}
                </option>
              ))}
            </Select>
          </label>
          {access !== "inherit" && (
            <>
              <p className="muted">
                {access === "private"
                  ? "Nur Besitzer der Datenbank, wer den Eintrag angelegt hat und die Freigaben unten sehen ihn."
                  : "Alle mit Zugriff auf die Datenbank sehen den Eintrag; ändern dürfen ihn nur Besitzer, wer ihn angelegt hat und Freigaben mit „Bearbeiten“."}{" "}
                Freigaben gehen nie über die Rechte an der Datenbank hinaus.
              </p>
              {grants.map((g) => (
                <div className="row-access-grant" key={key(g)}>
                  <span>{name(g)}</span>
                  <Select
                    aria-label={`Recht für ${name(g)}`}
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
                    <option value="viewer">Ansehen</option>
                    <option value="editor">Bearbeiten</option>
                  </Select>
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    aria-label={`Freigabe für ${name(g)} entfernen`}
                    onClick={() =>
                      setGrants(grants.filter((x) => key(x) !== key(g)))
                    }
                  >
                    Entfernen
                  </button>
                </div>
              ))}
              {candidates.length > 0 && (
                <Select
                  aria-label="Person oder Gruppe freigeben"
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
                  <option value="">Person oder Gruppe hinzufügen …</option>
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
              Rechte speichern
            </button>
            {status && <span role="status">{status}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
