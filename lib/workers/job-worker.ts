// A worker thread of lib/worker-pool.ts: runs one job of lib/worker-jobs.ts
// at a time and answers with its result (or its error, serialised). It
// reads the database on a read-only connection of its own (workerData
// flowplanDbReader, lib/db-driver/context.ts); its audit entries go back
// with the result, the request thread writes them.
import { parentPort } from "node:worker_threads";
import { workerJobs } from "../worker-jobs";
import { collectingAudits, noteUnknownWrite } from "../db";
import { withContentLocale } from "../content-locale";
import { withReadMemo } from "../read-memo";
import { serializeError, transferables, type JobMessage, type ResultMessage } from "../worker-pool";
import type { Locale } from "../i18n";

const port = parentPort!;
// A rejection nobody awaits must not end the thread (and every job with it).
process.on("unhandledRejection", (error) => console.error("Worker thread: unhandled rejection", error));

port.on("message", async (message: JobMessage) => {
  let answer: ResultMessage;
  try {
    // The request thread writes between jobs: nothing remembered here
    // from an earlier job counts (lib/read-memo.ts, lib/kept-answers.ts).
    noteUnknownWrite();
    const job = workerJobs[message.name] as (...args: unknown[]) => Promise<unknown>;
    if (!job) throw new Error(`Unknown worker job: ${message.name}`);
    const { value, audits } = await collectingAudits(() => withContentLocale(message.locale as Locale, () => withReadMemo(() => job(...message.args))));
    answer = { id: message.id, value, audits };
  } catch (error) {
    answer = { id: message.id, error: serializeError(error) };
  }
  try {
    port.postMessage(answer, "value" in answer ? transferables(answer.value) : []);
  } catch (error) {
    port.postMessage({ id: message.id, error: serializeError(error) } satisfies ResultMessage);
  }
});
port.postMessage({ ready: true } satisfies ResultMessage);
