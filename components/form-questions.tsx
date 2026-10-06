"use client";
import { useT } from "./i18n";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useState } from "react";
import { CellInput } from "./cell-input";
import {
  FORM_FILE_BYTES,
  FORM_FILES_PER_QUESTION,
  orderedFormFields,
  type FormConfig,
  questionStyle,
  SCALE_MAX,
  SCALE_MIN,
} from "@/lib/form-settings";
import type { Field, Row, User } from "@/lib/types";
export default function FormQuestions({
  fields,
  config,
  values,
  onChange,
  errors = {},
  disabled = false,
  internal = false,
  members = [],
  related = {},
  upload,
}: {
  internal?: boolean;
  members?: { id: string; name: string }[];
  related?: Record<string, { id: string; cells: { title: string } }[]>;
  // With an upload function files are stored right away (in-app preview).
  upload?: (file: File) => Promise<string>;
  fields: Field[];
  config: FormConfig;
  values: Record<string, unknown>;
  onChange: (id: string, value: unknown) => void;
  errors?: Record<string, string>;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <>
      {orderedFormFields(fields, config, internal).map((f) => (
        <fieldset className="form-question" key={f.id}>
          <legend>
            {f.name}
            {config.requiredFields.includes(f.id) && (
              <span aria-label={t("Pflichtfeld", "Required")}> *</span>
            )}
          </legend>
          {config.descriptions[f.id] && (
            <p className="question-description">{config.descriptions[f.id]}</p>
          )}
          {questionStyle(f, config) === "long" ? (
            <textarea
              aria-label={f.name}
              rows={5}
              maxLength={10000}
              disabled={disabled}
              value={
                typeof values[f.id] === "string" ? (values[f.id] as string) : ""
              }
              onChange={(e) => onChange(f.id, e.target.value)}
            />
          ) : questionStyle(f, config) === "buttons" ? (
            <div className="form-choices" role="radiogroup" aria-label={f.name}>
              {(f.options || []).map((option) => (
                <label key={option} className="form-choice">
                  <input
                    type="radio"
                    name={`question-${f.id}`}
                    disabled={disabled}
                    checked={values[f.id] === option}
                    onChange={() => onChange(f.id, option)}
                  />
                  {option}
                </label>
              ))}
            </div>
          ) : questionStyle(f, config) === "scale" ? (
            <div className="form-scale" role="radiogroup" aria-label={f.name}>
              {Array.from(
                { length: SCALE_MAX - SCALE_MIN + 1 },
                (_, i) => SCALE_MIN + i,
              ).map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={values[f.id] === n}
                  aria-label={`${f.name}: ${n}`}
                  className={values[f.id] === n ? "active" : ""}
                  disabled={disabled}
                  onClick={() => onChange(f.id, values[f.id] === n ? null : n)}
                >
                  {n}
                </button>
              ))}
            </div>
          ) : f.type === "files" && !upload ? (
            <FormFiles
              name={f.name}
              value={values[f.id]}
              disabled={disabled}
              onChange={(v) => onChange(f.id, v)}
            />
          ) : (
            <CellInput
              field={f}
              value={values[f.id]}
              members={members as unknown as User[]}
              related={related as unknown as Record<string, Row[]>}
              disabled={disabled}
              commit="change"
              upload={upload}
              onChange={(v) => onChange(f.id, v)}
            />
          )}
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
const fileSize = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024)).toLocaleString(LOCALE_TAG)} KB`
    : `${(bytes / 1024 / 1024).toLocaleString(LOCALE_TAG, { maximumFractionDigits: 1 })} MB`;
// Files stay in the browser until the answer is submitted.
export function FormFiles({
  name,
  value,
  disabled,
  onChange,
}: {
  name: string;
  value: unknown;
  disabled: boolean;
  onChange: (files: File[]) => void;
}) {
  const t = useT();
  const files = Array.isArray(value)
    ? value.filter((v): v is File => v instanceof File)
    : [];
  const [error, setError] = useState("");
  return (
    <div className="files-input" role="group" aria-label={name}>
      {files.length > 0 && (
        <ul>
          {files.map((file, i) => (
            <li key={`${file.name}-${i}`}>
              <span>{file.name}</span>
              <small className="muted">{fileSize(file.size)}</small>
              {!disabled && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t(`${file.name} entfernen`, `Remove ${file.name}`)}
                  onClick={() => onChange(files.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {files.length < FORM_FILES_PER_QUESTION && (
        <label className="button compact">
          {t("Dateien auswählen", "Choose files")}
          <input
            type="file"
            multiple
            hidden
            disabled={disabled}
            aria-label={t(`${name}: Dateien auswählen`, `${name}: choose files`)}
            onChange={(event) => {
              const chosen = [...(event.target.files || [])];
              event.target.value = "";
              const tooLarge = chosen.find((f) => f.size > FORM_FILE_BYTES);
              setError(
                tooLarge ? t(`${tooLarge.name}: maximal 10 MB pro Datei.`, `${tooLarge.name}: at most 10 MB per file.`) : "",
              );
              onChange(
                [
                  ...files,
                  ...chosen.filter((f) => f.size <= FORM_FILE_BYTES),
                ].slice(0, FORM_FILES_PER_QUESTION),
              );
            }}
          />
        </label>
      )}
      <small className="muted">
        {t("Bis zu", "Up to")}{" "}{FORM_FILES_PER_QUESTION} {t("Dateien, je maximal 10 MB.", "files, at most 10 MB each.")}
      </small>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
