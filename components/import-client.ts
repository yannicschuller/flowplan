// The browser's side of the imports (Settings → Import & Export,
// components/import-sources.tsx, and the introduction's "Woher kommst du?",
// components/onboarding-import.tsx): sending a file with upload progress and
// waiting for a background import (#163). The work itself is the server's
// (lib/importers, lib/zip-import.ts).
import { serverMessage } from "@/lib/server-message";

// Warnings carry a count ("… (3×)"); the text before it is translated.
export const warningText = (warning: string) => {
  const counted = /^(.*) \((\d+)×\)$/.exec(warning);
  return counted ? `${serverMessage(counted[1])} (${counted[2]}×)` : serverMessage(warning);
};

// POST /api/import/source with the file as the raw body (#76).
export function sendImport(query: URLSearchParams, body: File | null, onProgress: (share: number) => void) {
  return new Promise<unknown>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", `/api/import/source?${query}`);
    request.setRequestHeader("Content-Type", "application/octet-stream");
    request.responseType = "json";
    request.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    request.upload.onload = () => onProgress(1);
    request.onload = () => {
      const data = request.response as { error?: string } | null;
      if (request.status >= 200 && request.status < 300) resolve(data);
      else reject(new Error(serverMessage(data?.error) || String(request.status)));
    };
    request.onerror = () => reject(new Error("network"));
    request.send(body);
  });
}

// Asks for a background import's state until it is done (#163). While the
// server writes a large import it may not answer for a while: a gateway
// error of the reverse proxy (502–504) or a lost connection only means
// asking again later, for up to half an hour without an answer.
const PATIENCE_MS = 30 * 60_000;
export async function waitForJob(job: string, onProgress: (share: number | null) => void) {
  let failures = 0,
    lastAnswer = Date.now();
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, 1000 * 2 ** failures)));
    let response: Response | null = null;
    try {
      response = await fetch(`/api/import/source/job?id=${encodeURIComponent(job)}`, { cache: "no-store" });
    } catch {
      /* no connection right now */
    }
    if (!response || (response.status >= 502 && response.status <= 504)) {
      if (Date.now() - lastAnswer > PATIENCE_MS) throw new Error("network");
      failures = Math.min(failures + 1, 4);
      continue;
    }
    failures = 0;
    lastAnswer = Date.now();
    const data = (await response.json().catch(() => null)) as { status?: string; progress?: number | null; result?: unknown; error?: string; code?: number } | null;
    if (!response.ok) throw new Error(serverMessage(data?.error) || String(response.status));
    if (data?.status === "done") return data.result;
    if (data?.status === "failed") throw new Error(serverMessage(data.error) || String(data.code || 500));
    onProgress(typeof data?.progress === "number" ? data.progress : null);
  }
}

export type ImportProgress = { phase: "upload" | "work"; share: number | null };
export type ImportOutcome = { rootIds: string[]; pages: number; rows: number; files: number };

// The import of a file from another tool (lib/importers) as a background
// job: upload, then the server's work.
export async function importSourceFile(
  input: { workspaceId: string; spaceId: string; source: string; file: File },
  onProgress: (progress: ImportProgress) => void,
): Promise<ImportOutcome> {
  const query = new URLSearchParams({ workspaceId: input.workspaceId, spaceId: input.spaceId, source: input.source, mode: "pages", name: input.file.name, background: "1" });
  onProgress({ phase: "upload", share: 0 });
  const { job } = (await sendImport(query, input.file, (share) => onProgress(share >= 1 ? { phase: "work", share: null } : { phase: "upload", share }))) as { job: string };
  onProgress({ phase: "work", share: null });
  const result = (await waitForJob(job, (share) => onProgress({ phase: "work", share }))) as {
    rootIds?: string[];
    pages?: number;
    folders?: number;
    whiteboards?: number;
    databases?: number;
    notebooks?: number;
    wrapper?: string;
    rows?: number;
    files?: number;
  };
  const extra = (result.whiteboards || 0) + (result.databases || 0) + (result.notebooks || 0) + (result.wrapper ? 1 : 0);
  return { rootIds: result.rootIds || [], pages: (result.pages || 0) + (result.folders || 0) + extra, rows: result.rows || 0, files: result.files || 0 };
}

// A Markdown, CSV or Notion export as a ZIP (POST /api/import/zip): the
// upload shows its progress, the work answers at the end.
export function importZipFile(input: { workspaceId: string; spaceId: string; file: File }, onProgress: (progress: ImportProgress) => void) {
  return new Promise<ImportOutcome>((resolve, reject) => {
    const body = new FormData();
    body.set("workspaceId", input.workspaceId);
    body.set("spaceId", input.spaceId);
    body.set("file", input.file);
    const request = new XMLHttpRequest();
    request.open("POST", "/api/import/zip");
    request.responseType = "json";
    onProgress({ phase: "upload", share: 0 });
    request.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded >= e.total ? { phase: "work", share: null } : { phase: "upload", share: e.loaded / e.total });
    request.upload.onload = () => onProgress({ phase: "work", share: null });
    request.onload = () => {
      const data = request.response as ({ error?: string } & Partial<ImportOutcome>) | null;
      if (request.status >= 200 && request.status < 300)
        resolve({ rootIds: data?.rootIds || [], pages: data?.pages || 0, rows: data?.rows || 0, files: data?.files || 0 });
      else reject(new Error(serverMessage(data?.error) || String(request.status)));
    };
    request.onerror = () => reject(new Error("network"));
    request.send(body);
  });
}
