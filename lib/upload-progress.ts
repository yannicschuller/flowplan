// A POST of a form with the upload's progress (#561): XMLHttpRequest, as
// fetch() cannot report how much of a request body has gone out yet. The
// answer is read as fetch() callers read it – JSON, a refusal as the
// server's message (lib/server-message.ts), no connection as fetch()'s
// TypeError – and the request can be cancelled.
import { serverMessage } from "./server-message";

export type Progress = { loaded: number; total: number };
// Cancelled by the person: not an error to report.
export class UploadCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "UploadCancelled";
  }
}
export const isCancelled = (error: unknown) => error instanceof UploadCancelled;

type Options = {
  headers?: Record<string, string>;
  // The size to report until the browser knows the whole body's.
  size?: number;
  onProgress?: (progress: Progress) => void;
  // Every answer's status (a 401 ends the session, components/ui.tsx).
  onStatus?: (status: number) => void;
  // For tests: the request class.
  Request?: typeof XMLHttpRequest;
};

export function sendWithProgress<T = unknown>(url: string, body: FormData, options: Options = {}) {
  const Request = options.Request ?? XMLHttpRequest;
  const request = new Request();
  let cancelled = false;
  const done = new Promise<T>((resolve, reject) => {
    request.open("POST", url);
    for (const [name, value] of Object.entries(options.headers ?? {})) request.setRequestHeader(name, value);
    const size = options.size ?? 0;
    request.upload.onprogress = (e) => options.onProgress?.({ loaded: e.loaded, total: e.lengthComputable && e.total ? e.total : Math.max(size, e.loaded) });
    request.onload = () => {
      options.onStatus?.(request.status);
      let data: { error?: string };
      try {
        data = JSON.parse(request.responseText);
      } catch (error) {
        return reject(error);
      }
      if (request.status >= 200 && request.status < 300) resolve(data as T);
      else reject(new Error(serverMessage(data?.error)));
    };
    request.onerror = () => reject(new TypeError("Failed to fetch"));
    request.ontimeout = () => reject(new TypeError("Failed to fetch"));
    request.onabort = () => reject(cancelled ? new UploadCancelled() : new TypeError("Failed to fetch"));
    request.send(body);
  });
  return {
    done,
    cancel() {
      cancelled = true;
      request.abort();
    },
  };
}
