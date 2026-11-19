// What a new database starts with, for the server (lib/seed.ts createPage,
// in the language of the request) and for a database made offline on the
// device (#370, lib/offline-create.ts) – the same fields and views with the
// same ids, so records made offline fit the database the server creates.
// Client-safe: plain data only; `tr` is ct() on the server, the reader's
// language in the browser.
import type { Field, View } from "./types";
import { studySettingsSchema } from "./study-schema";

export type Translate = (de: string, en: string) => string;
// The fixed property ids of contacts databases (lib/contacts.ts).
export const CONTACT_FIELDS = {
  title: "title",
  firstName: "firstName",
  lastName: "lastName",
  company: "company",
  position: "position",
  email: "email",
  phone: "phone",
  mobile: "mobile",
  street: "street",
  postalCode: "postalCode",
  city: "city",
  country: "country",
  birthday: "birthday",
  tags: "tags",
} as const;
const F = CONTACT_FIELDS;

// A new database starts as a task list, in the language of the request.
export const defaultFields = (tr: Translate): Field[] => [
  { id: "title", name: tr("Aufgabe", "Task"), type: "text" },
  {
    id: "status",
    name: "Status",
    type: "select",
    options: [tr("Nicht begonnen", "Not started"), tr("In Arbeit", "In progress"), tr("Erledigt", "Done")],
  },
  {
    id: "priority",
    name: tr("Priorität", "Priority"),
    type: "select",
    options: [tr("Hoch", "High"), tr("Mittel", "Medium"), tr("Niedrig", "Low")],
  },
  { id: "date", name: tr("Fällig am", "Due"), type: "date" },
  { id: "assignee", name: tr("Verantwortlich", "Assignee"), type: "person" },
  {
    id: "tags",
    name: "Tags",
    type: "multiselect",
    options: ["Design", tr("Produkt", "Product"), tr("Entwicklung", "Engineering")],
  },
];
export const defaultViews = (tr: Translate): View[] => [
  { id: "table", name: tr("Alle Aufgaben", "All tasks"), type: "table", filters: [], sorts: [] },
  {
    id: "board",
    name: "Board",
    type: "board",
    filters: [],
    sorts: [],
    groupBy: "status",
  },
  {
    id: "calendar",
    name: tr("Kalender", "Calendar"),
    type: "calendar",
    filters: [],
    sorts: [],
    dateField: "date",
  },
  { id: "gallery", name: tr("Galerie", "Gallery"), type: "gallery", filters: [], sorts: [] },
  {
    id: "timeline",
    name: "Timeline",
    type: "timeline",
    filters: [],
    sorts: [],
    dateField: "date",
  },
  { id: "list", name: tr("Liste", "List"), type: "list", filters: [], sorts: [] },
  { id: "form", name: tr("Formular", "Form"), type: "form", filters: [], sorts: [] },
];
// What a new database starts as: a task list, a collection of documents
// (records open as a full page), contacts with a profile card
// (lib/contacts.ts), flashcards (a deck with the view "Lernen",
// docs/specs/flashcards.md) or only a title.
export { databaseKinds, type DatabaseKind } from "./database-kinds";
import type { DatabaseKind } from "./database-kinds";
// Front (the title), back, tags and the card type (its options read by
// name, lib/study-schema.ts typeOfOption); the card mapping in settings.study.
export function flashcardsSetup(tr: Translate) {
  return {
    fields: [
      { id: "title", name: tr("Vorderseite", "Front"), type: "text" },
      { id: "back", name: tr("Rückseite", "Back"), type: "text" },
      { id: "tags", name: "Tags", type: "multiselect", options: [] },
      {
        id: "type",
        name: tr("Kartentyp", "Card type"),
        type: "select",
        options: [tr("Vorder-/Rückseite", "Front/back"), tr("Lückentext", "Cloze"), tr("Antwort eintippen", "Type the answer"), tr("Multiple Choice", "Multiple choice"), tr("Bildverdeckung", "Image occlusion")],
      },
    ] as Field[],
    views: [
      { id: "study", name: tr("Lernen", "Study"), type: "study", filters: [], sorts: [], default: true },
      { id: "table", name: tr("Alle Karten", "All cards"), type: "table", filters: [], sorts: [] },
    ] as View[],
    settings: { study: studySettingsSchema.parse({ version: 1, type: { field: "type" }, front: { field: "title" }, back: { field: "back" }, tags: { field: "tags" } }) },
  };
}
export function databaseSetup(kind: DatabaseKind, tr: Translate): { fields: Field[]; views: View[]; recordLayout?: object; settings?: object } {
  if (kind === "flashcards") return flashcardsSetup(tr);
  if (kind === "documents")
    return {
      fields: [
        { id: "title", name: tr("Titel", "Title"), type: "text" },
        { id: "tags", name: "Tags", type: "multiselect", options: [] },
        { id: "created", name: tr("Erstellt", "Created"), type: "created_at" },
        { id: "edited", name: tr("Bearbeitet", "Edited"), type: "updated_at" },
      ],
      views: [
        { id: "list", name: tr("Alle Dokumente", "All documents"), type: "list", filters: [], sorts: [{ field: "edited", direction: "desc" }] },
        { id: "gallery", name: tr("Galerie", "Gallery"), type: "gallery", filters: [], sorts: [] },
        { id: "table", name: tr("Tabelle", "Table"), type: "table", filters: [], sorts: [] },
      ],
      recordLayout: { open: "full", properties: "top", hideEmpty: true, hidden: [] },
    };
  if (kind === "contacts") return contactsSetup(tr);
  if (kind === "empty")
    return {
      fields: [{ id: "title", name: "Name", type: "text" }],
      views: [{ id: "table", name: tr("Tabelle", "Table"), type: "table", filters: [], sorts: [] }],
    };
  return { fields: defaultFields(tr), views: defaultViews(tr) };
}
export function contactsSetup(tr: Translate): { fields: Field[]; views: View[]; recordLayout: object } {
  return {
    fields: [
      { id: F.title, name: "Name", type: "text" },
      { id: F.firstName, name: tr("Vorname", "First name"), type: "text" },
      { id: F.lastName, name: tr("Nachname", "Last name"), type: "text" },
      { id: F.company, name: tr("Firma", "Company"), type: "text" },
      { id: F.position, name: "Position", type: "text" },
      { id: F.email, name: tr("E-Mail", "E-mail"), type: "email" },
      { id: F.phone, name: tr("Telefon", "Phone"), type: "phone" },
      { id: F.mobile, name: tr("Mobil", "Mobile"), type: "phone" },
      { id: F.street, name: tr("Straße", "Street"), type: "text" },
      { id: F.postalCode, name: tr("PLZ", "Postal code"), type: "text" },
      { id: F.city, name: tr("Ort", "City"), type: "text" },
      { id: F.country, name: tr("Land", "Country"), type: "text" },
      { id: F.birthday, name: tr("Geburtstag", "Birthday"), type: "date" },
      { id: F.tags, name: "Tags", type: "multiselect", options: [] },
    ],
    views: [
      {
        id: "list",
        name: tr("Alle Kontakte", "All contacts"),
        type: "list",
        filters: [],
        sorts: [
          { field: F.lastName, direction: "asc" },
          { field: F.firstName, direction: "asc" },
        ],
        // The name is the title; beside it company and e-mail.
        hiddenFields: [F.firstName, F.lastName, F.position, F.phone, F.mobile, F.street, F.postalCode, F.country, F.birthday, F.tags],
      },
      {
        id: "table",
        name: tr("Tabelle", "Table"),
        type: "table",
        filters: [],
        sorts: [{ field: F.lastName, direction: "asc" }],
        hiddenFields: [F.street, F.postalCode, F.country, F.birthday],
      },
      {
        id: "birthdays",
        name: tr("Geburtstage", "Birthdays"),
        type: "calendar",
        filters: [],
        sorts: [],
        dateField: F.birthday,
      },
      { id: "gallery", name: tr("Galerie", "Gallery"), type: "gallery", filters: [], sorts: [{ field: F.lastName, direction: "asc" }] },
    ],
    recordLayout: { open: "full", properties: "top", hideEmpty: true, hidden: [], card: "contact" },
  };
}

