// The daily study reminder (docs/specs/flashcards.md §10.3): a person sets a
// local time (study_prefs.remind_at of page_id '', "Lernerinnerung" in the
// screen #study, the command study.reminder) and gets one notification of
// the kind "study" ("Lernerinnerungen": push on, inbox and e-mail off by
// default) on study days when
// - the time has come in their zone (the zone their browser or app sent
//   last, study_prefs.time_zone),
// - they have not studied yet that study day (a rating in any deck),
// - cards are due (the counts of #study over all their workspaces,
//   lib/study-stats.ts studyDueEverywhere – new cards within the limits
//   count),
// - and it was not sent that day yet (study_prefs.reminded_day).
// No nagging: after 30 days without studying (and without touching the
// setting) one "Lernerinnerungen pausiert" goes out instead and nothing
// more until the person studies again (study_prefs.reminder_paused_at).
// The text names the deck with the most cards; the notification opens
// #study. With the inbox off it is a push-only row (notifications.push_only,
// lib/db.ts migrateStudyReminders), which the inbox never lists.
// A leader duty every 5 minutes, like the date reminders.
import { all, id, one, run, transaction } from "./db";
import { notificationOn } from "./notification-kinds";
import { leaderDuty } from "./cluster/leader";
import { workersPaused } from "./instance-read-only";
import { moduleOff } from "./instance-modules";
import { DEFAULT_DAY_START, REMIND_AT, reminderMoment, studyDay, studyZone } from "./study-day";
import type { Identity } from "./types";

export const REMINDER_PAUSE_DAYS = 30;
const PAUSE_MS = REMINDER_PAUSE_DAYS * 86_400_000;
export const REMINDER_INTERVAL_MS = 5 * 60_000;

export type ReminderState = {
  now: number;
  zone: string;
  dayStart: number;
  remindAt: string;
  remindedDay: string | null;
  pausedAt: number | null;
  // The person's last rating, and when they last touched their settings.
  lastReview: number | null;
  updatedAt: number;
};
// What is to do for one person now (pure): nothing yet, look at what is
// due and remind, or send the one pause notice. `day`: the study day.
export function reminderStep(s: ReminderState): { step: "wait" | "check" | "pause" | "paused"; day: string } {
  const day = studyDay(s.now, s.zone, s.dayStart);
  if (!REMIND_AT.test(s.remindAt) || s.remindedDay === day || s.now < reminderMoment(day, s.remindAt, s.zone, s.dayStart)) return { step: "wait", day };
  const active = Math.max(s.lastReview ?? 0, s.updatedAt);
  if (s.now - active >= PAUSE_MS) return { step: s.pausedAt !== null && s.pausedAt >= active ? "paused" : "pause", day };
  return { step: "check", day };
}

// "12 Karten warten auf dich – „Spanisch A1“ und 2 weitere Stapel."
// (English in lib/i18n-errors.ts, by pattern.)
export function reminderText(decks: { title: string; due: number }[]) {
  const open = decks.filter((d) => d.due > 0).sort((a, b) => b.due - a.due);
  const total = open.reduce((n, d) => n + d.due, 0);
  const first = (open[0]?.title || "Ohne Titel").replace(/\s+/g, " ").trim().slice(0, 80);
  const cards = total === 1 ? "1 Karte wartet auf dich" : `${total} Karten warten auf dich`;
  const more = open.length - 1;
  return `${cards} – „${first}“${more === 1 ? " und ein weiterer Stapel" : more > 1 ? ` und ${more} weitere Stapel` : ""}.`;
}
export const PAUSED_TEXT = "Lernerinnerungen pausiert: Du hast seit 30 Tagen nicht gelernt. Sobald du wieder lernst, erinnert Flowplan dich wieder.";

