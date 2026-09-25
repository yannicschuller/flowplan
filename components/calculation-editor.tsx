"use client";
import { Select } from "./select";
import { useState } from "react";
import { Modal } from "./ui";
import {
  calculationName,
  calculationOptions,
  columnSummary,
  summaryText,
  type CalculationChoice,
} from "@/lib/database-summary";
import type { Field, Row } from "@/lib/types";

export default function CalculationEditor({
  field,
  initial,
  rows,
  version,
  currentVersion,
  editable,
  onSave,
  onClose,
}: {
  field: Field;
  initial?: CalculationChoice;
  rows: Row[];
  version: number;
  currentVersion: number;
  editable: boolean;
  onSave: (choice: CalculationChoice | undefined) => Promise<unknown>;
  onClose: () => void;
}) {
  const [choice, setChoice] = useState<CalculationChoice | "auto">(
    initial || "auto",
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const result = columnSummary(
    field,
    rows,
    choice === "auto" ? undefined : choice,
  );
  return (
    <Modal open title={`Berechnung: ${field.name}`} onClose={onClose}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (!editable || busy) return;
          setBusy(true);
          setError("");
          try {
            const saved = await onSave(choice === "auto" ? undefined : choice);
            if (saved) onClose();
            else
              setError(
                "Die Berechnung konnte nicht gespeichert werden. Deine Auswahl bleibt erhalten.",
              );
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Berechnung
          <Select
            aria-label="Spaltenberechnung"
            value={choice}
            disabled={!editable || busy}
            onChange={(e) => setChoice(e.target.value as typeof choice)}
          >
            {["auto", "none", ...calculationOptions(field)].map((option) => (
              <option key={option} value={option}>
                {calculationName(option as typeof choice)}
              </option>
            ))}
          </Select>
        </label>
        <p className="muted">
          Gilt nur für diese Ansicht. Suche und Filter bestimmen die
          einbezogenen Einträge; eingeklappte Gruppen bleiben enthalten.
        </p>
        <div
          className="calculation-preview"
          aria-label="Berechnungsvorschau"
          role="region"
        >
          <small>{rows.length} Einträge</small>
          <output aria-label="Berechnungsergebnis">
            {result ? summaryText(result) : "Keine Berechnung"}
          </output>
          {!!result?.errors && (
            <small>
              Fehlerhafte oder ungeeignete Werte wurden nicht berücksichtigt.
            </small>
          )}
        </div>
        {choice === "auto" && (
          <p className="muted">
            Automatisch zeigt die Summe für Zahlenspalten und numerische Formeln
            oder Rollups.
          </p>
        )}
        {["earliest_date", "latest_date", "date_range"].includes(choice) && (
          <p className="muted">
            Zeitpunkte werden in UTC verglichen. Der Zeitraum zählt tatsächlich
            verstrichene Tage.
          </p>
        )}
        {(error || version !== currentVersion) && (
          <p className="error" role="alert">
            {version !== currentVersion
              ? "Die Ansicht wurde zwischenzeitlich geändert. Deine Auswahl bleibt erhalten. Schließe den Dialog und öffne ihn erneut, um den aktuellen Stand zu bearbeiten."
              : error}
          </p>
        )}
        {editable && (
          <div className="modal-actions">
            <button className="button primary" disabled={busy}>
              Speichern
            </button>
          </div>
        )}
      </form>
    </Modal>
  );
}
