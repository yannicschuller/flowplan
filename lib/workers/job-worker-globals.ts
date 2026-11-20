// What Next.js's server sets up before any module runs and a worker thread
// lacks: modules of the job graph reach next/headers (lib/auth.ts), whose
// request storage is created from globalThis.AsyncLocalStorage at load
// ("Invariant: AsyncLocalStorage accessed in runtime where it is not
// available" otherwise). Imported first by lib/workers/job-worker.ts.
import { AsyncLocalStorage } from "node:async_hooks";

const holder = globalThis as { AsyncLocalStorage?: typeof AsyncLocalStorage };
holder.AsyncLocalStorage ??= AsyncLocalStorage;
