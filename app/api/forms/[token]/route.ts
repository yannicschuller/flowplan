import { NextResponse } from "next/server";
import { requireBodySize, sanitizeFileName, stripLocation, verifiedMime } from "@/lib/upload-safety";
import { z } from "zod";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { activeUserFromRequest, checkOrigin, HttpError, hash, refuseReadToken } from "@/lib/auth";
import { confirmFormAnswer, deleteFormDraft, formDraft, getForm, saveFormDraft, saveFormSubmission } from "@/lib/forms";
import {
  FORM_FILE_BYTES,
  FORM_FILES_PER_QUESTION,
  FORM_TOTAL_BYTES,
} from "@/lib/form-settings";
import { one, run, id, transaction, onTransactionRollback } from "@/lib/db";
import { enforceQuota } from "@/lib/instance-ops";
import { takeAnonymousBudget } from "@/lib/anonymous-budget";
import { enforceUserStorage } from "@/lib/user-limits";
import { clientAddress } from "@/lib/client-address";
import { contentLocale, withRequestLocale } from "@/lib/content-locale";
import { createTicket, mailTicketLink } from "@/lib/service-desk";
import { surveyClosed } from "@/lib/survey";
import { readTextLimited } from "@/lib/request-body";
import { mapAsync } from "../../../../lib/each-async";

async function handlePOST(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    await checkOrigin(req);
    const { token } = await params;
    const user = await activeUserFromRequest(req);
    refuseReadToken(user);
    const form = await getForm(token, user);
    const FORM_ANSWERS_PER_HOUR = 1000;
    const fileFields = form.fields.filter((f) => f.type === "files");
    let raw: string;
    const uploads = new Map<string, File[]>();
    if (req.headers.get("content-type")?.startsWith("multipart/form-data")) {
      requireBodySize(req, FORM_TOTAL_BYTES + 200_000, "Antwort zu groß.");
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
      if (total) await enforceQuota(form.workspace_id, total);
    } else raw = await readTextLimited(req, 400_000, "Antwort zu groß.");
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
    // Visitors are told apart by their address. Without one (no proxy
    // header) they all look alike, so the per-person checks below are
    // skipped rather than counted against everyone; the per-form caps and
    // the daily upload budget still hold.
    const address = user ? "" : clientAddress(req.headers);
    const known = !!user || !!address;
    const fingerprint = hash(`${token}|${user?.id || address || "?"}`);
    // Assigned inside the transaction.
    let ticket = null as { token: string; mailed: boolean } | null;
    await transaction(async () => {
      // Surveys: closing date, response limit, one answer per person.
      const survey = form.config.survey?.enabled ? form.config.survey : null;
      if (survey) {
        const total = (await one<{ n: number }>("SELECT count(*) n FROM form_submissions WHERE form_token=?", token))?.n || 0;
        const closed = surveyClosed(survey, total);
        if (closed) throw new HttpError(410, closed === "full" ? "Diese Umfrage hat genug Antworten." : "Diese Umfrage ist geschlossen.");
        if (survey.onePerPerson && known && await one("SELECT 1 FROM form_submissions WHERE form_token=? AND fingerprint=?", token, fingerprint))
          throw new HttpError(409, "Du hast an dieser Umfrage schon teilgenommen.");
      }
      const count = known
        ? (await one<{ n: number }>(
            "SELECT count(*) n FROM form_submissions WHERE form_token=? AND fingerprint=? AND created_at>?",
            token,
            fingerprint,
            Date.now() - 3600000,
          ))?.n || 0
        : 0;
      if (count >= 30)
        throw new HttpError(
          429,
          "Zu viele Antworten. Bitte später erneut versuchen.",
        );
      // The form as a whole: a cap no crowd of real people reaches, which
      // stops scripts that rotate addresses.
      const perForm =
        (await one<{ n: number }>("SELECT count(*) n FROM form_submissions WHERE form_token=? AND created_at>?", token, Date.now() - 3600000))?.n || 0;
      if (perForm >= FORM_ANSWERS_PER_HOUR)
        throw new HttpError(429, "Dieses Formular hat gerade viele Antworten erhalten. Bitte später erneut versuchen.");
      // Every file counts against a bound: the submitter's personal storage
      // limit when they are signed in; the form's daily budget for visitors
      // without an account, and for anonymous forms, whose files belong to
      // nobody (so no personal limit counts them later).
      let bytes = 0;
      for (const files of buffers.values()) for (const { data } of files) bytes += data.length;
      if (bytes && user) await enforceUserStorage(user, bytes, form.workspace_id);
      if (bytes && (!user || form.anonymous)) await takeAnonymousBudget(`form:${token}`, bytes);
      const dir = resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "uploads");
      if (buffers.size) mkdirSync(dir, { recursive: true });
      for (const [fieldId, files] of buffers) {
        cells[fieldId] = await mapAsync(files, async ({ file, data: raw }) => {
          const fid = id(),
            path = resolve(dir, fid);
          // The type must match the content; photos lose their location.
          const mime = verifiedMime(file.type, raw);
          const data = stripLocation(raw, mime);
          writeFileSync(path, data);
          onTransactionRollback(() => unlinkSync(path));
          await run(
            "INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)",
            fid,
            form.page_id,
            sanitizeFileName(file.name, "Datei"),
            mime,
            data.length,
            form.anonymous ? null : user?.id || null,
          );
          return `/api/files/${fid}`;
        });
      }
      const sender = user?.id || address;
      const confirm = form.config.confirmation.enabled;
      const saved = await saveFormSubmission(form.page_id, user, cells, false, { confirm: !form.config.portal, sender });
      // Customer portal: a private link to follow the request. With a
      // confirmation e-mail the link goes out in that mail instead.
      if (form.config.portal) {
        const created = await createTicket({ pageId: form.page_id, rowId: saved.id, title: form.title, fields: form.fields, cells: saved.cells, mail: !confirm });
        let mailed = created.mailed;
        if (confirm) {
          mailed = await confirmFormAnswer(form.page_id, user, saved.cells, { sender, anonymous: !!form.anonymous, ticketUrl: created.url });
          if (!mailed && created.email) mailed = await mailTicketLink({ token: created.token, email: created.email, title: form.title, locale: contentLocale() });
        }
        ticket = { token: created.token, mailed };
      }
      await run(
        "INSERT INTO form_submissions VALUES(?,?,?,?)",
        id(),
        token,
        fingerprint,
        Date.now(),
      );
    });
    return NextResponse.json(ticket ? { ok: true, ticket: ticket.token, mailed: ticket.mailed } : { ok: true });
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
export const POST = withRequestLocale(handlePOST);

