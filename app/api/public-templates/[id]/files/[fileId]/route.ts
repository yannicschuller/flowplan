import { publicTemplateFile } from "@/lib/public-templates";
import { HttpError } from "@/lib/auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Files of publicly published templates (images, attachments).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; fileId: string }> },
) {
  try {
    const { id, fileId } = await params;
    const file = publicTemplateFile(id, fileId);
    const inline = /^(image\/(png|jpeg|gif|webp|avif)|application\/pdf)$/.test(
      file.mime,
    );
    return new Response(Buffer.from(file.data), {
      headers: {
        "Content-Type": inline ? file.mime : "application/octet-stream",
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'",
        "Cache-Control": "public, max-age=300",
      },
    });
  } catch (e) {
    return Response.json(
      { error: e instanceof HttpError ? e.message : "Datei nicht verfügbar." },
      { status: e instanceof HttpError ? e.status : 500 },
    );
  }
}
