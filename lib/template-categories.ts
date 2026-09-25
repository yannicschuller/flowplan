// Fixed categories for the template gallery ("" = uncategorised).
export const templateCategories = {
  projects: "Projekte",
  meetings: "Meetings",
  knowledge: "Wissen & Dokumentation",
  planning: "Planung & Ziele",
  personal: "Persönlich",
  other: "Sonstiges",
} as const;
export type TemplateCategory = keyof typeof templateCategories | "";
export const templateCategoryIds = Object.keys(templateCategories) as [
  keyof typeof templateCategories,
  ...(keyof typeof templateCategories)[],
];
