import { exportEpub } from "@/lib/export-epub";
import { attachment, exportRoute, selection } from "@/lib/export-route";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A page (?page=<id>, with &children=1 its sub-pages) or a whole space
// (?space=<id>) as an e-book.
export const GET = exportRoute(async (user, query) => {
  const result = await exportEpub(user, selection(query));
  return attachment(result.bytes, result.name, result.mime, "epub");
});
