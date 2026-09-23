import katex from "katex";
export const MAX_MATH_LENGTH = 10000;
const options = {
  trust: false,
  maxExpand: 1000,
  maxSize: 20,
  strict: "ignore" as const,
};
export function mathError(expression: string, inline: boolean): string | null {
  if (!expression.trim()) return "Bitte eine Formel eingeben.";
  if (expression.length > MAX_MATH_LENGTH)
    return "Die Formel darf höchstens 10.000 Zeichen enthalten.";
  try {
    katex.renderToString(expression, {
      ...options,
      displayMode: !inline,
      throwOnError: true,
    });
    return null;
  } catch (error) {
    return error instanceof Error
      ? error.message.replace(/^KaTeX parse error: /, "")
      : "Ungültige Formel.";
  }
}
export function renderMath(expression: string, inline: boolean): string {
  if (expression.length > MAX_MATH_LENGTH)
    return '<span class="katex-error">Formel zu lang</span>';
  return katex.renderToString(expression, {
    ...options,
    displayMode: !inline,
    throwOnError: false,
  });
}
