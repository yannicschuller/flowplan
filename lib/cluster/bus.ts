// What one instance tells the others, through Redis pub/sub (cluster mode):
// Yjs updates and "check" signals of open documents, editor and whiteboard
// presence, board signals – everything the in-process hubs
// (lib/document-live.ts, lib/whiteboard-presence.ts) deliver to the
// server-sent event streams of their own instance. A hub delivers locally
// first and then publishes; the other instances deliver what they receive
// to their own listeners. Messages are signals, not storage: PostgreSQL
// stays the source of truth, and a missed message is caught up by the
// clients' "check" (they fetch the current state).
//
// Single container (no cluster mode): publish() does nothing, there is no
// other instance.
import { clusterMode, instanceId, redisPrefix } from "./config";
import { RedisClient } from "./redis";

type Handler = (payload: unknown, origin: string) => void;
type State = {
  commands: RedisClient | null;
  subscriber: RedisClient | null;
  handlers: Map<string, Set<Handler>>;
  subscribed: Promise<unknown> | null;
  published: number;
  received: number;
  failed: number;
};
const holder = globalThis as unknown as { flowplanBus?: State };
const state = (): State =>
  (holder.flowplanBus ??= { commands: null, subscriber: null, handlers: new Map(), subscribed: null, published: 0, received: 0, failed: 0 });

const busChannel = () => `${redisPrefix()}bus`;

// The command connection of this process (rate limits, heartbeats, the bus).
export function redis(): RedisClient {
  const s = state();
  const url = process.env.REDIS_URL?.trim();
  if (!url) throw new Error("REDIS_URL is not set");
  return (s.commands ??= new RedisClient(url, { name: `flowplan:${instanceId()}` }));
}
function subscriber(): RedisClient {
  const s = state();
  return (s.subscriber ??= new RedisClient(process.env.REDIS_URL!.trim(), { subscriber: true, name: `flowplan-sub:${instanceId()}` }));
}

// Starts listening to the other instances (cluster mode; idempotent).
export function startBus(): Promise<unknown> {
  const s = state();
  if (!clusterMode()) return Promise.resolve();
  return (s.subscribed ??= subscriber()
    .subscribe(busChannel(), (raw) => {
      let message: { o: string; t: string; p: unknown };
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }
      if (!message || message.o === instanceId()) return;
      s.received++;
      for (const handler of s.handlers.get(message.t) ?? [])
        try {
          handler(message.p, message.o);
        } catch (error) {
          console.error(`Cluster bus: handler for ${message.t} failed`, error);
        }
    })
    .catch((error) => {
      s.subscribed = null;
      console.error("Cluster bus: cannot subscribe", error);
    }));
}

// Handles messages of `topic` from the other instances.
export function onBus(topic: string, handler: Handler) {
  const s = state();
  let set = s.handlers.get(topic);
  if (!set) s.handlers.set(topic, (set = new Set()));
  set.add(handler);
  return () => set.delete(handler);
}

// Sends to the other instances (fire and forget; cluster mode only).
export function publish(topic: string, payload: unknown) {
  if (!clusterMode()) return;
  const s = state();
  s.published++;
  void redis()
    .command("PUBLISH", busChannel(), JSON.stringify({ o: instanceId(), t: topic, p: payload }))
    .catch((error) => {
      s.failed++;
      if (s.failed % 100 === 1) console.error("Cluster bus: publish failed", (error as Error).message);
    });
}

export function busStats() {
  const s = state();
  return {
    connected: !!s.commands?.connected,
    subscribed: !!s.subscriber?.connected,
    published: s.published,
    received: s.received,
    failed: s.failed,
    lastError: s.commands?.lastError || s.subscriber?.lastError || null,
  };
}

export async function closeBus() {
  const s = state();
  const { commands, subscriber: sub } = s;
  s.commands = s.subscriber = null;
  s.subscribed = null;
  await Promise.all([commands?.close(), sub?.close()]);
}
