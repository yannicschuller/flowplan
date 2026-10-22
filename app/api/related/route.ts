// Related pages of a page or record ("Verwandte Seiten") and, with
// `title`, existing pages or records with a similar title (duplicate hint
// when creating one). Everything as the signed-in person: lib/related-pages.ts.
import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, requireUser } from "@/lib/auth";
import { withRequestLocale } from "@/lib/content-locale";
import { relatedPages, similarTitles } from "@/lib/related-pages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { headers: { "Cache-Control": "no-store" } };
const uuid = z.uuid();

export const GET = withRequestLocale(async (req: Request) => {
  try {
    const user = await requireUser();
    const url = new URL(req.url);
    const title = url.searchParams.get("title");
    if (title !== null) {
      const database = url.searchParams.get("database");
      const exclude = url.searchParams.get("exclude");
      const excludeRow = url.searchParams.get("excludeRow");
      const items = similarTitles(user, {
        workspaceId: uuid.parse(url.searchParams.get("workspace")),
        title: z.string().max(300).parse(title),
        databaseId: database ? uuid.parse(database) : null,
        excludePageId: exclude ? uuid.parse(exclude) : null,
        excludeRowId: excludeRow ? uuid.parse(excludeRow) : null,
      });
      return NextResponse.json({ items }, noStore);
    }
    const row = url.searchParams.get("row");
    return NextResponse.json(relatedPages(user, uuid.parse(url.searchParams.get("page")), row ? uuid.parse(row) : null), noStore);
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: "Ungültige Eingabe." }, { status: 400 });
    if (!(e instanceof HttpError)) console.error(e);
    return NextResponse.json(
      { error: e instanceof HttpError ? e.message : "Die Anfrage konnte nicht verarbeitet werden." },
      { status: e instanceof HttpError ? e.status : 500 },
    );
  }
});
