import { readTextLimited } from "@/lib/request-body";
import { serverError } from "@/lib/request-context";
import { NextResponse } from "next/server";
import { HttpError, refuseWhileReadOnly } from "@/lib/auth";
import { transaction } from "@/lib/db";
import { receiveGitWebhook } from "@/lib/git-integration";

// Webhooks from GitHub, GitLab and Gitea/Forgejo (no session: the token in
// the address finds the database, the signature proves the sender).
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    // Not during an instance move (lib/instance-read-only.ts): the sender retries.
    await refuseWhileReadOnly(req);
    const { token } = await params;
    const body = await readTextLimited(req, 5_000_000);
    return NextResponse.json(await transaction(async () => await receiveGitWebhook(token, req.headers, body)));
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof HttpError ? e.message : "Webhook konnte nicht verarbeitet werden." },
      { status: e instanceof HttpError ? e.status : serverError(e) },
    );
  }
}
