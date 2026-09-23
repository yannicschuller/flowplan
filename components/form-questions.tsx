"use client";
import { CellInput } from "./cell-input";
import { orderedFormFields, type FormConfig } from "@/lib/form-settings";
import type { Field } from "@/lib/types";
export default function FormQuestions({
  fields,
  config,
  values,
  onChange,
  errors = {},
  disabled = false,
}: {
  fields: Field[];
  config: FormConfig;
  values: Record<string, unknown>;
  onChange: (id: string, value: unknown) => void;
  errors?: Record<string, string>;
  disabled?: boolean;
}) {
  return (
    <>
      {orderedFormFields(fields, config).map((f) => (
        <fieldset className="form-question" key={f.id}>
          <legend>
            {f.name}
            {config.requiredFields.includes(f.id) && (
              <span aria-label="Pflichtfeld"> *</span>
            )}
          </legend>
          {config.descriptions[f.id] && (
            <p className="question-description">{config.descriptions[f.id]}</p>
          )}
          <CellInput
            field={f}
            value={values[f.id]}
            members={[]}
            related={{}}
            disabled={disabled}
            commit="change"
            onChange={(v) => onChange(f.id, v)}
          />
          {errors[f.id] && (
            <p className="error field-error" role="alert">
              {errors[f.id]}
            </p>
          )}
        </fieldset>
      ))}
    </>
  );
}
