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
//
// Everything lives in the database (background_jobs), so in cluster mode
// any instance answers: the job runs on one instance, which marks its row
// alive every 15 s; a job of another process not marked for a minute
// counts as interrupted (its instance stopped or crashed). Outside cluster
// mode there is no other process: a job of an earlier one is interrupted.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { all, one, run } from "./db";
import { HttpError } from "./auth";
import type { Identity } from "./types";
import { enterArea, shiftArea } from "./server-metrics";
import { clusterMode, instanceId } from "./cluster/config";
import { captureJobError } from "./error-details";

export const jobKinds = ["import", "export", "archive", "git"] as const;
export type JobKind = (typeof jobKinds)[number];

const KEEP_MS = 24 * 3_600_000;
// A process id: jobs of an earlier run of the server cannot finish any more.
// (Not the instance id: FLOWPLAN_INSTANCE_ID may stay the same across a
// restart of the container.)
const BOOT = randomUUID();
// The instance running a job marks it alive this often; a job of another
// process not marked for JOB_ALIVE_LIMIT counts as interrupted.
export const JOB_ALIVE_EVERY = 15_000;
export const JOB_ALIVE_LIMIT = 60_000;
const alive = globalThis as unknown as { flowplanJobsAlive?: Map<string, ReturnType<typeof setInterval>> };
const aliveTimers = () => (alive.flowplanJobsAlive ??= new Map());

// Whether a row in state "running" no longer runs anywhere.
const isInterrupted = (job: { status: string; boot: string; updated_at: number | string }, now: number) =>
  job.status === "running" && job.boot !== BOOT && (!clusterMode() || now - Number(job.updated_at) > JOB_ALIVE_LIMIT);

const current = new AsyncLocalStorage<{ id: string; reported: number }>();

export async function startJob(user: Pick<Identity, "id">, kind: JobKind, label: string, options: { launched?: boolean } = {}) {
  const jobId = randomUUID(),
    now = Date.now();
  await run(
    "INSERT INTO background_jobs(id,user_id,kind,label,progress,status,boot,started_at,updated_at,launched,instance) VALUES(?,?,?,?,NULL,'running',?,?,?,?,?)",
    jobId,
    user.id,
    kind,
    label.slice(0, 200),
    BOOT,
    now,
    now,
    options.launched ? 1 : 0,
    instanceId(),
  );
  await sweepBackgroundJobs(now);
  const timer = setInterval(() => void run("UPDATE background_jobs SET updated_at=? WHERE id=? AND status='running'", Date.now(), jobId).catch(() => {}), JOB_ALIVE_EVERY);
  timer.unref?.();
  aliveTimers().set(jobId, timer);
  return jobId;
}

// Rows older than a day go; outcomes past their hour are emptied (they can
// be large: an import's preview). On every start and in the leader's
// sweep (lib/admin-ops.ts).
export async function sweepBackgroundJobs(now = Date.now()) {
  await run("DELETE FROM background_jobs WHERE updated_at<?", now - KEEP_MS);
  await run("UPDATE background_jobs SET outcome=NULL WHERE outcome IS NOT NULL AND expires_at<?", now);
}

