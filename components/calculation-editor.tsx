"use client";
import { useT } from "./i18n";
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
  const t = useT();
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
    <Modal open title={t(`Berechnung: ${field.name}`, `Calculation: ${field.name}`)} onClose={onClose}>
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
                t("Die Berechnung konnte nicht gespeichert werden. Deine Auswahl bleibt erhalten.", "The calculation could not be saved. Your choice is kept."),
              );
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          {t("Berechnung", "Calculation")}
          <Select
            aria-label={t("Spaltenberechnung", "Column calculation")}
            value={choice}
            disabled={!editable || busy}
            onChange={(e) => setChoice(e.target.value as typeof choice)}
          >
            {["auto", "none", ...calculationOptions(field)].map((option) => (
              <option key={option} value={option}>
                {t(calculationName(option as typeof choice))}
              </option>
            ))}
          </Select>
        </label>
        <p className="muted">
          {t("Gilt nur für diese Ansicht. Suche und Filter bestimmen die einbezogenen Einträge; eingeklappte Gruppen bleiben enthalten.", "Applies to this view only. Search and filters decide which records are included; collapsed groups stay included.")}
        </p>
        <div
          className="calculation-preview"
          aria-label={t("Berechnungsvorschau", "Calculation preview")}
          role="region"
        >
          <small>{rows.length} {t("Einträge", "records")}</small>
          <output aria-label={t("Berechnungsergebnis", "Calculation result")}>
            {result ? summaryText(result, undefined, t) : t("Keine Berechnung", "No calculation")}
          </output>
          {!!result?.errors && (
            <small>
              {t("Fehlerhafte oder ungeeignete Werte wurden nicht berücksichtigt.", "Faulty or unsuitable values were left out.")}
            </small>
          )}
        </div>
        {choice === "auto" && (
          <p className="muted">
            {t("Automatisch zeigt die Summe für Zahlenspalten und numerische Formeln oder Rollups.", "Automatic shows the sum for number columns and numeric formulas or rollups.")}
          </p>
        )}
        {["earliest_date", "latest_date", "date_range"].includes(choice) && (
          <p className="muted">
            {t("Zeitpunkte werden in UTC verglichen. Der Zeitraum zählt tatsächlich verstrichene Tage.", "Times are compared in UTC. The range counts days actually elapsed.")}
          </p>
        )}
        {(error || version !== currentVersion) && (
          <p className="error" role="alert">
            {version !== currentVersion
              ? t("Die Ansicht wurde zwischenzeitlich geändert. Deine Auswahl bleibt erhalten. Schließe den Dialog und öffne ihn erneut, um den aktuellen Stand zu bearbeiten.", "The view was changed in the meantime. Your choice is kept. Close the dialog and open it again to edit the current state.")
              : error}
          </p>
        )}
        {editable && (
          <div className="modal-actions">
            <button className="button primary" disabled={busy}>
              {t("Speichern", "Save")}
            </button>
          </div>
        )}
      </form>
    </Modal>
  );
}
