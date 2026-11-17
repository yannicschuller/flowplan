// Dedicated PostgreSQL connections per process, outside the pool, for
// what needs a session of its own: LISTEN (notifications arrive on the
// connection that listens) and the leader's session-level advisory lock
// (lib/cluster/leader.ts; held as long as the connection lives, so a crashed
// or cut-off leader frees it by itself) on one, the locks of the leader's
// running rounds on a second ("duties"). Each reconnects with a growing
// pause (and listens again); the leader election learns that its lock is
// gone.
import pg from "pg";
import { postgresSchema, postgresSessionUrl } from "../db-driver/context";
import { configureTypes } from "../db-driver/pg-types.mjs";

configureTypes(pg);

type Listener = (payload: string) => void;
type State = {
  name: string;
  client: pg.Client | null;
  connecting: Promise<pg.Client> | null;
  listeners: Map<string, Set<Listener>>;
  // Bumped on every new connection: session-level state (locks) of an
  // older one is gone.
  generation: number;
  attempt: number;
  closed: boolean;
  lastError: string | null;
  timer?: ReturnType<typeof setTimeout>;
};
// "session": LISTEN and the leader lock. "duties": the per-duty locks of
// the leader's rounds (lib/cluster/leader.ts) – on a connection of their
// own, so that losing the leader's connection does not also drop the lock
// of a round still running on it.
type Name = "session" | "duties";
const holder = globalThis as unknown as { flowplanPgSession?: State; flowplanPgSessions?: Map<Name, State> };
const fresh = (name: Name): State => ({ name, client: null, connecting: null, listeners: new Map(), generation: 0, attempt: 0, closed: false, lastError: null });
const state = (name: Name = "session"): State => {
  const all = (holder.flowplanPgSessions ??= new Map());
  let s = all.get(name);
  if (!s) all.set(name, (s = name === "session" ? (holder.flowplanPgSession ??= fresh(name)) : fresh(name)));
  return s;
};

// Channel names are per schema: tests run one schema per process on one
// database, and two installations may share a database.
export const channelName = (base: string) => `${base}_${postgresSchema()}`.slice(0, 63);
const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

export function sessionGeneration() {
  return state().generation;
}
export function sessionConnected() {
  return !!state().client;
}
export function sessionError() {
  return state().lastError;
}

// The connection, opened if needed.
export function sessionClient(name: Name = "session"): Promise<pg.Client> {
  const s = state(name);
  if (s.client) return Promise.resolve(s.client);
  return (s.connecting ??= open(s).finally(() => {
    s.connecting = null;
  }));
}

async function open(s: State): Promise<pg.Client> {
  const url = postgresSessionUrl();
  if (!url) throw new Error("No PostgreSQL database (DATABASE_URL)");
  s.closed = false;
  const client = new pg.Client({
    connectionString: url,
    options: `-c search_path=${postgresSchema()} -c statement_timeout=30000 -c idle_in_transaction_session_timeout=60000`,
    application_name: `flowplan-${s.name}${process.env.FLOWPLAN_INSTANCE_ID ? `:${process.env.FLOWPLAN_INSTANCE_ID}` : ""}`.slice(0, 63),
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
  });
  client.on("error", (error) => {
    s.lastError = error.message;
  });
  client.on("notification", (message) => {
    for (const listener of s.listeners.get(message.channel) ?? [])
      try {
        listener(message.payload ?? "");
      } catch (error) {
        console.error("Postgres notification handler failed", error);
      }
  });
  client.on("end", () => {
    if (s.client !== client) return;
    s.client = null;
    if (s.closed) return;
    const pause = Math.min(10_000, 250 * 2 ** s.attempt++);
    s.timer = setTimeout(() => void sessionClient(s.name as Name).catch((error) => (s.lastError = (error as Error).message)), pause);
    s.timer.unref?.();
  });
  try {
    await client.connect();
  } catch (error) {
    s.lastError = (error as Error).message;
    const pause = Math.min(10_000, 250 * 2 ** s.attempt++);
    if (s.listeners.size && !s.closed) {
      s.timer = setTimeout(() => void sessionClient(s.name as Name).catch(() => {}), pause);
      s.timer.unref?.();
    }
    throw error;
  }
  // The connection must not keep scripts and tests alive.
  (client as unknown as { connection?: { stream?: { unref?: () => void } } }).connection?.stream?.unref?.();
  for (const channel of s.listeners.keys()) await client.query(`LISTEN ${quote(channel)}`);
  s.client = client;
  s.generation++;
  s.attempt = 0;
  s.lastError = null;
  return client;
}

// Calls `listener` for every NOTIFY on `channel` (the full name, see
// channelName()). Returns the function that stops listening.
export async function listen(channel: string, listener: Listener): Promise<() => void> {
  const s = state();
  let set = s.listeners.get(channel);
  const first = !set;
  if (!set) s.listeners.set(channel, (set = new Set()));
  set.add(listener);
  if (first && s.client) await s.client.query(`LISTEN ${quote(channel)}`);
  else if (!s.client) await sessionClient();
  return () => {
    set.delete(listener);
    if (!set.size) {
      s.listeners.delete(channel);
      void s.client?.query(`UNLISTEN ${quote(channel)}`).catch(() => {});
    }
  };
}

// A query on the session connection (advisory locks of the leader).
export async function sessionQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values: unknown[] = []) {
  const client = await sessionClient();
  return client.query<T>(text, values);
}
// A query on the duties connection (the locks of running leader rounds).
export async function dutySessionQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values: unknown[] = []) {
  const client = await sessionClient("duties");
  return client.query<T>(text, values);
}
export const dutySessionGeneration = () => state("duties").generation;

// Closes both connections (graceful shutdown, tests).
export async function closeSession() {
  await Promise.all(
    (["session", "duties"] as const).map(async (name) => {
      const s = state(name);
      s.closed = true;
      if (s.timer) clearTimeout(s.timer);
      const client = s.client;
      s.client = null;
      s.listeners.clear();
      await client?.end().catch(() => {});
    }),
  );
}
