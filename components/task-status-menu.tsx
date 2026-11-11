"use client";
// The states of a task (#201, lib/task-status.ts), opened by a right click
// or a long press on its box (lib/document-schema.ts FlowTaskItem).
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { Check } from "@phosphor-icons/react";
import type { Editor } from "@tiptap/react";
import { safeCollisionPadding } from "./safe-area";
import { useT } from "./i18n";
import { STATUS_SYMBOL, TASK_STATUSES, statusName, taskStatusOf, type TaskStatus } from "@/lib/task-status";
import { setTaskStatus } from "@/lib/task-status-commands";
import { formatCombo, isMacPlatform } from "@/lib/keymap";

export type TaskStatusTarget = { pos: number; anchor: DOMRect };

// The box of a state, as in the editor (app/globals.css .task-status-icon).
export function TaskStatusIcon({ status }: { status: TaskStatus }) {
  return <span className="task-status-icon" data-status={status} aria-hidden />;
}

export function TaskStatusMenu({ editor, target, onClose }: { editor: Editor | null; target: TaskStatusTarget | null; onClose: () => void }) {
  const t = useT();
  if (!editor || !target) return null;
  const node = editor.state.doc.nodeAt(target.pos);
  if (node?.type.name !== "taskItem") return null;
  const current = taskStatusOf(node.attrs);
  const { anchor } = target;
  return (
    <Dropdown.Root open modal={false} onOpenChange={(open) => !open && onClose()}>
      <Dropdown.Trigger asChild>
        <span
          aria-hidden
          className="task-status-anchor"
          style={{ left: anchor.left, top: anchor.top, width: anchor.width, height: anchor.height }}
        />
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          collisionPadding={safeCollisionPadding()}
          className="dropdown task-status-menu"
          align="start"
          sideOffset={6}
          aria-label={t("Status der Aufgabe", "Task status")}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            editor.commands.focus(undefined, { scrollIntoView: false });
          }}
        >
          <Dropdown.RadioGroup
            value={current}
            onValueChange={(value) => {
              setTaskStatus(editor.state, editor.view.dispatch, value as TaskStatus, [target.pos]);
              onClose();
            }}
          >
            {TASK_STATUSES.map((status) => (
              <Dropdown.RadioItem key={status} value={status} className="dropdown-item task-status-item">
                <TaskStatusIcon status={status} />
                <span className="task-status-name">{statusName(t, status)}</span>
                <kbd className="task-status-symbol">[{STATUS_SYMBOL[status]}]</kbd>
                <Dropdown.ItemIndicator className="task-status-check">
                  <Check size={14} weight="bold" />
                </Dropdown.ItemIndicator>
              </Dropdown.RadioItem>
            ))}
          </Dropdown.RadioGroup>
          <div className="task-status-hint">
            {t(`${formatCombo("Mod+L", isMacPlatform())}: nächster Status`, `${formatCombo("Mod+L", isMacPlatform())}: next status`)}
          </div>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
