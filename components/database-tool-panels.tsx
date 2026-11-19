"use client";
// The dialogs of a database's "…" menu (components/database-tools.tsx):
// automations, status rules, the time report and the Git connection. They
// load with the first one opened, not with every database.
import { TimeReport } from "./time-report";
import { GitSettings } from "./git-settings";
import { useT } from "./i18n";
import { Modal } from "./ui";
import { DatabaseAutomations } from "./database-automations";
import { DatabaseWorkflow } from "./database-workflow";
import type { Database, Page, User } from "@/lib/types";
import type { ToolPanel } from "./database-tools";

export default function DatabaseToolPanels({
  panel,
  setPanel,
  page,
  database,
  members,
  editable,
  act,
  templates,
  databases,
}: {
  panel: ToolPanel | null;
  setPanel: (panel: ToolPanel | null) => void;
  page: Page;
  database: Database;
  members: Pick<User, "id" | "name">[];
  editable: boolean;
  act: (b: Record<string, unknown>) => Promise<unknown>;
  templates?: { id: string; name: string; is_default?: number }[];
  databases?: { id: string; title: string }[];
}) {
  const t = useT();
  const settings = database.settings || {};
  const save = async (patch: Record<string, unknown>) => !!(await act({ action: "database.settings", settings: patch }));
  return (
    <>
      <Modal open={panel === "automations"} onClose={() => setPanel(null)} title={t(`Automationen · ${page.title}`, `Automations · ${page.title}`)} wide>
        <DatabaseAutomations fields={database.fields} settings={settings} members={members} editable={editable} save={save} templates={templates} pageId={page.id} databases={databases} />
      </Modal>
      <Modal open={panel === "git"} onClose={() => setPanel(null)} title={t("Git-Anbindung", "Git connection")} wide>
        {panel === "git" && <GitSettings pageId={page.id} hasIds={database.fields.some((f) => f.type === "id" && !!f.prefix)} editable={editable} act={act} />}
      </Modal>
      <Modal open={panel === "time"} onClose={() => setPanel(null)} title={t(`Zeiten · ${page.title}`, `Time · ${page.title}`)} wide>
        {panel === "time" && <TimeReport pageId={page.id} workspaceId={page.workspace_id} title={page.title} />}
      </Modal>
      <Modal open={panel === "workflow"} onClose={() => setPanel(null)} title={t("Statusregeln und Erledigt", "Status rules and done")} wide>
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
