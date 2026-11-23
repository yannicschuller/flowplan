// The one route file under app/api: every API address reaches its handler
// through this catch-all (lib/api-routes.ts). Each route file was a server
// entry of its own, with its own copy of the shared core (database,
// permissions, rate limits …, about 1.2 MB) in the build – with the other
// entries and the dynamic imports 95 copies, 113 MB of the image (see also
// turbopackServerSideNestedAsyncChunking in next.config.ts). The handlers
// stay as they were, next to their address (app/api/<address>/handler.ts);
// the table below names each one under the pattern its route file had, and
// the matching, params and methods follow Next.js's routing. Addresses
// without a handler of their own go to the general one (./handler.ts), as
// they came to this catch-all before. A new API route is a handler.ts and a
// line here, not a route.ts (tests/api-routes.test.ts).
//
// Route files of their own stay where Next.js needs them or where the core
// is not involved: pages and metadata files, proxy.ts and instrumentation.ts,
// and the routes outside /api (/.well-known/flowplan-push, /i18n, /llms.txt,
// and the files served from packages: /libredwg, /occt, /pdfjs, /typst, and
// the shipped draw.io, /drawio) –
// moving those here would need rewrites, which give each a second address
// under /api (with the API's headers and proxy rules), for little gain: of
// them only /.well-known/flowplan-push and /llms.txt load the core.
import type { NextRequest } from "next/server";
import { apiRoutes, matchApiRoute, routeMethod, type RouteModule } from "@/lib/api-routes";
import * as general from "./handler";
import * as adminDirectory from "../admin/directory/handler";
import * as adminInstanceBackup from "../admin/instance-backup/handler";
import * as adminInstanceMove from "../admin/instance-move/handler";
import * as adminMessengers from "../admin/messengers/handler";
import * as adminMonitoring from "../admin/monitoring/handler";
import * as adminOperations from "../admin/operations/handler";
import * as adminPush from "../admin/push/handler";
import * as adminSecurity from "../admin/security/handler";
import * as adminSftpBackup from "../admin/sftp-backup/handler";
import * as adminSummary from "../admin/summary/handler";
import * as aiPath from "../ai/[...path]/handler";
import * as authAction from "../auth/[action]/handler";
import * as backup from "../backup/handler";
import * as banners from "../banners/handler";
import * as calendarProfile from "../calendar-profile/handler";
import * as calendarSyncPath from "../calendar-sync/[...path]/handler";
import * as clipperAction from "../clipper/[action]/handler";
import * as contacts from "../contacts/handler";
import * as exportConfluence from "../export/confluence/handler";
import * as exportDocx from "../export/docx/handler";
import * as exportEpub from "../export/epub/handler";
import * as exportJira from "../export/jira/handler";
import * as exportPdf from "../export/pdf/handler";
import * as filesIdHtml from "../files/[id]/html/handler";
import * as filesIdInk from "../files/[id]/ink/handler";
import * as filesIdSheet from "../files/[id]/sheet/handler";
import * as formsTokenFontsFontId from "../forms/[token]/fonts/[fontId]/handler";
import * as formsToken from "../forms/[token]/handler";
import * as formsTokenSuggestions from "../forms/[token]/suggestions/handler";
import * as gitToken from "../git/[token]/handler";
import * as healthLive from "../health/live/handler";
import * as healthReady from "../health/ready/handler";
import * as health from "../health/handler";
import * as inboundMailToken from "../inbound-mail/[token]/handler";
import * as issueSyncHookToken from "../issue-sync/hook/[token]/handler";
import * as issueSync from "../issue-sync/handler";
import * as maintenance from "../maintenance/handler";
import * as markdownExport from "../markdown-export/handler";
import * as mcp from "../mcp/handler";
import * as meetingsPath from "../meetings/[[...path]]/handler";
import * as messengers from "../messengers/handler";
import * as metrics from "../metrics/handler";
import * as mobileAction from "../mobile/[action]/handler";
import * as mobileCaptureAction from "../mobile/capture/[action]/handler";
import * as mobileIntentsAction from "../mobile/intents/[action]/handler";
import * as mobileNotifications from "../mobile/notifications/handler";
import * as mobileWidgetsAction from "../mobile/widgets/[action]/handler";
import * as movePath from "../move/[...path]/handler";
import * as openapiJson from "../openapi.json/handler";
import * as pagesIdInk from "../pages/[id]/ink/handler";
import * as pagesIdRecordings from "../pages/[id]/recordings/handler";
import * as printToken from "../print/[token]/handler";
import * as print from "../print/handler";
import * as publicTemplatesIdFilesFileId from "../public-templates/[id]/files/[fileId]/handler";
import * as related from "../related/handler";
import * as scimV2Path from "../scim/v2/[...path]/handler";
import * as setupRestore from "../setup/restore/handler";
import * as shareTokenBoard from "../share/[token]/board/handler";
import * as shareTokenFilesFileIdHtml from "../share/[token]/files/[fileId]/html/handler";
import * as shareTokenFilesFileIdInk from "../share/[token]/files/[fileId]/ink/handler";
import * as shareTokenFilesFileIdSheet from "../share/[token]/files/[fileId]/sheet/handler";
import * as shareTokenFilesFileId from "../share/[token]/files/[fileId]/handler";
import * as shareTokenFiles from "../share/[token]/files/handler";
import * as shareTokenFontsFontId from "../share/[token]/fonts/[fontId]/handler";
import * as shareTokenInk from "../share/[token]/ink/handler";
import * as shareTokenLive from "../share/[token]/live/handler";
import * as shareTokenNotebook from "../share/[token]/notebook/handler";
import * as shareToken from "../share/[token]/handler";
import * as shareTokenUnlock from "../share/[token]/unlock/handler";
import * as siteInfo from "../site-info/handler";
import * as ticketsToken from "../tickets/[token]/handler";
import * as timeReports from "../time-reports/handler";
import * as transcribePath from "../transcribe/[...path]/handler";
import * as webhooksSlackId from "../webhooks/slack/[id]/handler";
import * as whiteboardsIdComments from "../whiteboards/[id]/comments/handler";
import * as whiteboardsIdFacilitation from "../whiteboards/[id]/facilitation/handler";
import * as workflowHooksToken from "../workflow-hooks/[token]/handler";

