"use client";
// Parts of the app load on demand (next/dynamic): the editor, database
// views, dashboards, whiteboards, notebooks … Without a connection one that
// is not in the offline copy cannot load (#47). Instead of taking the whole
// interface down, the part shows a message with "Try again", and tries
// again by itself once the connection is back.
import { createElement, useCallback, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { catchError, type ErrorInfo } from "next/error";
import { CloudSlash, WarningCircle } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { STALE_CHUNK_EVENT } from "@/lib/stale-copy";

const online = () => typeof navigator === "undefined" || navigator.onLine !== false;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The message in place of a part that could not load (or crashed).
export function ViewUnavailable({ onRetry, busy = false }: { onRetry: () => void; busy?: boolean }) {
  const t = useT();
  const [offline, setOffline] = useState(!online());
  useEffect(() => {
    const update = () => setOffline(!online());
    // Back online: try again without a tap.
    const back = () => {
      update();
      onRetry();
    };
    window.addEventListener("online", back);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", back);
      window.removeEventListener("offline", update);
    };
  }, [onRetry]);
  return (
    <div className="empty-state small view-unavailable" role="alert" data-offline={offline || undefined}>
      {offline ? <CloudSlash size={28} aria-hidden /> : <WarningCircle size={28} aria-hidden />}
      <p>
        {offline
          ? t("Nicht offline verfügbar – versuche es wieder, wenn du online bist.", "Not available offline – try again when you're online.")
          : t("Dieser Teil der App konnte nicht geladen werden.", "This part of the app could not be loaded.")}
      </p>
      <button type="button" className="button" disabled={busy} onClick={onRetry}>
        {t("Erneut versuchen", "Try again")}
      </button>
    </div>
  );
}

// Retry wrapper for dynamic imports:
//   dynamic(() => loadView(() => import("./editor")), { ssr: false })
// A failed import is tried once more (a short hiccup); if it still fails,
// the part resolves to a stand-in that shows ViewUnavailable and loads the
// real component on "Try again" or when the connection is back. The loader
// itself never rejects: React.lazy keeps a rejected import for good, so a
// rejection could not be retried without reloading the page.
export function loadView<M extends { default: ComponentType<never> }>(load: () => Promise<M>): Promise<M> {
  return load().catch(async () => {
    if (online()) {
      await wait(500);
      try {
        return await load();
      } catch {
        // Online and still missing: perhaps the page is of an older build
        // than the server's – the page's check (lib/stale-copy.ts) loads
        // the live one then.
        window.dispatchEvent(new Event(STALE_CHUNK_EVENT));
      }
    }
    type Props = M["default"] extends ComponentType<infer P> ? P : never;
    let loaded: ComponentType<Props> | null = null;
    let pending: Promise<void> | null = null;
    const again = () =>
      (pending ??= load()
        .then((mod) => {
          loaded = mod.default as unknown as ComponentType<Props>;
        })
        .finally(() => {
          pending = null;
        }));
    function Unavailable(props: Props) {
      const [, setVersion] = useState(0);
      const [busy, setBusy] = useState(false);
      const retry = useCallback(() => {
        setBusy(true);
        again()
          .catch(() => {})
          .finally(() => {
            setBusy(false);
            setVersion((v) => v + 1);
          });
      }, []);
      if (loaded) return createElement(loaded as ComponentType<object>, props as object);
      return <ViewUnavailable onRetry={retry} busy={busy} />;
    }
    return { default: Unavailable } as unknown as M;
  });
}

// Error boundary around a part of the app (catchError, next/error): an
// error while it renders shows ViewUnavailable instead of an empty screen.
// "Try again" renders the part anew (reset: nothing to fetch from the
// server, which may be out of reach).
function Fallback(_props: object, { error, reset }: ErrorInfo) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return <ViewUnavailable onRetry={reset} />;
}
const Boundary = catchError(Fallback) as ComponentType<{ children?: ReactNode }>;
export function ViewBoundary({ children }: { children: ReactNode }) {
  return <Boundary>{children}</Boundary>;
}
