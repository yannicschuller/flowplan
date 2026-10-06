import { NextResponse } from "next/server";
import { HttpError } from "@/lib/auth";
import { transaction } from "@/lib/db";
import { receiveGitWebhook } from "@/lib/git-integration";

// Webhooks from GitHub, GitLab and Gitea/Forgejo (no session: the token in
// the address finds the database, the signature proves the sender).
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const length = Number(req.headers.get("content-length") || 0);
    if (length > 5_000_000) throw new HttpError(413, "Anfrage zu groß.");
    const body = await req.text();
    if (body.length > 5_000_000) throw new HttpError(413, "Anfrage zu groß.");
    return NextResponse.json(transaction(() => receiveGitWebhook(token, req.headers, body)));
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof HttpError ? e.message : "Webhook konnte nicht verarbeitet werden." },
      { status: e instanceof HttpError ? e.status : 500 },
    );
  }
}