const asIdentity = async (userId: string): Promise<Identity | null> => {
  const person = await one<Identity>("SELECT * FROM users WHERE id=? AND disabled=0 AND demo_until IS NULL", userId);
  if (!person) return null;
  const groups = (await all<{ group_id: string }>("SELECT group_id FROM group_members WHERE user_id=?", userId)).map((g) => g.group_id);
  return { ...person, groups, isAdmin: false };
};
// Whether a notification of this kind reaches the person anywhere.
async function channels(userId: string) {
  const on = await one<{ inbox: number; other: number }>(
    `SELECT CASE WHEN ${notificationOn("inbox", "?", "'study'")} THEN 1 ELSE 0 END inbox,
       CASE WHEN ${notificationOn("push", "?", "'study'")} OR ${notificationOn("email", "?", "'study'")} OR ${notificationOn("messenger", "?", "'study'")} THEN 1 ELSE 0 END other`,
    userId,
    userId,
    userId,
    userId,
  );
  return { inbox: !!Number(on?.inbox), other: !!Number(on?.other) };
}
// One notification, once per study day (claimed by the update of
// reminded_day, so two instances or ticks never send it twice).
async function send(userId: string, day: string, body: string, pause: boolean) {
  const reach = await channels(userId);
  return await transaction(async () => {
    const claimed = await run(
      `UPDATE study_prefs SET reminded_day=?${pause ? ",reminder_paused_at=?" : ""} WHERE user_id=? AND page_id='' AND reminded_day IS DISTINCT FROM ?`,
      day,
      ...(pause ? [Date.now()] : []),
      userId,
      day,
    );
    if (!claimed.changes || (!reach.inbox && !reach.other)) return false;
    await run(
      "INSERT INTO notifications(id,user_id,body,page_id,kind,link,push_only) VALUES(?,?,?,NULL,'study','#study',?)",
      id(),
      userId,
      body,
      reach.inbox ? null : 1,
    );
    return true;
  });
}
const markDay = async (userId: string, day: string) => await run("UPDATE study_prefs SET reminded_day=? WHERE user_id=? AND page_id=''", day, userId);

// Everyone whose reminder is due now. Returns how many were sent.
export async function processStudyReminders(now = Date.now()) {
  const people = await all<{ user_id: string; remind_at: string; time_zone: string | null; day_start: number | null; reminded_day: string | null; reminder_paused_at: number | null; updated_at: number }>(
    `SELECT p.user_id,p.remind_at,p.time_zone,p.day_start,p.reminded_day,p.reminder_paused_at,p.updated_at FROM study_prefs p JOIN users u ON u.id=p.user_id
      WHERE p.page_id='' AND p.remind_at IS NOT NULL AND u.disabled=0 AND u.demo_until IS NULL`,
  );
  let sent = 0;
  for (const p of people) {
    const zone = studyZone(p.time_zone);
    const dayStart = p.day_start ?? DEFAULT_DAY_START;
    // Cheap first: the time of day, then the log.
    if (reminderStep({ now, zone, dayStart, remindAt: p.remind_at, remindedDay: p.reminded_day, pausedAt: null, lastReview: null, updatedAt: now }).step === "wait") continue;
    const last = await one<{ at: number | null }>("SELECT MAX(reviewed_at) at FROM review_log WHERE user_id=? AND undone_at IS NULL", p.user_id);
    const state = reminderStep({
      now,
      zone,
      dayStart,
      remindAt: p.remind_at,
      remindedDay: p.reminded_day,
      pausedAt: p.reminder_paused_at === null ? null : Number(p.reminder_paused_at),
      lastReview: last?.at === null || last?.at === undefined ? null : Number(last.at),
      updatedAt: Number(p.updated_at),
    });
    if (state.step === "paused") {
      await markDay(p.user_id, state.day);
      continue;
    }
    if (state.step === "pause") {
      if (await send(p.user_id, state.day, PAUSED_TEXT, true)) sent++;
      continue;
    }
    if (state.step !== "check") continue;
    if (await one("SELECT 1 FROM review_log WHERE user_id=? AND day=? AND undone_at IS NULL LIMIT 1", p.user_id, state.day)) {
      await markDay(p.user_id, state.day);
      continue;
    }
    const user = await asIdentity(p.user_id);
    if (!user) continue;
    const { studyDueEverywhere } = await import("./study-stats");
    const due = await studyDueEverywhere(user, zone);
    if (!due.due) {
      await markDay(p.user_id, state.day);
      continue;
    }
    if (await send(p.user_id, state.day, reminderText(due.decks.map((d) => ({ title: d.title, due: d.new + d.learning + d.review }))), false)) sent++;
  }
  return sent;
}

const runtime = globalThis as typeof globalThis & { flowplanStudyReminderTimer?: ReturnType<typeof setInterval> };
// One round: the reminders sent, null when it did not run – while the
// instance moves or flashcards are switched off for it (#386).
export async function studyReminderRound(): Promise<number | null> {
  if ((await workersPaused()) || (await moduleOff("flashcards"))) return null;
  return await processStudyReminders();
}
export function startStudyReminderWorker(onSent: () => void) {
  if (runtime.flowplanStudyReminderTimer) return;
  const tick = () =>
    leaderDuty("study-reminders", async () => {
      // Cluster mode: the leader only (lib/cluster/leader.ts).
      try {
        if (await studyReminderRound()) onSent();
      } catch (error) {
        console.error("Study reminders failed", error);
      }
    });
  runtime.flowplanStudyReminderTimer = setInterval(tick, REMINDER_INTERVAL_MS);
  runtime.flowplanStudyReminderTimer.unref();
  void tick();
}
