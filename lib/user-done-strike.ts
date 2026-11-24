// The person's "Erledigte Aufgaben durchstreichen" (#458,
// lib/done-strike-pref.ts), kept in users.strike_done_tasks (NULL: never
// chosen, the default – struck through – applies).
import { one, run } from "./db";
import { strikeDoneTasksOf, strikeDoneTasksSchema } from "./done-strike-pref";
import type { Identity } from "./types";

export async function userStrikeDoneTasks(userId: string) {
  return strikeDoneTasksOf((await one<{ strike_done_tasks: number | null }>("SELECT strike_done_tasks FROM users WHERE id=?", userId))?.strike_done_tasks);
}
export async function setUserStrikeDoneTasks(user: Identity, input: unknown) {
  const strikeDoneTasks = strikeDoneTasksSchema.parse(input);
  await run("UPDATE users SET strike_done_tasks=? WHERE id=?", strikeDoneTasks ? 1 : 0, user.id);
  return { strikeDoneTasks };
}
