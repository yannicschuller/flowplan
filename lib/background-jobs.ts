// Long-running work a person started – imports (Notion/Confluence/Evernote/
// Obsidian/Google Docs, ZIP, Jira/Trello, Markdown records, Flowplan
// archives), exports (Markdown, archive) and the Git export of a space –
// as small entries with a progress, so the mobile app can show them as a
// Live Activity (lib/mobile-widgets.ts, kind "jobs"). The work itself runs
// where it always ran (in its request); this only records that it runs –
// except work started with launchJob, which runs after its request answered.
//
// Progress is a share between 0 and 1, or null when the work cannot tell
// (the app then shows an indeterminate bar). Code deep inside a job reports
// with jobProgress() without knowing about jobs: the current job travels
// with the async context. Entries of a previous server process count as
// interrupted; finished ones are kept for a day and then removed.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { all, one, run } from "./db";
import type { Identity } from "./types";

export const jobKinds = ["import", "export", "archive", "git"] as const;
export type JobKind = (typeof jobKinds)[number];

const KEEP_MS = 24 * 3_600_000;
// A process id: jobs of an earlier run of the server cannot finish any more.
const BOOT = randomUUID();

const current = new AsyncLocalStorage<{ id: string; reported: number }>();

export async function startJob(user: Pick<Identity, "id">, kind: JobKind, label: string) {
  const jobId = randomUUID(),
    now = Date.now();
  await run(
    "INSERT INTO background_jobs(id,user_id,kind,label,progress,status,boot,started_at,updated_at) VALUES(?,?,?,?,NULL,'running',?,?,?)",
    jobId,
    user.id,
    kind,
    label.slice(0, 200),
    BOOT,
    now,
    now,
  );
  await run("DELETE FROM background_jobs WHERE updated_at<?", now - KEEP_MS);
  return jobId;
}

export async function finishJob(jobId: string, error?: unknown) {
  const now = Date.now();
  await run(
    "UPDATE background_jobs SET status=?,progress=CASE WHEN ?='done' THEN 1 ELSE progress END,error=?,updated_at=?,finished_at=? WHERE id=? AND status='running'",
    error === undefined ? "done" : "failed",
    error === undefined ? "done" : "failed",
    error === undefined ? null : String((error as Error)?.message || error).slice(0, 300),
    now,
    now,
    jobId,
  );
}

// The job's share of work done (0–1). At most every half second; outside a
// job it does nothing.
export async function jobProgress(share: number) {
  const job = current.getStore();
  if (!job || !Number.isFinite(share)) return;
  const now = Date.now();
  if (now - job.reported < 500 && share < 1) return;
  job.reported = now;
  try {
    await run(
      "UPDATE background_jobs SET progress=?,updated_at=? WHERE id=? AND status='running'",
      Math.max(0, Math.min(1, share)),
      now,
      job.id,
    );
  } catch {}
}

// Runs `work` as a job of the person: recorded while it runs, done or
// failed afterwards. The result (or error) of `work` passes through.
export async function trackJob<T>(user: Pick<Identity, "id">, kind: JobKind, label: string, work: () => T | Promise<T>): Promise<T> {
  let jobId: string | null = null;
  try {
    jobId = await startJob(user, kind, label);
  } catch {}
  if (!jobId) return await work();
  const id = jobId;
  try {
    const value = await current.run({ id, reported: 0 }, work);
    await finishJob(id);
    return value;
  } catch (error) {
    await finishJob(id, error);
    throw error;
  }
}

