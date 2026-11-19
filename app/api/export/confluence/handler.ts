import { exportConfluence } from "@/lib/export-confluence";
import { attachment, exportRoute, uuid } from "@/lib/export-route";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A page (?page=<id>) or one record of a database (&row=<id>) in
// Confluence's storage format (XHTML), a text file. Reading only, so
// personal API tokens with read access may use it.
export const GET = exportRoute(async (user, query) => {
  const result = await exportConfluence(user, {
    pageId: uuid.parse(query.get("page")),
    rowId: query.get("row") ? uuid.parse(query.get("row")) : undefined,
  });
  return attachment(result.bytes, result.name, result.mime, "xhtml");
});
