// The workspace a person was last in on this device (#188): the app writes
// its id into a cookie whenever the shown workspace changes, and the server
// renders that workspace when the app is opened or reloaded without an
// invitation. Only a workspace id is taken; bootstrap (lib/api.ts) opens it
// only for a member and else the first workspace, as before.
// Runs in the browser and on the server.
export const WORKSPACE_COOKIE = "flowplan-workspace";

const workspaceId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function lastWorkspace(value: string | undefined | null): string | undefined {
  return value && workspaceId.test(value) ? value : undefined;
}

// For document.cookie: a year, the whole app, first-party only. Empty for
// anything but a workspace id.
export function workspaceCookie(id: string): string {
  return lastWorkspace(id) ? `${WORKSPACE_COOKIE}=${id}; path=/; max-age=31536000; samesite=lax` : "";
}