// Work that outlives its request (#163): a large import takes longer than a
// reverse proxy waits for an answer (504). The request only starts it and
// answers with the job's id; the work runs when `schedule` calls it (in a
// route: after the response, next/server after()), and the page asks for
// its progress and outcome (jobOutcome). Outcomes are kept in memory for an
// hour – a restart ends the work anyway (the job counts as interrupted).
type Outcome = { userId: string; kind: JobKind; at: number; done: boolean; value?: unknown; error?: unknown };
const outcomes = new Map<string, Outcome>();
const OUTCOME_MS = 3_600_000;
export async function launchJob<T>(
  user: Pick<Identity, "id">,
  kind: JobKind,
  label: string,
  work: () => T | Promise<T>,
  schedule: (task: () => Promise<void>) => void = (task) => void setImmediate(task),
) {
  const now = Date.now();
  for (const [id, outcome] of outcomes) if (outcome.done && now - outcome.at > OUTCOME_MS) outcomes.delete(id);
  const jobId = await startJob(user, kind, label);
  const outcome: Outcome = { userId: user.id, kind, at: now, done: false };
  outcomes.set(jobId, outcome);
  schedule(async () => {
    try {
      outcome.value = await current.run({ id: jobId, reported: 0 }, work);
      await finishJob(jobId).catch(() => {});
    } catch (error) {
      outcome.error = error;
      await finishJob(jobId, error).catch(() => {});
    } finally {
      outcome.done = true;
      outcome.at = Date.now();
    }
  });
  return jobId;
}
// A job of this kind the person started with launchJob that still runs.
export const runningJob = (user: Pick<Identity, "id">, kind: JobKind) =>
  [...outcomes.values()].some((outcome) => outcome.userId === user.id && outcome.kind === kind && !outcome.done);
// The state of a launched job of the person: running (with its progress),
// done (with the work's result) or failed (with the error thrown); null when
// it is not theirs or no longer known (a restart, or more than an hour ago).
export async function jobOutcome(
  user: Pick<Identity, "id">,
  jobId: string,
): Promise<{ status: "running"; progress: number | null } | { status: "done"; value: unknown } | { status: "failed"; error: unknown } | null> {
  const outcome = outcomes.get(jobId);
  if (!outcome || outcome.userId !== user.id) return null;
  if (outcome.done) return outcome.error === undefined ? { status: "done", value: outcome.value } : { status: "failed", error: outcome.error };
  const row = await one<{ progress: number | null }>("SELECT progress FROM background_jobs WHERE id=? AND user_id=?", jobId, user.id);
  return { status: "running", progress: row?.progress == null ? null : Math.round(row.progress * 100) / 100 };
}

// A download that is produced while it streams: the job ends with the stream.
export async function trackStream<S extends NodeJS.ReadableStream>(user: Pick<Identity, "id">, kind: JobKind, label: string, stream: S): Promise<S> {
  let jobId: string;
  try {
    jobId = await startJob(user, kind, label);
  } catch {
    return stream;
  }
  let ended = false;
  const end = async (error?: unknown) => {
    if (ended) return;
    ended = true;
    await finishJob(jobId, error);
  };
  stream.once("end", async () => await end());
  stream.once("error", async (error) => await end(error));
  stream.once("close", async () => await end(ended ? undefined : new Error("aborted")));
  return stream;
}

export type JobView = {
  id: string;
  kind: JobKind;
  label: string;
  status: "running" | "done" | "failed" | "interrupted";
  progress: number | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
};

// The person's running jobs and those that ended in the last `recentMs`.
export async function personJobs(user: Pick<Identity, "id">, recentMs = 10 * 60_000, now = Date.now()): Promise<JobView[]> {
  return (await all<{
    id: string;
    kind: JobKind;
    label: string;
    progress: number | null;
    status: "running" | "done" | "failed";
    error: string | null;
    boot: string;
    started_at: number;
    finished_at: number | null;
  }>(
    "SELECT * FROM background_jobs WHERE user_id=? AND (status='running' OR finished_at>=?) ORDER BY started_at DESC LIMIT 20",
    user.id,
    now - recentMs,
  )).map((job) => {
    const interrupted = job.status === "running" && job.boot !== BOOT;
    return {
      id: job.id,
      kind: job.kind,
      label: job.label,
      status: interrupted ? "interrupted" : job.status,
      progress: job.progress === null ? null : Math.round(job.progress * 100) / 100,
      error: job.error,
      startedAt: job.started_at,
      finishedAt: job.finished_at,
    };
  });
}
