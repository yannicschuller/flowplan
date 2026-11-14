// What the introduction proposes to start with, by what the person uses
// Flowplan for (components/onboarding.tsx, step "Womit möchtest du
// starten?"). A starter is either a plain page kind (with the database
// kind of an empty database) or a template of the catalog
// (lib/template-catalog.ts) – page.create with `starterTemplate`.
// Client-safe: plain data only (the names are worded in the component).
import type { OnboardingGoal } from "./getting-started-items";

export type StarterId =
  | "tasks"
  | "notes"
  | "journal"
  | "whiteboard"
  | "todo"
  | "habits"
  | "reading"
  | "wiki"
  | "meetingLog"
  | "decisions"
  | "project"
  | "sprint"
  | "roadmap"
  | "brief";

export type StarterSpec = {
  kind: "document" | "database" | "journal" | "whiteboard";
  databaseKind?: "tasks" | "documents";
  // A key of lib/template-catalog.ts; its kind must match `kind`.
  template?: string;
};

export const STARTERS: Record<StarterId, StarterSpec> = {
  tasks: { kind: "database", databaseKind: "tasks" },
  notes: { kind: "database", databaseKind: "documents" },
  journal: { kind: "journal" },
  whiteboard: { kind: "whiteboard" },
  todo: { kind: "database", template: "tasks" },
  habits: { kind: "database", template: "habits" },
  reading: { kind: "database", template: "reading" },
  wiki: { kind: "document", template: "wiki" },
  meetingLog: { kind: "database", template: "meetingLog" },
  decisions: { kind: "database", template: "decisions" },
  project: { kind: "database", template: "project" },
  sprint: { kind: "database", template: "sprint" },
  roadmap: { kind: "database", template: "roadmap" },
  brief: { kind: "document", template: "brief" },
};

// Without an answer (or "Etwas anderes") the four of before.
export const DEFAULT_STARTERS: StarterId[] = ["tasks", "notes", "journal", "whiteboard"];
export const GOAL_STARTERS: Record<OnboardingGoal, StarterId[]> = {
  personal: ["todo", "journal", "habits", "reading"],
  team: ["wiki", "meetingLog", "decisions", "project"],
  projects: ["project", "sprint", "roadmap", "brief"],
  study: ["notes", "reading", "journal", "whiteboard"],
  other: DEFAULT_STARTERS,
};

export const startersFor = (goal: OnboardingGoal | null) => (goal ? GOAL_STARTERS[goal] : DEFAULT_STARTERS);

// The body of page.create for a starter (title left out for templates: the
// server names the page after the template in the content language).
export function starterCommand(id: StarterId, spaceId: string, title: string) {
  const spec = STARTERS[id];
  return {
    action: "page.create",
    spaceId,
    kind: spec.kind,
    ...(spec.databaseKind ? { databaseKind: spec.databaseKind } : {}),
    ...(spec.template ? { starterTemplate: spec.template } : { title }),
  };
}
