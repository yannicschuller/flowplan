// The executions of the node types (lib/workflows/catalog.ts describes them).
import { logicApproval, logicForeach, logicIf, logicSet, logicStop, logicSwitch, logicWait } from "./logic";
import { notifyChat, notifyEmail, notifyPerson } from "./notify";
import { pageAppend, pageCreate, pageMove, pageTag, taskCreate } from "./pages";
import { recordCreate, recordFind, recordTemplate, recordUpdate } from "./records";
import { aiClassify, aiExtract, aiPrompt, aiSummarize } from "./ai";
import { httpRequest } from "./http";
import { journalAppend } from "./journal";
import type { NodeImpl } from "./types";

export const NODE_IMPLS: Record<string, NodeImpl> = {
  "logic.if": logicIf,
  "logic.set": logicSet,
  "logic.stop": logicStop,
  "logic.switch": logicSwitch,
  "logic.foreach": logicForeach,
  "logic.wait": logicWait,
  "logic.approval": logicApproval,
  "action.record.create": recordCreate,
  "action.record.update": recordUpdate,
  "action.record.find": recordFind,
  "action.record.template": recordTemplate,
  "action.page.create": pageCreate,
  "action.page.append": pageAppend,
  "action.page.tag": pageTag,
  "action.page.move": pageMove,
  "action.task.create": taskCreate,
  "action.journal.append": journalAppend,
  "notify.person": notifyPerson,
  "notify.email": notifyEmail,
  "notify.chat": notifyChat,
  "ai.summarize": aiSummarize,
  "ai.classify": aiClassify,
  "ai.extract": aiExtract,
  "ai.prompt": aiPrompt,
  "http.request": httpRequest,
};
// Nodes whose effect lies outside Flowplan's database (§8.4): run outside
// a transaction, then finished with the lease check. E-mail and chat are
// internal: they queue into mail_queue / webhook_deliveries in the step's
// transaction, the existing queues deliver.
export const EXTERNAL_NODES = new Set<string>(["ai.summarize", "ai.classify", "ai.extract", "ai.prompt", "http.request"]);
