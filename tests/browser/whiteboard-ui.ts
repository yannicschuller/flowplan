import type { Locator } from "@playwright/test";

// The whiteboard keeps a short tool rail (components/whiteboard/whiteboard.tsx);
// everything else sits behind a button. These open it and pick an entry.

// "Einfügen und mehr" ("+" at the end of the rail) – on phones the same
// entries wait in the sheet behind "Weitere Werkzeuge".
export async function boardInsert(wb: Locator, name: string) {
  // Whichever of the two the layout has (waits for the board to render).
  await wb
    .getByRole("button", { name: "Einfügen und mehr", exact: true })
    .or(wb.getByRole("button", { name: "Weitere Werkzeuge", exact: true }))
    .click();
  await wb.locator(".wb-plus, .wb-sheet").getByRole("button", { name, exact: true }).click();
}

// "Moderation" top right: vote, timer, private mode, estimating, gathering, follow me.
export async function boardModeration(wb: Locator, name: string) {
  await wb.getByRole("button", { name: "Moderation", exact: true }).click();
  await wb.getByRole("dialog", { name: "Moderation" }).getByRole("button", { name, exact: true }).click();
}

// "Ansicht und Aktionen" in the bottom bar (top right on phones).
export async function boardView(wb: Locator, name: string) {
  await wb.getByRole("button", { name: "Ansicht und Aktionen", exact: true }).click();
  await wb.getByRole("dialog", { name: "Ansicht und Aktionen" }).getByRole("button", { name, exact: true }).click();
}

// Pen, eraser and laser share the "Zeichnen" button; its options start with
// a switch between the three.
export async function boardDraw(wb: Locator, name: "Stift" | "Radierer" | "Laserpointer") {
  const choice = wb.locator(".wb-draw-switch").getByRole("button", { name, exact: true });
  if (!(await choice.isVisible())) await wb.getByRole("button", { name: "Zeichnen", exact: true }).click();
  await choice.click();
}
