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
// The categories in the reader's language: pass the component's t (or
// translate(locale) on the server).
type T = (de: string, en: string) => string;
export const templateCategoryLabels = (t: T): Record<keyof typeof templateCategories, string> => ({
  projects: t("Projekte", "Projects"),
  meetings: t("Meetings", "Meetings"),
  knowledge: t("Wissen & Dokumentation", "Knowledge & documentation"),
  planning: t("Planung & Ziele", "Planning & goals"),
  personal: t("Persönlich", "Personal"),
  other: t("Sonstiges", "Other"),
});
export const templateCategoryLabel = (category: string, t: T) =>
  category in templateCategories ? templateCategoryLabels(t)[category as keyof typeof templateCategories] : "";
