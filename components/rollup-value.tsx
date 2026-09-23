import type { Field } from "@/lib/types";
import { cellText } from "@/lib/database";
import { percentAggregate } from "@/lib/rollups";
const errors: Record<string, string> = {
  "#ACCESS": "Kein Zugriff auf die verknüpfte Datenbank",
  "#PROPERTY": "Verknüpfte Eigenschaft fehlt",
  "#RELATION": "Relation fehlt",
  "#CYCLE": "Zirkuläre Berechnung",
  "#LIMIT": "Berechnung zu komplex",
};
export function RollupValue({
  field,
  value,
}: {
  field: Field;
  value: unknown;
}) {
  if (typeof value === "string" && errors[value])
    return (
      <span className="rollup-error" title={errors[value]}>
        {errors[value]}
      </span>
    );
  if (value === null || value === undefined)
    return <span className="muted">—</span>;
  if (typeof value !== "number") return <span>{cellText(value) || "—"}</span>;
  const percent = percentAggregate(field.aggregate);
  const label = new Intl.NumberFormat("de-DE", {
    maximumFractionDigits: 2,
    ...(percent ? { style: "percent" as const } : {}),
  }).format(value);
  if (!field.rollupDisplay || field.rollupDisplay === "number")
    return <span>{label}</span>;
  const max = percent ? 1 : field.rollupMax || 100,
    progress = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <span className={`rollup-progress rollup-${field.rollupDisplay}`}>
      <span
        role="progressbar"
        aria-label={field.name}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={Math.max(0, Math.min(max, value))}
        aria-valuetext={label}
      >
        {field.rollupDisplay === "ring" ? (
          <svg viewBox="0 0 36 36" aria-hidden="true">
            <circle className="rollup-track" cx="18" cy="18" r="15.9" />
            <circle
              className="rollup-fill"
              cx="18"
              cy="18"
              r="15.9"
              strokeDasharray={`${progress} 100`}
            />
          </svg>
        ) : (
          <span style={{ width: `${progress}%` }} />
        )}
      </span>
      <span>{label}</span>
    </span>
  );
}