// Save and continue later (signed-in people, forms that are not
// anonymous): GET reads the draft, PUT stores it, DELETE discards it.
function draftHandler(kind: "get" | "put" | "delete") {
  return async (req: Request, { params }: { params: Promise<{ token: string }> }) => {
    try {
      if (kind !== "get") await checkOrigin(req);
      const { token } = await params;
      const user = await activeUserFromRequest(req);
      if (kind !== "get") refuseReadToken(user);
      if (kind === "get") return NextResponse.json({ draft: await formDraft(token, user) });
      if (kind === "delete") return NextResponse.json(await deleteFormDraft(token, user));
      requireBodySize(req, 110_000, "Entwurf zu groß.");
      const raw = await readTextLimited(req, 110_000, "Entwurf zu groß.");
      if (raw.length > 110_000) throw new HttpError(413, "Entwurf zu groß.");
      return NextResponse.json(await saveFormDraft(token, user, JSON.parse(raw)));
    } catch (e) {
      const known = e instanceof HttpError,
        input = e instanceof z.ZodError || e instanceof SyntaxError;
      return NextResponse.json(
        { error: known ? e.message : input ? "Bitte Eingaben prüfen." : "Entwurf konnte nicht gespeichert werden." },
        { status: known ? e.status : input ? 400 : 500 },
      );
    }
  };
}
export const GET = withRequestLocale(draftHandler("get"));
export const PUT = withRequestLocale(draftHandler("put"));
export const DELETE = withRequestLocale(draftHandler("delete"));
