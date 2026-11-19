import { exportJira } from "@/lib/export-jira";
import { attachment, exportRoute, uuid } from "@/lib/export-route";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A page (?page=<id>) or one record of a database (&row=<id>) as Jira wiki
// markup, a text file. Reading only, so personal API tokens with read
// access may use it.
export const GET = exportRoute(async (user, query) => {
  const result = await exportJira(user, {
    pageId: uuid.parse(query.get("page")),
    rowId: query.get("row") ? uuid.parse(query.get("row")) : undefined,
  });
  return attachment(result.bytes, result.name, result.mime, "txt");
});
