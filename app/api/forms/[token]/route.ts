import { NextResponse } from "next/server";
import { z } from "zod";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { currentUser, checkOrigin, HttpError, hash } from "@/lib/auth";
import { getForm, saveFormSubmission } from "@/lib/forms";
import {
  FORM_FILE_BYTES,
  FORM_FILES_PER_QUESTION,
  FORM_TOTAL_BYTES,
} from "@/lib/form-settings";
import { one, run, id, transaction, onTransactionRollback } from "@/lib/db";
import { enforceQuota } from "@/lib/instance-ops";
export async function POST(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    checkOrigin(req);
    const { token } = await params;
    const user = await currentUser(),
      form = getForm(token, user);
    const fileFields = form.fields.filter((f) => f.type === "files");
    let raw: string;
    const uploads = new Map<string, File[]>();
    if (req.headers.get("content-type")?.startsWith("multipart/form-data")) {
      if (
        Number(req.headers.get("content-length") || 0) >
        FORM_TOTAL_BYTES + 200_000
      )
        throw new HttpError(413, "Antwort zu groß.");
      const data = await req.formData();
      raw = String(data.get("payload") || "");
      let total = 0;
      for (const field of fileFields) {
        const files = data
          .getAll(`file:${field.id}`)
          .filter((f): f is File => f instanceof File);
        if (files.length > FORM_FILES_PER_QUESTION)
          throw new HttpError(
            400,
            `${field.name}: maximal ${FORM_FILES_PER_QUESTION} Dateien.`,
          );
        for (const file of files) {
          if (file.size > FORM_FILE_BYTES)
            throw new HttpError(413, `${file.name}: maximal 10 MB pro Datei.`);
          total += file.size;
        }
        if (files.length) uploads.set(field.id, files);
      }
      if (total > FORM_TOTAL_BYTES)
        throw new HttpError(413, "Maximal 25 MB Dateien je Antwort.");
      if (total) enforceQuota(form.workspace_id, total);
    } else raw = await req.text();
    if (raw.length > 100_000) throw new HttpError(413, "Antwort zu groß.");
    const input = z
      .object({ cells: z.record(z.string(), z.unknown()) })
      .parse(JSON.parse(raw));
    // File answers only come from uploads of this request.
    const cells = { ...input.cells };
    for (const field of fileFields) delete cells[field.id];
    const buffers = new Map<string, { file: File; data: Buffer }[]>();
    for (const [fieldId, files] of uploads)
      buffers.set(
        fieldId,
        await Promise.all(
          files.map(async (file) => ({
            file,
            data: Buffer.from(await file.arrayBuffer()),
          })),
        ),
      );
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
      const dir = resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "uploads");
      if (buffers.size) mkdirSync(dir, { recursive: true });
      for (const [fieldId, files] of buffers) {
        cells[fieldId] = files.map(({ file, data }) => {
          const fid = id(),
            path = resolve(dir, fid);
          writeFileSync(path, data);
          onTransactionRollback(() => unlinkSync(path));
          run(
            "INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)",
            fid,
            form.page_id,
            (file.name || "Datei").slice(0, 200),
            (file.type || "application/octet-stream").slice(0, 200),
            data.length,
            form.anonymous ? null : user?.id || null,
          );
          return `/api/files/${fid}`;
        });
      }
      saveFormSubmission(form.page_id, user, cells);
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
            : e instanceof z.ZodError || e instanceof SyntaxError
              ? "Bitte Eingaben prüfen."
              : "Antwort konnte nicht gespeichert werden.",
      },
      {
        status:
          e instanceof HttpError
            ? e.status
            : e instanceof z.ZodError || e instanceof SyntaxError
              ? 400
              : 500,
      },
    );
  }
}
