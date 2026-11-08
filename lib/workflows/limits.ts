// Limits and switches of workflows (docs/specs/workflows.md §12):
// environment variables are the defaults, values stored by an
// administrator (instance setting `workflowLimits`) take precedence; a
// workflow may set lower values for itself, never higher ones.
import { z } from "zod";
import { all } from "../db";

const LIMITS = {
  runsPerMinute: { env: "FLOWPLAN_WORKFLOW_RUNS_PER_MINUTE", fallback: 60, min: 1, max: 1000 },
  workspaceRunsPerMinute: { env: "FLOWPLAN_WORKFLOW_WORKSPACE_RUNS_PER_MINUTE", fallback: 600, min: 1, max: 10_000 },
  stepsPerRun: { env: "FLOWPLAN_WORKFLOW_STEPS_PER_RUN", fallback: 200, min: 10, max: 2000 },
  cascadeDepth: { env: "FLOWPLAN_WORKFLOW_CASCADE_DEPTH", fallback: 5, min: 1, max: 10 },
  foreachMax: { env: "FLOWPLAN_WORKFLOW_FOREACH_MAX", fallback: 100, min: 1, max: 1000 },
  aiTokensPerDay: { env: "FLOWPLAN_WORKFLOW_AI_TOKENS_PER_DAY", fallback: 100_000, min: 0, max: 100_000_000 },
  mailsPerDay: { env: "FLOWPLAN_WORKFLOW_MAILS_PER_DAY", fallback: 100, min: 0, max: 10_000 },
  runDays: { env: "FLOWPLAN_WORKFLOW_RUN_DAYS", fallback: 30, min: 1, max: 365 },
  maxWaitDays: { env: "FLOWPLAN_WORKFLOW_MAX_WAIT_DAYS", fallback: 365, min: 1, max: 3650 },
  activePerWorkspace: { env: "FLOWPLAN_WORKFLOW_ACTIVE_PER_WORKSPACE", fallback: 100, min: 1, max: 10_000 },
  workers: { env: "FLOWPLAN_WORKFLOW_WORKERS", fallback: 4, min: 1, max: 64 },
  // Not in the table of §12: further limits of §8.8/§9.10 as constants.
  testRunsPerMinute: { env: "FLOWPLAN_WORKFLOW_TEST_RUNS_PER_MINUTE", fallback: 10, min: 1, max: 1000 },
  parallelRuns: { env: "FLOWPLAN_WORKFLOW_PARALLEL_RUNS", fallback: 10, min: 1, max: 100 },
  runsPerWorkflow: { env: "FLOWPLAN_WORKFLOW_RUNS_KEPT", fallback: 10_000, min: 100, max: 1_000_000 },
} as const;
const SWITCHES = {
  enabled: { env: "FLOWPLAN_WORKFLOWS", fallback: true },
  http: { env: "FLOWPLAN_WORKFLOW_HTTP", fallback: true },
  httpAllowPrivate: { env: "FLOWPLAN_WORKFLOW_HTTP_ALLOW_PRIVATE", fallback: false },
  externalMail: { env: "FLOWPLAN_WORKFLOW_EXTERNAL_MAIL", fallback: true },
} as const;
export type WorkflowLimitName = keyof typeof LIMITS;
export type WorkflowSwitchName = keyof typeof SWITCHES;
export type WorkflowLimits = Record<WorkflowLimitName, number> & Record<WorkflowSwitchName, boolean> & { httpHosts: string[] };

const boolEnv = (raw: string | undefined, fallback: boolean) => {
  if (raw === undefined || raw.trim() === "") return fallback;
  return !/^(off|false|0|no)$/i.test(raw.trim());
};
// The defaults from the environment (invalid values fall back to the standard).
export function envLimits(env: Record<string, string | undefined> = process.env): WorkflowLimits {
  const out = {} as WorkflowLimits;
  for (const [name, l] of Object.entries(LIMITS)) {
    const n = Number(env[l.env]);
    (out as Record<string, number>)[name] = env[l.env] && Number.isInteger(n) && n >= l.min && n <= l.max ? n : l.fallback;
  }
  for (const [name, s] of Object.entries(SWITCHES)) (out as Record<string, boolean>)[name] = boolEnv(env[s.env], s.fallback);
  out.httpHosts = (env.FLOWPLAN_WORKFLOW_HTTP_HOSTS || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return out;
}

// What an administrator may store (all optional: unset follows the environment).
export const workflowLimitsSchema = z
  .object({
    ...Object.fromEntries(Object.entries(LIMITS).map(([name, l]) => [name, z.number().int().min(l.min).max(l.max).nullable().optional()])),
    ...Object.fromEntries(Object.keys(SWITCHES).filter((n) => n !== "httpAllowPrivate").map((name) => [name, z.boolean().nullable().optional()])),
    httpHosts: z.array(z.string().trim().toLowerCase().max(253)).max(200).nullable().optional(),
  })
  .strict();
export type StoredWorkflowLimits = z.infer<typeof workflowLimitsSchema>;

export async function storedWorkflowLimits(): Promise<StoredWorkflowLimits> {
  try {
    const row = (await all<{ value: string }>("SELECT value FROM instance_settings WHERE key='workflowLimits'"))[0];
    const parsed = workflowLimitsSchema.safeParse(row ? JSON.parse(row.value) : {});
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}
// The limits in force: stored values over the environment's.
export async function workflowLimits(): Promise<WorkflowLimits> {
  const base = envLimits();
  const stored = await storedWorkflowLimits();
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(stored)) if (v !== null && v !== undefined) out[k] = v;
  return out as WorkflowLimits;
}
// A workflow's own lower value, never a higher one.
export const lower = (instance: number, own: number | undefined) => (own && own < instance ? own : instance);
export const LIMIT_RANGES = LIMITS;
