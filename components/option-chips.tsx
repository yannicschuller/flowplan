// Values of select and multi-select properties on published and shared
// pages (#242): as chips once the property has colours of its own; without
// them as text, as before. No hooks: rendered on the server too.
import { choiceChipClass, hasOwnOptions } from "@/lib/option-colors";
import type { Field } from "@/lib/types";

export function coloredChoices(f: Field, value: unknown) {
  if (!hasOwnOptions(f) || !f.optionColors || !Object.keys(f.optionColors).length) return null;
  const values = (Array.isArray(value) ? value : [value]).filter((v) => v !== null && v !== undefined && String(v).trim()).map(String);
  if (!values.length) return null;
  return (
    <span className="tags">
      {values.map((v, i) => (
        <span key={v + i} className={choiceChipClass(f, v)}>
          {v}
        </span>
      ))}
    </span>
  );
}
