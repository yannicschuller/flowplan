// The worker of the blocking Postgres bridge (pg-sync.ts): runs one
// statement at a time on its own connection and wakes the waiting thread.
// Plain JavaScript: worker threads start without the TypeScript loader.
import { workerData } from "node:worker_threads";
import pg from "pg";
import { configureTypes } from "./pg-types.mjs";

const { url, schema, port, signal } = workerData;
configureTypes(pg);
const client = new pg.Client({ connectionString: url, options: `-c search_path=${schema} -c lock_timeout=10000` });
const ready = client.connect();
const value = (v) => (v instanceof Uint8Array && !Buffer.isBuffer(v) ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : v);

port.on("message", async (message) => {
  let reply;
  try {
    await ready;
    const result = message.kind === "exec" ? await client.query(message.sql) : await client.query(message.sql, (message.params || []).map(value));
    reply = { rows: message.kind === "one" ? result.rows.slice(0, 1) : message.kind === "all" ? result.rows : undefined, changes: result.rowCount ?? 0 };
  } catch (error) {
    reply = { error: { message: error?.message || String(error), code: error?.code } };
  }
  port.postMessage(reply);
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
});
