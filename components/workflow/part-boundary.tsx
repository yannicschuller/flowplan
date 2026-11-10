"use client";
// A part of the workflow builder that failed (#182): the settings of a node,
// a field's placeholders, the placeholder picker. Instead of taking the whole
// page down (app/error.tsx), only that part shows an error with "Try again";
// the error goes to the console with the part's name and component stack –
// what a bug report needs. Like app/error.tsx it asks whether the page is of
// an older build than the server's (lib/stale-copy.ts loads the live one).
import { Component, type ErrorInfo, type ReactNode } from "react";
import { WarningCircle } from "@phosphor-icons/react";
import { CHECK_EVENT } from "@/lib/stale-copy";
import { useStableT } from "./model";

type Props = { part: string; children: ReactNode };

export class PartBoundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`Workflow builder: ${this.props.part} failed`, error, info.componentStack);
    if (typeof window !== "undefined") window.dispatchEvent(new Event(CHECK_EVENT));
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <PartError
        message={this.state.error.message}
        onRetry={() => this.setState({ error: null })}
      />
    );
  }
}

function PartError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const t = useStableT();
  return (
    <div className="wf-part-error" role="alert">
      <WarningCircle aria-hidden />
      <span>
        {t("Dieser Teil konnte nicht angezeigt werden.", "This part could not be shown.")} <code>{message}</code>
      </span>
      <button type="button" className="button compact" onClick={onRetry}>
        {t("Erneut versuchen", "Try again")}
      </button>
    </div>
  );
}
