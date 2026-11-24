// "Auch Aufgaben ohne Person aus meinen Seiten" (#511, the switch in My
// tasks): whether My tasks also lists the open unassigned tasks in pages the
// person created when they have no date – without it only the dated ones
// count as the person's own to-dos (lib/doc-tasks.ts taskRows). Off by
// default. Stored per person on the server, for every workspace and device
// (users.my_tasks_unassigned: NULL = never chosen, off; 0 = off; 1 = on).
// Everything built on My tasks follows it: the list, the other workspaces,
// the start page's and the phone's task widgets, the weekly digest and MCP.
import { z } from "zod";
import { one, run } from "./db";
import type { Identity } from "./types";

export const unassignedTasksSchema = z.boolean();

export async function userUnassignedTasks(userId: string) {
  return Number((await one<{ my_tasks_unassigned: number | null }>("SELECT my_tasks_unassigned FROM users WHERE id=?", userId))?.my_tasks_unassigned || 0) === 1;
}
// The command `tasks.unassigned`.
export async function setUserUnassignedTasks(user: Identity, input: unknown) {
  const unassigned = unassignedTasksSchema.parse(input);
  await run("UPDATE users SET my_tasks_unassigned=? WHERE id=?", unassigned ? 1 : 0, user.id);
  return { unassigned };
}
