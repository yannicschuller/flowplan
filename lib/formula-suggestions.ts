import { formulaFunctions, type FormulaFunction } from "./formula-catalog";
import type { Field } from "./types";

export type FormulaSuggestion =
  | { kind: "property"; name: string; field: Field }
  | { kind: "function"; name: string; fn: FormulaFunction };
export function formulaCompletionRange(
  source: string,
  cursor: number,
  selectionEnd = cursor,
) {
  cursor = Math.max(0, Math.min(cursor, source.length));
  if (selectionEnd > cursor)
    return {
      from: cursor,
      to: Math.min(selectionEnd, source.length),
      query: "",
      propertiesOnly: false,
    };
  const prefix = source.slice(0, cursor);
  const property = /\bprop\(\s*(["'])([^"']*)$/i.exec(prefix);
  if (property) {
    const closing = new RegExp(`^[^${property[1]}]*${property[1]}\\s*\\)`).exec(
      source.slice(cursor),
    );
    return {
      from: property.index,
      to: cursor + (closing?.[0].length || 0),
      query: property[2],
      propertiesOnly: true,
    };
  }
  const word = /[\p{L}_][\p{L}\p{N}_]*$/u.exec(prefix);
  const rest = word
    ? /^[\p{L}\p{N}_]*/u.exec(source.slice(cursor))?.[0] || ""
    : "";
  return {
    from: cursor - (word?.[0].length || 0),
    to: cursor + rest.length,
    query: word?.[0] || "",
    propertiesOnly: false,
  };
}
export function formulaSuggestions(
  query: string,
  fields: Field[],
  propertiesOnly = false,
): FormulaSuggestion[] {
  const normalize = (value: string) =>
    value
      .toLocaleLowerCase("de")
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "");
  const words = normalize(query).split(/\s+/).filter(Boolean);
  const properties: FormulaSuggestion[] = fields.map((field) => ({
    kind: "property",
    name: field.name,
    field,
  }));
  const functions: FormulaSuggestion[] = propertiesOnly
    ? []
    : formulaFunctions.map((fn) => ({ kind: "function", name: fn.name, fn }));
  return [...properties, ...functions].filter((entry) =>
    words.every((word) =>
      normalize(
        entry.kind === "property"
          ? `${entry.name} ${entry.field.id}`
          : `${entry.name} ${entry.fn.description} ${entry.fn.category}`,
      ).includes(word),
    ),
  );
}
export function insertFormulaSuggestion(
  source: string,
  cursor: number,
  selectionEnd: number,
  suggestion: FormulaSuggestion,
  fields: Field[],
) {
  const range = formulaCompletionRange(source, cursor, selectionEnd);
  let insertion: string, offset: number;
  if (suggestion.kind === "property") {
    const { field } = suggestion;
    const readable =
      fields.filter((f) => f.name === field.name).length === 1 &&
      !fields.some((f) => f.id === field.name && f.id !== field.id);
    insertion = `prop(${JSON.stringify(readable ? field.name : field.id)})`;
    offset = insertion.length;
  } else if (/^\s*\(/.test(source.slice(range.to))) {
    insertion = suggestion.name;
    offset = insertion.length;
  } else {
    insertion = `${suggestion.name}()`;
    offset = insertion.length - (suggestion.fn.min > 0 ? 1 : 0);
  }
  return {
    value: source.slice(0, range.from) + insertion + source.slice(range.to),
    cursor: range.from + offset,
  };
}
