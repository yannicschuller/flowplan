// The sign-in page in the mobile app reports a hand-off that failed or went
// unanswered (lib/app-sign-in.ts, #109): one line in the instance's log, so
// whoever runs it can tell what happened. No account is needed – it happens
// before signing in – so the text is cut, cleaned and the lines are limited.
import { z } from "zod";

const text = (max: number) =>
  z
    .string()
    .max(1000)
    .transform((value) => value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").slice(0, max));

const reportSchema = z.object({
  via: z.enum(["sso", "passkey"]),
  how: z.enum(["bridge", "link"]),
  reason: z.enum(["no-answer", "failed"]),
  detail: text(300).optional().default(""),
  app: text(20).optional().default(""),
  platform: z.enum(["android", "ios", "other"]).optional().default("other"),
});

const WINDOW_MS = 10 * 60_000;
const MAX_LINES = 20;
let windowStart = 0,
  lines = 0;

// The line for the log, or null when the input is no report or the limit
// for now is reached.
export function appSignInReportLine(input: unknown, now = Date.now()): string | null {
  const parsed = reportSchema.safeParse(input);
  if (!parsed.success) return null;
  if (now - windowStart >= WINDOW_MS) {
    windowStart = now;
    lines = 0;
  }
  if (++lines > MAX_LINES) return null;
  const r = parsed.data;
  const what = r.reason === "no-answer" ? "the app did not answer (nothing opened)" : `the app could not open it – ${r.detail || "no reason given"}`;
  return `App sign-in (${r.via}, ${r.platform} app ${r.app || "?"}, ${r.how === "bridge" ? "through the bridge" : "through the link"}) failed: ${what}`;
}

export function resetAppSignInReports() {
  windowStart = 0;
  lines = 0;
}
