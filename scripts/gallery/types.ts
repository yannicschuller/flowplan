import type { APIRequestContext, Page } from "@playwright/test";

// The UI gallery (scripts/gallery/run.ts): every page, dialog, menu and
// popover of the app on one local HTML page, to spot what does not fit.

export type Device = "desktop" | "phone";
export type Theme = "light" | "dark";
export type Variant = { id: `${Device}-${Theme}`; device: Device; theme: Theme };

export const GROUPS = [
  "Pages",
  "Documents & editor",
  "Databases",
  "Whiteboard",
  "Journal",
  "Dialogs",
  "Settings",
  "Admin",
  "Auth",
  "Public",
  "Errors",
  "Mobile-only",
] as const;
export type Group = (typeof GROUPS)[number];

// The seeded content (scripts/gallery/seed.ts) the scenes work with.
export type Ids = {
  workspaceId: string;
  spaceId: string;
  documentId: string;
  databaseId: string;
  workflowId: string;
  whiteboardId: string;
  journalId: string;
  notebookId: string;
  dashboardId: string;
  sandboxId: string;
  rowId: string;
  publicDocToken: string;
  publicDbToken: string;
  shareLinkToken: string;
  formToken: string;
};

export type FixtureOptions = {
  title?: string;
  kind?: "document" | "database" | "whiteboard" | "journal" | "dashboard" | "notebook" | "workflow";
  // Document content as HTML (lib/document-server.ts, htmlState).
  html?: string;
};

export type SceneContext = {
  origin: string;
  ids: Ids;
  variant: Variant;
  phone: boolean;
  // POST /api/command as the seeded account.
  command: (data: Record<string, unknown>) => Promise<any>;
  api: APIRequestContext;
  // A page of its own below "Spielwiese" for scenes that type or change
  // something, so parallel scenes do not see each other's edits.
  fixture: (options?: FixtureOptions) => Promise<string>;
  // Opens an address of the app ("#home", "/login") with the clock fixed and
  // waits until it has settled.
  open: (path: string) => Promise<void>;
  settle: () => Promise<void>;
};

export type Scene = {
  // Stable, unique, used in file names: lower-case words with dashes.
  id: string;
  group: Group;
  title: string;
  // Where the scene starts: a hash route of the app ("#home"), a path
  // ("/login"), or computed from the seeded ids. Omitted: no navigation,
  // `steps` opens what it needs.
  path?: string | ((ctx: SceneContext) => string);
  // What to do after the page has opened, before the screenshot: click
  // the way to a dialog, type into the editor.
  steps?: (page: Page, ctx: SceneContext) => Promise<void>;
  // Only on these devices (default: both).
  devices?: Device[];
  viewport?: { width: number; height: number };
  // Signed out instead of the seeded account.
  signedOut?: boolean;
  // The real clock instead of FIXED_TIME (screens that wait for time to
  // pass, like the journal creating today's page).
  realTime?: boolean;
  // The whole page instead of the window.
  fullPage?: boolean;
  // Component files whose dialog/menu/popover this scene shows
  // (tests/gallery-coverage.test.ts).
  covers?: string[];
};
