// What a notification's buttons in the apps act on (lib/notification-actions.ts):
// the categories of buttons, and for reminders the task they are about – a
// task in a document (found again by its text) or a date property of a
// record. Kept apart from the actions so that the places that write
// reminders (lib/doc-tasks.ts, lib/date-reminders.ts) and the push queue
// (lib/push.ts) only need the database.
import { z } from "zod";
import { one, run } from "./db";
import { doneRule } from "./database-settings-schema";
import type { Field } from "./types";

// The categories the app registers with their buttons
// (src/native/notification-actions.ts in flowplan-app); the ids must stay.
export const NOTIFICATION_CATEGORIES = {
  // "Done", "Tomorrow"
  task: "flowplan.task",
  // "Reply", "Mark as read"
  comment: "flowplan.comment",
  // "Mark as read"
  read: "flowplan.read",
} as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[keyof typeof NOTIFICATION_CATEGORIES];

const targetSchema = z.discriminatedUnion("type", [
  // `key`: taskKey() of the task's text (lib/doc-tasks.ts).
  z.object({ type: z.literal("doc"), pageId: z.uuid(), rowId: z.uuid().nullable(), key: z.string().min(1).max(64) }),
  z.object({ type: z.literal("row"), pageId: z.uuid(), rowId: z.uuid(), fieldId: z.string().min(1).max(500) }),
]);
export type TaskTarget = z.infer<typeof targetSchema>;


// Right after the reminder's notification was written.
export async function rememberTaskTarget(notificationId: string, target: TaskTarget) {
  await run("INSERT INTO notification_targets(notification_id,target) VALUES(?,?) ON CONFLICT(notification_id) DO UPDATE SET target=excluded.target", notificationId, JSON.stringify(targetSchema.parse(target)));
}

export async function taskTarget(notificationId: string): Promise<TaskTarget | null> {
  const raw = (await one<{ target: string }>("SELECT target FROM notification_targets WHERE notification_id=?", notificationId))?.target;
  if (!raw) return null;
  try {
    const parsed = targetSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function hasDoneState(pageId: string) {
  const stored = await one<{ fields: string; settings: string | null }>("SELECT fields,settings FROM databases WHERE page_id=?", pageId);
  if (!stored) return false;
  return !!doneRule(JSON.parse(stored.fields) as Field[], stored.settings ? JSON.parse(stored.settings) : undefined);
}

export type CategoryInput = { id: string; kind: string | null; page_id: string | null; row_id: string | null; thread_id: string | null };

// The buttons a notification gets. Without its text on the lock screen
// (MOBILE_PUSH_CONTENT off, lib/push.ts) nobody could tell which task
// "Done" would tick off or what "Reply" answers: then only "Mark as read".
export async function notificationCategory(notification: CategoryInput, withContent: boolean): Promise<NotificationCategory> {
  if (!withContent) return NOTIFICATION_CATEGORIES.read;
  if (notification.kind === "reminder") {
    const target = await taskTarget(notification.id);
    // A record's date: only where its database knows "done".
    if (target && (target.type === "doc" || await hasDoneState(target.pageId))) return NOTIFICATION_CATEGORIES.task;
    return NOTIFICATION_CATEGORIES.read;
  }
  // Comment threads (also mentions in them) and comments on pages and records.
  if (notification.page_id && (notification.thread_id ? notification.kind === "comment" || notification.kind === "mention" : notification.kind === "comment"))
    return NOTIFICATION_CATEGORIES.comment;
  return NOTIFICATION_CATEGORIES.read;
}
