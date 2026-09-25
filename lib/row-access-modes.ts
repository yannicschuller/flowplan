// Client-safe list of record access modes (see lib/row-access.ts).
export const rowAccessModes = ["inherit", "readonly", "private"] as const;
export type RowAccessMode = (typeof rowAccessModes)[number];
export const rowAccessLabels: Record<RowAccessMode, string> = {
  inherit: "Wie die Datenbank",
  readonly: "Nur lesen (Ausnahmen unten)",
  private: "Privat (nur Freigegebene)",
};
