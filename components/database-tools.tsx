"use client";
import { safeCollisionPadding } from "./safe-area";
import { useState, type ReactNode } from "react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { DotsThree, Lightning, FlowArrow, Copy, Timer, GitBranch } from "@phosphor-icons/react";
import dynamic from "next/dynamic";
import { CalendarSyncButton } from "./calendar-sync-dialog";
import { IssueSyncDialog, IssueSyncMenuItem } from "./issue-sync-database";
import { useT } from "./i18n";
import { loadView } from "./view-fallback";
import type { Database, Page, User } from "@/lib/types";

export type ToolPanel = "automations" | "workflow" | "time" | "git";

// The dialogs load with the first one opened (components/database-tool-panels.tsx);
// a dialog opens once its code is there, so its focus lands as before.
const DatabaseToolPanels = dynamic(() => loadView(() => import("./database-tool-panels")), { ssr: false });

// The "…" menu of a database: record templates and the optional tools.
// Nothing here changes how a database works until it is set up.
export function DatabaseTools({
  page,
  database,
  members,
  editable,
  act,
  onTemplates,
  templates,
  databases,
}: {
  page: Page;
  database: Database;
  members: Pick<User, "id" | "name">[];
  editable: boolean;
  act: (b: Record<string, unknown>) => Promise<unknown>;
  onTemplates: () => void;
  // Record templates, for scheduled automation rules.
  templates?: { id: string; name: string; is_default?: number }[];
  // The workspace's databases, for rules that create tasks in one (#380).
  databases?: { id: string; title: string }[];
}) {
  const t = useT();
  const [panel, setPanelState] = useState<ToolPanel | null>(null);
  // Mounted with the first dialog and kept (closing animations, state).
  const [used, setUsed] = useState(false);
  const setPanel = (next: ToolPanel | null) => {
    if (next) setUsed(true);
    setPanelState(next);
  };
  const settings = database.settings || {};
  const item = (icon: ReactNode, label: string, onSelect: () => void, hint?: string) => (
    <Dropdown.Item className="dropdown-item" onSelect={onSelect}>
      {icon}
      <span>{label}</span>
      {hint && <small className="dropdown-hint">{hint}</small>}
    </Dropdown.Item>
  );
  const rules = (settings.automations || []).filter((a) => a.enabled).length;
  return (
    <>
      <CalendarSyncButton pageId={page.id} fields={database.fields} views={database.views} editable={editable} />
      {/* Opening the menu fetches the dialogs, so one chosen opens at once. */}
      <Dropdown.Root onOpenChange={(open) => open && void import("./database-tool-panels").catch(() => {})}>
        <Dropdown.Trigger asChild>
          <button title={t("Weitere Werkzeuge", "More tools")} aria-label={t("Weitere Werkzeuge", "More tools")}>
            <DotsThree size={20} />
          </button>
        </Dropdown.Trigger>
        <Dropdown.Portal>
          <Dropdown.Content collisionPadding={safeCollisionPadding()} className="dropdown" align="end" sideOffset={4}>
            {item(<Copy />, t("Datensatzvorlagen", "Record templates"), onTemplates)}
            <Dropdown.Separator className="dropdown-separator" />
            {item(<Lightning />, t("Automationen", "Automations"), () => setPanel("automations"), rules ? String(rules) : undefined)}
            {item(<FlowArrow />, t("Statusregeln und Erledigt", "Status rules and done"), () => setPanel("workflow"), settings.workflow ? "✓" : undefined)}
            {database.fields.some((f) => f.type === "time") && item(<Timer />, t("Zeiten auswerten", "Time report"), () => setPanel("time"))}
            {editable && item(<GitBranch />, t("Git-Anbindung", "Git connection"), () => setPanel("git"), settings.git ? "✓" : undefined)}
            <IssueSyncMenuItem pageId={page.id} />
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>
      <IssueSyncDialog page={page} database={database} editable={editable} />
      {used && (
        <DatabaseToolPanels
          panel={panel}
          setPanel={setPanel}
          page={page}
          database={database}
          members={members}
          editable={editable}
          act={act}
          templates={templates}
          databases={databases}
        />
      )}
    </>
  );
}
