// The run a write happens in (docs/specs/workflows.md §8.2 "Kaskade"): a
// workflow step carries its run through AsyncLocalStorage, so every event
// its writes cause names the run (origin_run_id) and one more depth – the
// cascade limit counts on it, and a workflow does not trigger itself
// unless it asks to. Not a global like quietly() in lib/webhooks.ts: steps
// of different runs run at the same time.
import { AsyncLocalStorage } from "node:async_hooks";

export type RunContext = { runId: string; pageId: string; depth: number; mode: "live" | "test" | "dry" };
const store = ((globalThis as { flowplanWorkflowRun?: AsyncLocalStorage<RunContext> }).flowplanWorkflowRun ??= new AsyncLocalStorage<RunContext>());

export const currentRun = () => store.getStore();
export const withinRun = <T>(ctx: RunContext, fn: () => T): T => store.run(ctx, fn);
