// Mia's start page for "Customize your home page": greeting, my tasks, a
// scratchpad, focus & time, the agenda and today's journal, under a
// gradient header (used by seed.mjs).
export const HOME_LAYOUT = {
  version: 1,
  widgets: [
    { id: "greeting", kind: "greeting", size: "full", config: {} },
    { id: "tasks", kind: "tasks", size: "m", config: {} },
    { id: "notes", kind: "notes", size: "s", config: { title: "Scratchpad", text: "Call the printer before 3 pm\nBook the room for Thursday" } },
    { id: "focus", kind: "focus", size: "s", config: {} },
    { id: "calendar", kind: "calendar", size: "m", config: {} },
    { id: "journal", kind: "journal", size: "m", config: {} },
  ],
  appearance: { header: { type: "gradient", value: "dusk", position: 50 }, density: "comfortable", background: "dots", icon: "🌿", width: "normal" },
};
