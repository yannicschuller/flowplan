import { exportDocx } from "@/lib/export-docx";
import { attachment, exportRoute, uuid } from "@/lib/export-route";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A page (?page=<id>) or one record of a database (&row=<id>) as a Word
// file. Reading only, so personal API tokens with read access may use it.
export const GET = exportRoute(async (user, query) => {
  const result = await exportDocx(user, {
    pageId: uuid.parse(query.get("page")),
    rowId: query.get("row") ? uuid.parse(query.get("row")) : undefined,
  });
  return attachment(result.bytes, result.name, result.mime, "docx");
});
