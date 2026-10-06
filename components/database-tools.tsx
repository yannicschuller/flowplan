"use client";
import { useState, type ReactNode } from "react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { DotsThree, Lightning, FlowArrow, Copy } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { Modal } from "./ui";
import { DatabaseAutomations } from "./database-automations";
import { DatabaseWorkflow } from "./database-workflow";
import type { Database, Page, User } from "@/lib/types";

export type ToolPanel = "automations" | "workflow";

// The "…" menu of a database: record templates and the optional tools.
// Nothing here changes how a database works until it is set up.
export function DatabaseTools({
  page,
  database,
  members,
  editable,
  act,
  onTemplates,
}: {
  page: Page;
  database: Database;
  members: Pick<User, "id" | "name">[];
  editable: boolean;
  act: (b: Record<string, unknown>) => Promise<unknown>;
  onTemplates: () => void;
}) {
  const t = useT();
  const [panel, setPanel] = useState<ToolPanel | null>(null);
  const settings = database.settings || {};
  const save = async (patch: Record<string, unknown>) => !!(await act({ action: "database.settings", settings: patch }));
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
      <Dropdown.Root>
        <Dropdown.Trigger asChild>
          <button title={t("Weitere Werkzeuge", "More tools")} aria-label={t("Weitere Werkzeuge", "More tools")}>
            <DotsThree size={20} />
          </button>
        </Dropdown.Trigger>
        <Dropdown.Portal>
          <Dropdown.Content className="dropdown" align="end" sideOffset={4}>
            {item(<Copy />, t("Datensatzvorlagen", "Record templates"), onTemplates)}
            <Dropdown.Separator className="dropdown-separator" />
            {item(<Lightning />, t("Automationen", "Automations"), () => setPanel("automations"), rules ? String(rules) : undefined)}
            {item(<FlowArrow />, t("Workflow und Erledigt", "Workflow and done"), () => setPanel("workflow"), settings.workflow ? "✓" : undefined)}
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>
      <Modal open={panel === "automations"} onClose={() => setPanel(null)} title={t(`Automationen · ${page.title}`, `Automations · ${page.title}`)} wide>
        <DatabaseAutomations fields={database.fields} settings={settings} members={members} editable={editable} save={save} />
      </Modal>
      <Modal open={panel === "workflow"} onClose={() => setPanel(null)} title={t("Workflow und Erledigt", "Workflow and done")} wide>
        <DatabaseWorkflow
          key={String(database.version)}
          fields={database.fields}
          settings={settings}
          editable={editable}
          save={async (patch) => {
            const ok = await save(patch);
            if (ok) setPanel(null);
            return ok;
          }}
        />
      </Modal>
    </>
  );
}