// Every handler ran as nodejs and dynamic (most said so, the others are
// dynamic by their [params] and use the request); none sets more route
// segment options.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const routes = apiRoutes([
  ["admin/directory", adminDirectory],
  ["admin/instance-backup", adminInstanceBackup],
  ["admin/instance-move", adminInstanceMove],
  ["admin/messengers", adminMessengers],
  ["admin/monitoring", adminMonitoring],
  ["admin/operations", adminOperations],
  ["admin/push", adminPush],
  ["admin/security", adminSecurity],
  ["admin/sftp-backup", adminSftpBackup],
  ["admin/summary", adminSummary],
  ["ai/[...path]", aiPath],
  ["auth/[action]", authAction],
  ["backup", backup],
  ["banners", banners],
  ["calendar-profile", calendarProfile],
  ["calendar-sync/[...path]", calendarSyncPath],
  ["clipper/[action]", clipperAction],
  ["contacts", contacts],
  ["export/confluence", exportConfluence],
  ["export/docx", exportDocx],
  ["export/epub", exportEpub],
  ["export/jira", exportJira],
  ["export/pdf", exportPdf],
  ["files/[id]/html", filesIdHtml],
  ["files/[id]/ink", filesIdInk],
  ["files/[id]/sheet", filesIdSheet],
  ["forms/[token]/fonts/[fontId]", formsTokenFontsFontId],
  ["forms/[token]", formsToken],
  ["forms/[token]/suggestions", formsTokenSuggestions],
  ["git/[token]", gitToken],
  ["health/live", healthLive],
  ["health/ready", healthReady],
  ["health", health],
  ["inbound-mail/[token]", inboundMailToken],
  ["issue-sync/hook/[token]", issueSyncHookToken],
  ["issue-sync", issueSync],
  ["maintenance", maintenance],
  ["markdown-export", markdownExport],
  ["mcp", mcp],
  ["meetings/[[...path]]", meetingsPath],
  ["messengers", messengers],
  ["metrics", metrics],
  ["mobile/[action]", mobileAction],
  ["mobile/capture/[action]", mobileCaptureAction],
  ["mobile/intents/[action]", mobileIntentsAction],
  ["mobile/notifications", mobileNotifications],
  ["mobile/widgets/[action]", mobileWidgetsAction],
  ["move/[...path]", movePath],
  ["openapi.json", openapiJson],
  ["pages/[id]/ink", pagesIdInk],
  ["pages/[id]/recordings", pagesIdRecordings],
  ["print/[token]", printToken],
  ["print", print],
  ["public-templates/[id]/files/[fileId]", publicTemplatesIdFilesFileId],
  ["related", related],
  ["scim/v2/[...path]", scimV2Path],
  ["setup/restore", setupRestore],
  ["share/[token]/board", shareTokenBoard],
  ["share/[token]/files/[fileId]/html", shareTokenFilesFileIdHtml],
  ["share/[token]/files/[fileId]/ink", shareTokenFilesFileIdInk],
  ["share/[token]/files/[fileId]/sheet", shareTokenFilesFileIdSheet],
  ["share/[token]/files/[fileId]", shareTokenFilesFileId],
  ["share/[token]/files", shareTokenFiles],
  ["share/[token]/fonts/[fontId]", shareTokenFontsFontId],
  ["share/[token]/ink", shareTokenInk],
  ["share/[token]/live", shareTokenLive],
  ["share/[token]/notebook", shareTokenNotebook],
  ["share/[token]", shareToken],
  ["share/[token]/unlock", shareTokenUnlock],
  ["site-info", siteInfo],
  ["tickets/[token]", ticketsToken],
  ["time-reports", timeReports],
  ["transcribe/[...path]", transcribePath],
  ["webhooks/slack/[id]", webhooksSlackId],
  ["whiteboards/[id]/comments", whiteboardsIdComments],
  ["whiteboards/[id]/facilitation", whiteboardsIdFacilitation],
  ["workflow-hooks/[token]", workflowHooksToken],
] as [string, RouteModule][]);

type Context = { params: Promise<{ path: string[] }> };
async function dispatch(request: NextRequest, context: Context) {
  const { path } = await context.params;
  const hit = matchApiRoute(routes, path);
  if (!hit) return routeMethod(general as RouteModule, request.method)(request, context);
  return routeMethod(hit.route.module, request.method)(request, { params: Promise.resolve(hit.params) });
}
export const GET = dispatch;
export const HEAD = dispatch;
export const OPTIONS = dispatch;
export const POST = dispatch;
export const PUT = dispatch;
export const DELETE = dispatch;
export const PATCH = dispatch;
