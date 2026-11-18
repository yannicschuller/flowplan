// Earlier answers for a form's text question while typing (#374,
// lib/form-suggestions.ts). Internal to the form page, outside the token API.
import { NextResponse } from "next/server";
import { serverError } from "@/lib/request-context";
import { activeUserFromRequest, HttpError } from "@/lib/auth";
import { withRequestLocale } from "@/lib/content-locale";
import { formSuggestions } from "@/lib/form-suggestions";

async function handleGET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const headers = { "cache-control": "no-store" };
  try {
    const { token } = await params;
    const url = new URL(req.url);
    const field = (url.searchParams.get("field") || "").slice(0, 100);
    const query = (url.searchParams.get("q") || "").slice(0, 200);
    const user = await activeUserFromRequest(req);
    return NextResponse.json({ suggestions: await formSuggestions(token, user, field, query) }, { headers });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof HttpError ? e.message : "Vorschläge konnten nicht geladen werden." },
      { status: e instanceof HttpError ? e.status : serverError(e), headers },
    );
  }
}
export const GET = withRequestLocale(handleGET);
