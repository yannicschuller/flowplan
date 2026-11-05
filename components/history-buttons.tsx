"use client";
// Back and forward at the top left (#125): two arrows next to the sidebar
// button, on wider screens (phones have the swipe and the back button). A
// click goes one place back or forward (lib/history-nav.ts); a right click
// or a long press lists the last places in that direction to jump to one.
// Disabled where there is nothing to go to.
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { ArrowLeft, ArrowRight } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { safeCollisionPadding } from "./safe-area";
import { goToStep, historySteps, NO_STEPS, rememberTitle, subscribeHistory, type Step } from "@/lib/history-nav";

export type StepLook = { title: string; detail?: string; icon: ReactNode; remember?: { title: string; icon?: string } };
const LONG_PRESS_MS = 450;

export function useHistorySteps() {
  return useSyncExternalStore(subscribeHistory, historySteps, () => NO_STEPS);
}

function HistoryButton({
  direction,
  steps,
  hint,
  describe,
}: {
  direction: "back" | "forward";
  steps: Step[];
  hint: string;
  describe: (hash: string) => StepLook;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const press = useRef<{ timer: number; opened: boolean } | null>(null);
  const disabled = steps.length === 0;
  const label = direction === "back" ? t("Zurück", "Back") : t("Vorwärts", "Forward");
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  const go = () => {
    if (steps[0]) goToStep(steps[0]);
  };
  const endPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
  };
  return (
    <Dropdown.Root open={open} onOpenChange={setOpen}>
      <Dropdown.Trigger asChild disabled={disabled}>
        <button
          ref={button}
          type="button"
          className="icon-button history-button"
          data-direction={direction}
          aria-label={label}
          title={`${label}${hint ? ` (${hint})` : ""}`}
          disabled={disabled}
          // The menu's trigger opens on pointer down; here a press goes, a
          // long press (or a right click) lists the places.
          onPointerDown={(e) => {
            e.preventDefault();
            if (e.button !== 0 || disabled) return;
            endPress();
            const state = { timer: 0, opened: false };
            state.timer = window.setTimeout(() => {
              state.opened = true;
              setOpen(true);
            }, LONG_PRESS_MS);
            press.current = state;
          }}
          onPointerUp={endPress}
          onPointerLeave={endPress}
          onPointerCancel={endPress}
          onClick={(e) => {
            e.preventDefault();
            if (press.current?.opened) {
              press.current = null;
              return;
            }
            press.current = null;
            go();
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            endPress();
            if (!disabled) setOpen(true);
          }}
          onKeyDown={(e) => {
            // Enter and Space go; ↓ opens the list (the menu's own key).
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              if (!e.repeat) go();
            }
          }}
          onKeyUp={(e) => {
            if (e.key === " ") e.preventDefault();
          }}
        >
          {direction === "back" ? <ArrowLeft size={17} /> : <ArrowRight size={17} />}
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          collisionPadding={safeCollisionPadding()}
          className="dropdown history-list"
          align="start"
          sideOffset={4}
          aria-label={direction === "back" ? t("Seiten zurück", "Pages back") : t("Seiten vorwärts", "Pages forward")}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            if (button.current && !button.current.disabled) button.current.focus({ preventScroll: true });
          }}
        >
          {steps.map((step) => {
            const look = describe(step.hash);
            return (
              <Dropdown.Item key={step.key} className="dropdown-item history-item" onSelect={() => goToStep(step)}>
                <span className="history-item-icon">{look.icon}</span>
                <span className="history-item-title">{look.title}</span>
                {look.detail && <small className="history-item-detail">{look.detail}</small>}
              </Dropdown.Item>
            );
          })}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

export function HistoryButtons({
  backHint,
  forwardHint,
  describe,
}: {
  backHint: string;
  forwardHint: string;
  describe: (hash: string) => StepLook;
}) {
  const t = useT();
  const steps = useHistorySteps();
  // The title of the place, for the lists later on (a record's title is only
  // known while it is open; pages of another workspace after a switch).
  const describeRef = useRef(describe);
  describeRef.current = describe;
  useEffect(() => {
    const here = steps.current;
    if (!here) return;
    const keep = () => {
      const look = describeRef.current(here);
      if (look.remember) rememberTitle(here, look.remember);
    };
    const timers = [400, 2000].map((ms) => window.setTimeout(keep, ms));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [steps.current]);
  return (
    <span className="history-nav" role="group" aria-label={t("Verlauf", "History")}>
      <HistoryButton direction="back" steps={steps.back} hint={backHint} describe={describe} />
      <HistoryButton direction="forward" steps={steps.forward} hint={forwardHint} describe={describe} />
    </span>
  );
}
