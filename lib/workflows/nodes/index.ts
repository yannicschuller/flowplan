// The executions of the node types (lib/workflows/catalog.ts describes them).
import { logicIf, logicSet, logicStop } from "./logic";
import { notifyPerson } from "./notify";
import { pageAppend, pageCreate, pageMove, pageTag } from "./pages";
import { recordCreate, recordFind, recordTemplate, recordUpdate } from "./records";
import type { NodeImpl } from "./types";

export const NODE_IMPLS: Record<string, NodeImpl> = {
  "logic.if": logicIf,
  "logic.set": logicSet,
  "logic.stop": logicStop,
  "action.record.create": recordCreate,
  "action.record.update": recordUpdate,
  "action.record.find": recordFind,
  "action.record.template": recordTemplate,
  "action.page.create": pageCreate,
  "action.page.append": pageAppend,
  "action.page.tag": pageTag,
  "action.page.move": pageMove,
  "notify.person": notifyPerson,
};
// Nodes whose effect lies outside Flowplan's database (§8.4): run outside
// a transaction, then finished with the lease check. None in wave 1.
export const EXTERNAL_NODES = new Set<string>();
