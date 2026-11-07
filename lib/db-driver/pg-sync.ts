// A blocking bridge from the synchronous helpers of lib/db.ts (one, all,
// run, transaction) to PostgreSQL – only for the transition, while most of
// the code still calls them synchronously. A worker thread owns one
// Postgres connection; the calling thread posts the statement and waits on
// a shared flag (Atomics.wait) until the answer is there. It blocks the
// event loop for the round trip (~0.1 ms locally, a network hop otherwise),
// which is acceptable for an opt-in, single-instance Postgres setup while
// the code is ported file by file to the asynchronous `db`
// (lib/db-driver/index.ts), not for cluster mode.
//
// SQL arrives in the SQLite dialect. A few mechanical rewrites make the
// common cases run (INSERT OR IGNORE, IS NOT ?, ifnull, CURRENT_TIMESTAMP);
// anything else SQLite-only is refused with a hint (dialect.ts).
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";
import { currentTx, postgresSchema, postgresUrl } from "./context";
import { numberPlaceholders, postgresDialect, sqliteOnly } from "./dialect";

type Params = (string | number | null | Uint8Array)[];
export type LegacyPostgres = {
  one<T>(sql: string, params: Params): T | undefined;
  all<T>(sql: string, params: Params): T[];
  run(sql: string, params: Params): { changes: number; lastInsertRowid: number };
  transaction<T>(fn: () => T): T;
};
type Reply = { rows?: Record<string, unknown>[]; changes?: number; error?: { message: string; code?: string } };

const READ_ONLY = /^\s*(SELECT\b|WITH\b(?![\s\S]*\b(INSERT|UPDATE|DELETE)\b))/i;
const translations = new Map<string, string>();
// SQLite SQL → Postgres SQL, for the mechanical cases only.
export function legacyToPostgres(sql: string): string {
  let text = translations.get(sql);
  if (text !== undefined) return text;
  let out = sql;
  const ignore = /^\s*INSERT\s+OR\s+IGNORE\s+INTO\s+/i;
  if (ignore.test(out) && !/\bON\s+CONFLICT\b/i.test(out) && !/\bRETURNING\b/i.test(out))
    out = `${out.replace(ignore, "INSERT INTO ").replace(/;\s*$/, "")} ON CONFLICT DO NOTHING`;
  out = out
    .replace(/\bIS\s+NOT\s+\?/gi, "IS DISTINCT FROM ?")
    .replace(/\bifnull\s*\(/gi, "coalesce(")
    .replace(/\bLIMIT\s+-1\b/gi, "LIMIT ALL")
    .replace(/\bCURRENT_TIMESTAMP\b/g, postgresDialect.nowText());
  const hint = sqliteOnly(out);
  if (hint) throw new Error(`SQLite-only SQL reached Postgres (${hint}): ${sql.slice(0, 200)}`);
  text = numberPlaceholders(out);
  if (translations.size < 5000) translations.set(sql, text);
  return text;
}

export function legacyPostgres(): LegacyPostgres {
  const { port1, port2 } = new MessageChannel();
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(new URL("./pg-sync-worker.mjs", import.meta.url), {
    workerData: { url: postgresUrl(), schema: postgresSchema(), port: port2, signal },
    transferList: [port2],
  });
  worker.unref();
  port1.unref();
  let depth = 0;
  function call(message: { kind: string; sql: string; params?: Params }): Reply {
    // Inside an asynchronous transaction its connection waits for this
    // thread: a blocking write could wait for that transaction's row locks
    // forever, so it is refused. Reads never wait for row locks in
    // Postgres; they see what was committed before (not the transaction's
    // own changes).
    if (currentTx()?.backend === "postgres" && (message.kind === "run" || message.kind === "exec" || !READ_ONLY.test(message.sql)))
      throw new Error("Synchronous database write inside an asynchronous Postgres transaction: port the helper to the asynchronous db (lib/db-driver).");
    Atomics.store(signal, 0, 0);
    port1.postMessage(message);
    for (;;) {
      const waited = Atomics.wait(signal, 0, 0, 60_000);
      const received = receiveMessageOnPort(port1);
      if (received) {
        const reply = received.message as Reply;
        if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
        return reply;
      }
      if (waited === "timed-out") throw new Error("The Postgres bridge did not answer within 60 s.");
    }
  }
  const query = (kind: string, sql: string, params: Params) => call({ kind, sql: legacyToPostgres(sql), params });
  return {
    one: <T>(sql: string, params: Params) => (query("one", sql, params).rows ?? [])[0] as T | undefined,
    all: <T>(sql: string, params: Params) => (query("all", sql, params).rows ?? []) as T[],
    run: (sql: string, params: Params) => ({ changes: query("run", sql, params).changes ?? 0, lastInsertRowid: 0 }),
    transaction<T>(fn: () => T): T {
      // Not nested (lib/db.ts never nests transaction()); a nested call is a savepoint.
      const name = depth ? `legacy_${depth}` : "";
      call({ kind: "exec", sql: name ? `SAVEPOINT ${name}` : "BEGIN" });
      depth++;
      try {
        const value = fn();
        call({ kind: "exec", sql: name ? `RELEASE SAVEPOINT ${name}` : "COMMIT" });
        return value;
      } catch (error) {
        call({ kind: "exec", sql: name ? `ROLLBACK TO SAVEPOINT ${name}` : "ROLLBACK" });
        throw error;
      } finally {
        depth--;
      }
    },
  };
}
