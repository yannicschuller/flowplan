// Person properties with one or several people (#535). A person property
// keeps one member's id as a string – as always – unless "Mehrere
// Personen" / "Several people" is on (`multiPerson: true`): then its value
// is a list of member ids. Readers accept both shapes everywhere (records
// written before the switch, imports, the API), writers store the shape of
// the property's mode. Client-safe (no server imports).
import type { Field } from "./types";

// At most this many people on one record's property.
export const MAX_PEOPLE = 50;

export const isMultiPerson = (field: Pick<Field, "type" | "multiPerson"> | undefined) =>
  !!field && field.type === "person" && !!field.multiPerson;

// The member ids of a person value, in order, without blanks or repeats:
// "u1" → ["u1"], ["u1", "u2", "u1"] → ["u1", "u2"], "" / null → [].
export function personIds(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  return [...new Set(list.filter((v): v is string => typeof v === "string" && !!v.trim()))];
}

// The value to store for these people in the property's mode: a list with
// "Mehrere Personen", else the first person (or "" for none).
export function personCell(field: Pick<Field, "type" | "multiPerson">, ids: readonly string[]): string | string[] {
  const unique = personIds([...ids]);
  return isMultiPerson(field) ? unique.slice(0, MAX_PEOPLE) : (unique[0] ?? "");
}

// The people a change adds (assignment notifications, #535): in `after`,
// not in `before`.
export function addedPeople(before: unknown, after: unknown): string[] {
  const had = new Set(personIds(before));
  return personIds(after).filter((id) => !had.has(id));
}

// The setting is stored only where it means something: `multiPerson: true`
// on a person property (unset is the default, one person).
export function cleanMultiPerson(fields: { type: string; multiPerson?: boolean }[]) {
  for (const f of fields) if (f.type !== "person" || !f.multiPerson) delete f.multiPerson;
}

// Person properties whose "Mehrere Personen" a schema change switches off
// (`before`: the stored fields): their records keep the first person.
export function multiPersonSwitchedOff(
  fields: readonly Pick<Field, "id" | "type" | "multiPerson">[],
  before: readonly Pick<Field, "id" | "type" | "multiPerson">[],
): string[] {
  return fields
    .filter((f) => f.type === "person" && !f.multiPerson && isMultiPerson(before.find((b) => b.id === f.id)))
    .map((f) => f.id);
}
// …and those it switches on: their records' single ids become lists.
export function multiPersonSwitchedOn(
  fields: readonly Pick<Field, "id" | "type" | "multiPerson">[],
  before: readonly Pick<Field, "id" | "type" | "multiPerson">[],
): string[] {
  return fields
    .filter((f) => isMultiPerson(f) && before.some((b) => b.id === f.id && b.type === "person" && !b.multiPerson))
    .map((f) => f.id);
}

// How many records have more than one person in the property – what the
// confirmation for switching "Mehrere Personen" off names.
export const recordsWithSeveralPeople = (rows: readonly { cells: Record<string, unknown> }[], fieldId: string) =>
  rows.filter((r) => personIds(r.cells[fieldId]).length > 1).length;

// The refusal of several people for a property with one (German, as the
// server answers; lib/i18n-errors.ts has the English).
export const ONE_PERSON_MESSAGE = "Diese Eigenschaft nimmt nur eine Person. Schalte „Mehrere Personen“ ein, um mehrere einzutragen.";
