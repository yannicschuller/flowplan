// An example error for the error details of the monitoring
// (#settings/instance/monitoring/errors): one group with a mapped and a
// compiled frame, written straight into the database of the gallery's own
// server, the way lib/error-details.ts stores it. Its times are real (the
// server keeps 14 days), so the scenes that show it run in real time.
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

export const GALLERY_ERROR_NAME = "GalleryExampleError";

export function seedErrorGroups(dataDir: string, now = Date.now()) {
  const sqlite = new DatabaseSync(join(dataDir, "flowplan.sqlite"));
  try {
    const hour = Math.floor(now / 3_600_000) * 3_600_000;
    const five = Math.floor(now / 300_000) * 300_000;
    const frames = [
      { fn: "loadPage", file: "lib/api.ts", line: 412, column: 9, mapped: true },
      { fn: "Zt", file: ".next/server/chunks/ssr/[root-of-the-server]__0a1b2c._.js", line: 1, column: 48211, mapped: false },
    ];
    const occurrences = [3, 2, 1].map((h) => ({ at: now - h * 3_600_000, requestId: `Gal${h}lery0Req1`, status: 500, method: "POST", node: "", version: "0.12.1", role: "member", message: "Cannot read properties of undefined (reading 'title')" }));
    sqlite
      .prepare(
        "INSERT OR REPLACE INTO error_groups(fingerprint,kind,route,action,name,message,status,frames,db_code,count,first_seen,last_seen,slots,occurrences) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        "gallery0example0err1",
        "request",
        "POST /api/command",
        "row.update",
        GALLERY_ERROR_NAME,
        "Cannot read properties of undefined (reading 'title')",
        500,
        JSON.stringify(frames),
        "",
        3,
        now - 3 * 3_600_000,
        now - 3_600_000,
        JSON.stringify({ f: [[five - 3_600_000, 1]], h: [[hour - 3 * 3_600_000, 1], [hour - 2 * 3_600_000, 1], [hour - 3_600_000, 1]] }),
        JSON.stringify(occurrences),
      );
  } finally {
    sqlite.close();
  }
}
