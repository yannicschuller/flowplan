// Long-running work a person started – imports (Notion/Confluence/Evernote/
// Obsidian/Google Docs, ZIP, Jira/Trello, Markdown records, Flowplan
// archives), exports (Markdown, archive) and the Git export of a space –
// as small entries with a progress, so the mobile app can show them as a
// Live Activity (lib/mobile-widgets.ts, kind "jobs"). The work itself runs
// where it always ran (in its request); this only records that it runs.
//
// Progress is a share between 0 and 1, or null when the work cannot tell
// (the app then shows an indeterminate bar). Code deep inside a job reports
// with jobProgress() without knowing about jobs: the current job travels
// with the async context. Entries of a previous server process count as
// interrupted; finished ones are kept for a day and then removed.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { all, run } from "./db";
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