// `outcome`: what the poll of a launched job answers (see launchJob), as JSON.
export async function finishJob(jobId: string, error?: unknown, outcome?: string) {
  clearInterval(aliveTimers().get(jobId));
  aliveTimers().delete(jobId);
  const now = Date.now();
  await run(
    "UPDATE background_jobs SET status=?,progress=CASE WHEN ?='done' THEN 1 ELSE progress END,error=?,updated_at=?,finished_at=?,outcome=?,expires_at=? WHERE id=? AND status='running'",
    error === undefined ? "done" : "failed",
    error === undefined ? "done" : "failed",
    error === undefined ? null : String((error as Error)?.message || error).slice(0, 300),
    now,
    now,
    outcome ?? null,
    outcome === undefined ? null : now + OUTCOME_MS,
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
  // The request's CPU counts as background job while it runs (lib/server-metrics.ts).
  const area = shiftArea("api", "jobs");
  try {
    const value = await current.run({ id, reported: 0 }, work);
    area();
    await finishJob(id);
    return value;
  } catch (error) {
    area();
    await finishJob(id, error);
    throw error;
  }
}

// Work that outlives its request (#163): a large import takes longer than a
// reverse proxy waits for an answer (504). The request only starts it and
// answers with the job's id; the work runs when `schedule` calls it (in a
// route: after the response, next/server after()), and the page asks for
// its progress and outcome (jobOutcome) – on whichever instance its request
// lands. The outcome (the work's result, or the error it threw) is kept in
// the job's row for an hour; a restart ends the work (the job counts as
// interrupted).
const OUTCOME_MS = 3_600_000;
export async function launchJob<T>(
  user: Pick<Identity, "id">,
  kind: JobKind,
  label: string,
  work: () => T | Promise<T>,
  schedule: (task: () => Promise<void>) => void = (task) => void setImmediate(task),
) {
  const jobId = await startJob(user, kind, label, { launched: true });
  schedule(async () => {
    const area = enterArea("jobs");
    try {
      const value = await current.run({ id: jobId, reported: 0 }, work);
      await finishJob(jobId, undefined, JSON.stringify({ value: value === undefined ? null : value }));
    } catch (error) {
      // After its request: only the error details of the monitoring see it.
      captureJobError(kind, error);
      await finishJob(jobId, error, JSON.stringify({ error: storedError(error) })).catch(() => {});
    } finally {
      area();
    }
  });
  return jobId;
}

// An error as the job's row keeps it, and back: what the route makes of it
// (app/api/[...path]/handler.ts error()) stays the same – the status and text
// of an HttpError, the messages of invalid input, a 500 for anything else.
type StoredError =
  | { kind: "http"; status: number; message: string }
  | { kind: "input"; issues: { path: (string | number)[]; message: string }[] }
  | { kind: "other"; message: string };
export function storedError(error: unknown): StoredError {
  if (error instanceof HttpError) return { kind: "http", status: error.status, message: error.message.slice(0, 2000) };
  if (error instanceof z.ZodError)
    return {
      kind: "input",
      issues: error.issues.slice(0, 50).map((i) => ({ path: i.path.filter((p): p is string | number => typeof p !== "symbol"), message: i.message.slice(0, 500) })),
    };
  return { kind: "other", message: String((error as Error)?.message || error).slice(0, 2000) };
}
export function restoredError(stored: StoredError | undefined): Error {
  if (stored?.kind === "http") return new HttpError(stored.status, stored.message);
  if (stored?.kind === "input") return new z.ZodError(stored.issues.map((i) => ({ code: "custom" as const, path: i.path, message: i.message, input: undefined })));
  return new Error(stored?.message || "Job failed");
}

// A job of this kind the person started with launchJob that still runs –
// on any instance of the installation (a job of a stopped instance does
// not count, see isInterrupted).
export async function runningJob(user: Pick<Identity, "id">, kind: JobKind, now = Date.now()) {
  const rows = await all<{ status: string; boot: string; updated_at: number }>(
    "SELECT status,boot,updated_at FROM background_jobs WHERE user_id=? AND kind=? AND status='running' AND launched=1",
    user.id,
    kind,
  );
  return rows.some((job) => !isInterrupted(job, now));
}
// The state of a launched job of the person: running (with its progress),
// done (with the work's result) or failed (with the error thrown); null when
// it is not theirs or no longer known (its instance stopped, or it ended
// more than an hour ago).
export async function jobOutcome(
  user: Pick<Identity, "id">,
  jobId: string,
  now = Date.now(),
): Promise<{ status: "running"; progress: number | null } | { status: "done"; value: unknown } | { status: "failed"; error: unknown } | null> {
  const row = await one<{ status: "running" | "done" | "failed"; progress: number | null; boot: string; updated_at: number; outcome: string | null; expires_at: number | null }>(
    "SELECT status,progress,boot,updated_at,outcome,expires_at FROM background_jobs WHERE id=? AND user_id=? AND launched=1",
    jobId,
    user.id,
  );
  if (!row) return null;
  if (row.status === "running") {
    if (isInterrupted(row, now)) return null;
    return { status: "running", progress: row.progress == null ? null : Math.round(row.progress * 100) / 100 };
  }
  if (!row.outcome || (row.expires_at !== null && Number(row.expires_at) < now)) return null;
  let parsed: { value?: unknown; error?: StoredError };
  try {
    parsed = JSON.parse(row.outcome);
  } catch {
    return null;
  }
  return row.status === "done" ? { status: "done", value: parsed.value } : { status: "failed", error: restoredError(parsed.error) };
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
    updated_at: number;
    started_at: number;
    finished_at: number | null;
  }>(
    "SELECT * FROM background_jobs WHERE user_id=? AND (status='running' OR finished_at>=?) ORDER BY started_at DESC LIMIT 20",
    user.id,
    now - recentMs,
  )).map((job) => {
    const interrupted = isInterrupted(job, now);
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
