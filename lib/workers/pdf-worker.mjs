// A worker thread for pdf.js (started by lib/pdf-text.ts): one job at a
// time, { id, kind: "text" | "scan", data } in, { id, value } or
// { id, error } out.
import { parentPort } from "node:worker_threads";
import { pdfScanImages, pdfText } from "./pdf-core.mjs";

parentPort.on("message", async ({ id, kind, data, maxPages }) => {
  try {
    if (kind === "text") parentPort.postMessage({ id, value: await pdfText(data) });
    else {
      // Copied, not transferred: small Buffers share Node's pool.
      parentPort.postMessage({ id, value: await pdfScanImages(data, maxPages) });
    }
  } catch (error) {
    parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
