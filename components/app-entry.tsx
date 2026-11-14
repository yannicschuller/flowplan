"use client";
// What the root page renders for a signed-in person (app/page.tsx): the
// workspace, or – "Beim Öffnen auf dem Handy: Schnellerfassung" on a phone
// (lib/start-screen.ts) – the start gate, which shows the quick capture
// without the workspace's JavaScript (components/start-capture.tsx). Both
// load through next/dynamic so neither is part of the page's own bundle:
// the workspace is still rendered on the server and its files are preloaded
// with the page, the gate's path loads it only when needed.
import dynamic from "next/dynamic";
import type { ComponentProps } from "react";

const WorkspaceApp = dynamic(() => import("./workspace-app"));
const StartGate = dynamic(() => import("./start-capture").then((m) => m.StartGate));
type Props = ComponentProps<typeof import("./workspace-app").default>;

export function AppEntry({ startGate, ...props }: Props & { startGate: boolean }) {
  return startGate ? <StartGate {...props} /> : <WorkspaceApp {...props} />;
}
