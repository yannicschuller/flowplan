import { NextResponse } from "next/server";
import { z } from "zod";
import { currentUser, checkOrigin, HttpError, hash } from "@/lib/auth";
import { getForm, saveFormSubmission } from "@/lib/forms";
import { one, run, id, transaction } from "@/lib/db";
export async function POST(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    checkOrigin(req);
    const text = await req.text();
    if (text.length > 100_000) throw new HttpError(413, "Antwort zu groß.");
    const { token } = await params;
    const user = await currentUser(),
      form = getForm(token, user),
      input = z
        .object({ cells: z.record(z.string(), z.unknown()) })
        .parse(JSON.parse(text));
    const fingerprint = hash(
      `${token}|${user?.id || req.headers.get("x-forwarded-for") || "anonymous"}`,
    );
    transaction(() => {
      const count =
        one<{ n: number }>(
          "SELECT count(*) n FROM form_submissions WHERE form_token=? AND fingerprint=? AND created_at>?",
          token,
          fingerprint,
          Date.now() - 3600000,
        )?.n || 0;
      if (count >= 30)
        throw new HttpError(
          429,
          "Zu viele Antworten. Bitte später erneut versuchen.",
        );
      saveFormSubmission(form.page_id, user, input.cells);
      run(
        "INSERT INTO form_submissions VALUES(?,?,?,?)",
        id(),
        token,
        fingerprint,
        Date.now(),
      );
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof HttpError
            ? e.message
            : e instanceof z.ZodError
              ? "Bitte Eingaben prüfen."
              : "Antwort konnte nicht gespeichert werden.",
      },
      {
        status:
          e instanceof HttpError
            ? e.status
            : e instanceof z.ZodError
              ? 400
              : 500,
      },
    );
  }
}
