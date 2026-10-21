import { after, NextResponse } from "next/server";
import { HttpError } from "@/lib/auth";
import { receiveIssueWebhook, syncIssues } from "@/lib/issue-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Issue and comment webhooks from GitHub or GitLab (no session: the token in
// the address finds the connection, the signature or secret proves the
// sender). The pull runs after the answer, so the provider is not kept
// waiting.
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    if (Number(req.headers.get("content-length") || 0) > 5_000_000) throw new HttpError(413, "Anfrage zu groß.");
    const body = await req.text();
    if (body.length > 5_000_000) throw new HttpError(413, "Anfrage zu groß.");
    const result = receiveIssueWebhook(token, req.headers, body);
    if (result.pages.length)
      after(async () => {
        for (const page of result.pages) await syncIssues(page).catch((error) => console.error("Issue sync failed", error));
      });
    return NextResponse.json({ ok: true, databases: result.pages.length }, { status: 202 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof HttpError ? e.message : "Webhook konnte nicht verarbeitet werden." },
      { status: e instanceof HttpError ? e.status : 500 },
    );
  }
}
