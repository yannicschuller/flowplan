// Buttons on the push notifications of the apps (flowplan-app): "Done" and
// "Tomorrow" on a task that is due, "Reply" (with text) and "Mark as read"
// on comments and mentions. lib/push.ts names a category per notification
// (lib/notification-targets.ts; the app registers the categories with their
// buttons in the person's language). A button calls
// POST /api/mobile/notifications with the installation's device token
// (lib/mobile-devices.ts), without opening the app.
//
// The request names only the notification: what it is about (which task,
// which comment thread) comes from the notification itself, never from the
// phone. Every change goes through the command of the web app (lib/api.ts
// command()), so permissions, locks, versions, the activity log, webhooks,
// automations and further notifications behave as after a click in the
// browser.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Temporal } from "@js-temporal/polyfill";
import { all, one, run } from "./db";
import { HttpError } from "./auth";
import { allow } from "./action-limits";
import { command } from "./api";
import { ct } from "./content-locale";
import { validDateValue } from "./date-values";
import { taskKey } from "./doc-tasks";
import { widgetAction } from "./mobile-widget-actions";
import { taskTarget, type CategoryInput, type TaskTarget } from "./notification-targets";
import type { Identity } from "./types";

const notificationId = z.string().min(1).max(100);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const notificationActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("read"), notificationId }),
  z.object({ action: z.literal("done"), notificationId }),
  // `today`: the phone's day, so "tomorrow" is the person's tomorrow.
  z.object({ action: z.literal("tomorrow"), notificationId, today: day.optional() }),
  z.object({ action: z.literal("reply"), notificationId, text: z.string().trim().min(1).max(5000) }),
]);
export type NotificationAction = z.infer<typeof notificationActionSchema>["action"];

const writerOf = (user: Identity): Identity => ({ ...user, apiScope: "write" });
const nowText = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const unread = (user: Identity) => Number(one<{ n: number }>("SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read_at IS NULL", user.id)?.n || 0);
const gone = () => new HttpError(404, ct("Benachrichtigung nicht gefunden.", "Notification not found."));
const changed = () => new HttpError(409, ct("Die Aufgabe gibt es so nicht mehr. Bitte in Flowplan öffnen.", "The task no longer exists as it was. Please open it in Flowplan."));

// The day after `today` (the phone's day; without it the server's).
export function nextDay(today?: string) {
  const base = today ? Temporal.PlainDate.from(today) : Temporal.Now.plainDateISO();
  return base.add({ days: 1 }).toString();
}

// "Tomorrow" never moves a date back: one further ahead (a reminder that
// came days before) moves one day on.
function postponed(date: string, tomorrow: string) {
  const shifted = Temporal.PlainDate.from(date.slice(0, 10)).add({ days: 1 }).toString();
  return shifted > tomorrow ? shifted : tomorrow;
}

// The reminder's document task as it is now (its position may have moved).
function docTask(target: Extract<TaskTarget, { type: "doc" }>) {
  const task = all<{ idx: number; text: string; checked: number; due: string | null }>(
    "SELECT idx,text,checked,due FROM doc_tasks WHERE page_id=? AND row_id=? ORDER BY idx",
    target.pageId,
    target.rowId || "",
  ).find((t) => taskKey(t.text) === target.key);
  if (!task) throw changed();
  return task;
}

async function complete(user: Identity, target: TaskTarget) {
  if (target.type === "row") {
    await widgetAction(user, { action: "task.complete", source: "row", pageId: target.pageId, rowId: target.rowId, done: true });
    return;
  }
  const task = docTask(target);
  if (!task.checked)
    await widgetAction(user, { action: "task.complete", source: "doc", pageId: target.pageId, rowId: target.rowId, index: task.idx, key: target.key, done: true });
}

function postpone(user: Identity, target: TaskTarget, today?: string) {
  const tomorrow = nextDay(today);
  if (target.type === "doc") {
    const task = docTask(target);
    const due = task.due ? postponed(task.due, tomorrow) : tomorrow;
    command(writerOf(user), { action: "task.update", pageId: target.pageId, rowId: target.rowId, index: task.idx, key: target.key, due });
    return due;
  }
  const row = one<{ cells: string; version: number }>("SELECT cells,version FROM rows WHERE id=? AND page_id=?", target.rowId, target.pageId);
  const value = row ? (JSON.parse(row.cells) as Record<string, unknown>)[target.fieldId] : undefined;
  if (!row || !validDateValue(value)) throw changed();
  // The time of day stays: "2026-05-04T09:30" becomes "2026-05-05T09:30".
  const due = postponed(value, tomorrow) + value.slice(10);
  command(writerOf(user), { action: "row.update", pageId: target.pageId, rowId: target.rowId, version: row.version, cells: { [target.fieldId]: due } });
  return due;
}

function reply(user: Identity, notification: CategoryInput, text: string) {
  if (!notification.page_id) throw gone();
  const row = notification.row_id ? { rowId: notification.row_id } : {};
  if (notification.thread_id)
    command(writerOf(user), { action: "thread.reply", pageId: notification.page_id, ...row, threadId: notification.thread_id, messageId: randomUUID(), body: text });
  else if (notification.kind === "comment") command(writerOf(user), { action: "comment.create", pageId: notification.page_id, ...row, body: text });
  else throw new HttpError(400, ct("Auf diese Benachrichtigung kann man nicht antworten.", "This notification cannot be answered."));
}

export async function notificationAction(user: Identity, input: unknown) {
  // As often as the widgets' buttons.
  if (!allow(`notification-actions:${user.id}`, 30, 60_000))
    throw new HttpError(429, ct("Zu viele Anfragen in kurzer Zeit. Bitte später erneut versuchen.", "Too many requests in a short time. Please try again later."));
  const body = notificationActionSchema.parse(input);
  const notification = one<CategoryInput>("SELECT id,kind,page_id,row_id,thread_id FROM notifications WHERE id=? AND user_id=?", body.notificationId, user.id);
  if (!notification) throw gone();
  let result: { due?: string } = {};
  if (body.action === "done" || body.action === "tomorrow") {
    const target = notification.kind === "reminder" ? taskTarget(notification.id) : null;
    if (!target) throw new HttpError(400, ct("Diese Benachrichtigung gehört zu keiner Aufgabe.", "This notification belongs to no task."));
    if (body.action === "done") await complete(user, target);
    else result = { due: postpone(user, target, body.today) };
  } else if (body.action === "reply") reply(user, notification, body.text);
  // Whatever the button did, the notification has been dealt with.
  run("UPDATE notifications SET read_at=COALESCE(read_at,?) WHERE id=? AND user_id=?", nowText(), notification.id, user.id);
  return { ok: true, action: body.action, ...result, unread: unread(user) };
}
