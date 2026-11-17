// The checklist "Erste Schritte" after the introduction
// (components/getting-started.tsx, lib/getting-started.ts): which items a
// person sees and in which order. Client-safe: plain data and one pure
// function, so the server and the tests agree on the list.

// What the person said they use Flowplan for (step "Womit möchtest du
// starten?", lib/onboarding-goals.ts) and where they come from (step
// "Woher kommst du?", lib/migration-sources.ts).
export const ONBOARDING_GOALS = ["personal", "team", "projects", "study", "other"] as const;
export type OnboardingGoal = (typeof ONBOARDING_GOALS)[number];
export const ONBOARDING_SOURCES = ["notion", "affine", "obsidian", "evernote", "confluence", "gdocs", "bookstack", "fresh"] as const;
export type OnboardingSource = (typeof ONBOARDING_SOURCES)[number];

// In this order in the sidebar. How each one ticks:
// - page: a new document page (command page.create)
// - task: a record in a database with a checkbox or status, or a task in
//   My tasks (row.create, capture.record, task.add)
// - invite: an invitation sent (member.invite) – owners only, who may invite
// - app: the app opened (the browser reports it: installed web app,
//   desktop or phone app) – or ticked by hand
// - search: the quick search or ⌘K opened (the browser reports it)
// - import: anything imported (ZIP, AFFiNE, Obsidian …, Markdown files) –
//   left out when it happened in the introduction already
export const CHECKLIST_ITEMS = ["page", "task", "invite", "app", "search", "import"] as const;
export type ChecklistItem = (typeof CHECKLIST_ITEMS)[number];
// Items the server sees happen; the others are reported by the browser or
// ticked by hand (every item can be ticked by hand).
export const AUTOMATIC_ITEMS: readonly ChecklistItem[] = ["page", "task", "invite", "import"];

export type ChecklistState = {
  startedAt: number;
  hiddenAt: number | null;
  goal: OnboardingGoal | null;
  source: OnboardingSource | null;
  done: Partial<Record<ChecklistItem, number>>;
};
export type ChecklistView = {
  hidden: boolean;
  goal: OnboardingGoal | null;
  source: OnboardingSource | null;
  items: { id: ChecklistItem; done: boolean }[];
  doneCount: number;
};

export function checklistView(state: ChecklistState, who: { owner: boolean; guest: boolean; canWrite: boolean }): ChecklistView {
  const items = CHECKLIST_ITEMS.filter((item) => {
    if (item === "invite") return who.owner && !who.guest;
    if (item === "page" || item === "task") return who.canWrite;
    // Imported in the introduction already: nothing left to do here.
    if (item === "import") return who.canWrite && !(state.done.import !== undefined && state.done.import <= state.startedAt);
    return true;
  }).map((id) => ({ id, done: state.done[id] !== undefined }));
  return {
    hidden: state.hiddenAt !== null,
    goal: state.goal,
    source: state.source,
    items,
    doneCount: items.filter((i) => i.done).length,
  };
}
