// The jobs a worker thread runs (lib/worker-pool.ts, lib/workers/job-worker.ts):
// the same functions the request thread calls – inside the worker their
// offThread() runs the work right there. Loaded only by the worker (and
// by tests); arguments and results are structured-cloneable.
import { exportMarkdown } from "./markdown-export";
import { exportDocx } from "./export-docx";
import { exportEpub } from "./export-epub";
import { exportPrintHtml } from "./export-pdf";
import { exportJira } from "./export-jira";
import { exportConfluence } from "./export-confluence";
import { parseImportData } from "./importers/parse-transfer";
import { searchWorkspace } from "./search-index";
import { queryDatabase } from "./mcp";
import { openedDatabaseJson } from "./page-open";

export const workerJobs = {
  "export.markdown": exportMarkdown,
  "export.docx": exportDocx,
  "export.epub": exportEpub,
  "export.print": exportPrintHtml,
  "export.jira": exportJira,
  "export.confluence": exportConfluence,
  "import.parse": parseImportData,
  // The quick search (#383 wave 3), when a thread is free (offThread ifFree).
  "search.workspace": searchWorkspace,
  // MCP query_database (#383 wave 3), the same way.
  "mcp.query_database": queryDatabase,
  // Opening a database (#383 wave 3, lib/page-open.ts), the same way.
  "page.database": openedDatabaseJson,
} as const;
export type WorkerJobName = keyof typeof workerJobs;
