"use client";
// "Beim Öffnen auf dem Handy: Schnellerfassung" (lib/start-screen.ts): the
// root page renders this instead of the workspace when the person chose
// the quick capture and the request came from a phone (app/page.tsx). On
// the device it decides (startDecision): the bare address on a phone shows
// the capture at once – the workspace's JavaScript is not needed for it and
// loads in the background –, anything else (a deep link, a larger screen)
// the workspace as always. Saving offline waits in the offline queue
// (components/offline-queue.tsx), which the workspace sends later.
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import { Check } from "@phosphor-icons/react";
import { startDecision } from "@/lib/start-screen";
import { nativeRefresh } from "@/lib/native-app";
import { AiProvider } from "./ai-context";
import { useT } from "./i18n";
import { isQueueable, useOfflineQueue } from "./offline-queue";
import { QuickCapture } from "./quick-capture";
import { api, friendlyError, isTransient } from "./ui";

const loadWorkspace = () => import("./workspace-app");
const WorkspaceApp = dynamic(loadWorkspace, { ssr: false, loading: () => <StartSplash /> });
type WorkspaceProps = ComponentProps<typeof import("./workspace-app").default>;

function StartSplash() {
  return <div className="start-splash" aria-busy="true" />;
}

export function StartGate(props: WorkspaceProps) {
  const [mode, setMode] = useState<"pending" | "capture" | "app">("pending");
  useEffect(() => {
    let navigation: string | undefined;
    try {
      navigation = (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type;
    } catch {}
    setMode(
      startDecision({
        setting: props.initial.startScreen ?? "home",
        pathname: location.pathname,
        search: location.search,
        hash: location.hash,
        shortSide: Math.min(screen.width, screen.height),
        navigation,
      }),
    );
    // Only the first decision counts (a fresh start).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (mode !== "capture") return;
    // A place handed over while the capture shows (the app opens a
    // notification or a quick action in the loaded page): the workspace.
    const leave = () => {
      if (location.hash && location.hash !== "#") setMode("app");
    };
    window.addEventListener("hashchange", leave);
    // The workspace's files in the background, so "Zur App" is quick.
    const timer = setTimeout(() => void loadWorkspace().catch(() => undefined), 1500);
    return () => {
      window.removeEventListener("hashchange", leave);
      clearTimeout(timer);
    };
  }, [mode]);
  if (mode === "app") return <WorkspaceApp {...props} />;
  if (mode === "pending") return <StartSplash />;
  return <StartCapture initial={props.initial} onApp={() => setMode("app")} />;
}

function useOnline() {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const sync = () => setOnline(navigator.onLine);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);
  return online;
}

function StartCapture({ initial, onApp }: { initial: WorkspaceProps["initial"]; onApp: () => void }) {
  const t = useT();
  const online = useOnline();
  const [round, setRound] = useState(0);
  const [saved, setSaved] = useState<null | { offline: boolean }>(null);
  const [message, setMessage] = useState("");
  const notify = useCallback((text: string) => setMessage(text), []);
  const onSynced = useCallback(async () => undefined, []);
  const queue = useOfflineQueue({ userId: initial.user.id, onSynced, notify });
  const mutate = async (b: Record<string, unknown>) => {
    if (isQueueable(b) && !navigator.onLine) return queue.enqueue(b, []);
    try {
      return await api("/api/command", b);
    } catch (e) {
      // No answer: the record waits on this device like in the workspace.
      if (isQueueable(b) && isTransient(e)) return queue.enqueue(b, []);
      throw new Error(friendlyError(e));
    }
  };
  const another = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (saved) another.current?.focus();
  }, [saved]);
  return (
    <AiProvider status={initial.ai || null} workspaceId={initial.workspace.id}>
      <main className="start-capture" aria-labelledby="start-capture-title">
        <header className="start-capture-head">
          <h1 id="start-capture-title">{t("Erfassen", "Capture")}</h1>
          <span className="muted small">{initial.workspace.name}</span>
        </header>
        {saved ? (
          <div className="start-capture-done">
            <p role="status" className="start-capture-saved">
              <Check size={18} weight="bold" aria-hidden />{" "}
              {saved.offline
                ? t("Gespeichert auf diesem Gerät – wird erfasst, sobald die Verbindung zurück ist.", "Saved on this device – captured once the connection is back.")
                : t("Erfasst.", "Captured.")}
            </p>
            <div className="modal-actions">
              <button type="button" className="button" onClick={onApp}>
                {t("Zur App", "To the app")}
              </button>
              <button
                ref={another}
                type="button"
                className="button primary"
                onClick={() => {
                  setSaved(null);
                  setMessage("");
                  setRound((n) => n + 1);
                }}
              >
                {t("Noch eins", "One more")}
              </button>
            </div>
          </div>
        ) : (
          <QuickCapture
            key={round}
            screen
            workspaceId={initial.workspace.id}
            online={online}
            mutate={mutate}
            notify={notify}
            onClose={onApp}
            onSaved={(_pageId, _rowId, offline) => {
              setMessage("");
              setSaved({ offline });
              if (!offline) nativeRefresh();
            }}
          />
        )}
        {message && (
          <p className="error start-capture-message" role="alert">
            {message}
          </p>
        )}
      </main>
    </AiProvider>
  );
}
