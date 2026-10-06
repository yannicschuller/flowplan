// "3 h 20 min" for time tracking. Client-safe.
export function formatDuration(seconds: number) {
  const minutes = Math.round(seconds / 60);
  const h = Math.floor(minutes / 60),
    m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}
// "90", "1:30" or "1,5h" → minutes.
export function parseMinutes(text: string) {
  const s = text.trim().toLowerCase().replace(",", ".");
  const clock = /^(\d+):(\d{1,2})$/.exec(s);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
  const inHours = /^(\d+(?:\.\d+)?)\s*h$/.exec(s);
  if (inHours) return Math.round(Number(inHours[1]) * 60);
  const plain = Number(s.replace(/\s*min$/, ""));
  return Number.isFinite(plain) ? Math.round(plain) : 0;
}
// Decimal hours, e.g. 3.25 (reports, CSV).
export const hours = (seconds: number) => Math.round((seconds / 3600) * 100) / 100;
