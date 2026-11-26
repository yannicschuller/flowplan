// Route handlers that read cookies() / headers() from next/headers need
// the request scope Next.js puts around them. This builds that scope with
// Next's own store factories (the ones its app-route module uses), so a
// test can call a handler with a plain Request – session cookie and all –
// without a server or a build. `after()` callbacks run once the handler
// has answered (collected in `settled`).
//
//   const res = await inRequestScope(req, () => handler.POST(req, { params }));
//
// Import this before anything that loads Next: its AsyncLocalStorage
// stand-in is chosen when its modules load.
await import("next/dist/server/node-environment-baseline.js" as string);
const { createRequestStoreForAPI } = (await import("next/dist/server/async-storage/request-store.js" as string)) as {
  createRequestStoreForAPI: (req: Request, url: URL, tags: unknown, onUpdateCookies?: unknown, preview?: unknown, hmr?: unknown) => unknown;
};
const { createWorkStore } = (await import("next/dist/server/async-storage/work-store.js" as string)) as {
  createWorkStore: (context: Record<string, unknown>) => unknown;
};
const { workAsyncStorage } = (await import("next/dist/server/app-render/work-async-storage.external.js" as string)) as {
  workAsyncStorage: { run<T>(store: unknown, fn: () => T): T };
};
const { workUnitAsyncStorage } = (await import("next/dist/server/app-render/work-unit-async-storage.external.js" as string)) as {
  workUnitAsyncStorage: { run<T>(store: unknown, fn: () => T): T };
};

export async function inRequestScope<T>(req: Request, fn: () => Promise<T>): Promise<{ value: T; settled: Promise<unknown> }> {
  const pending: Promise<unknown>[] = [];
  const closers: (() => void)[] = [];
  const work = createWorkStore({
    page: "/api/[...path]/route",
    renderOpts: {
      experimental: {},
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      onClose: (callback: () => void) => closers.push(callback),
      onAfterTaskError: (error: unknown) => pending.push(Promise.reject(error)),
    },
    isPrefetchRequest: false,
    buildId: "test",
    previouslyRevalidatedTags: [],
  });
  const unit = createRequestStoreForAPI(req, new URL(req.url), { tags: [], expirationsByCacheKind: new Map() });
  const value = await workAsyncStorage.run(work, () => workUnitAsyncStorage.run(unit, fn));
  for (const close of closers.splice(0)) close();
  return { value, settled: Promise.allSettled(pending) };
}
