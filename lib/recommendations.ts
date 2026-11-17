// Recommendations for the administration, derived from the measurements
// (lib/server-metrics.ts, lib/metrics.ts, lib/ai-statistics.ts) and the
// setup: each rule is a pure function of a snapshot of those numbers and
// the thresholds, and says why in a sentence built from the numbers, with
// a page of the documentation. Gathering the snapshot, caching (at most
// every 15 minutes) and what administrators hid or postponed live in
// lib/recommendations-data.ts; this file does no I/O, so every rule is
// tested on its own (tests/recommendations.test.ts).
//
// Texts are German and English side by side ([de, en]); the browser picks
// one (t(de, en)).
import type { RouteStat } from "./metrics";

const DAY = 86_400_000;

export const RECOMMENDATION_IDS = [
  "scale-up",
  "over-provisioned",
  "disk",
  "sqlite-postgres",
  "backup",
  "mail",
  "update",
  "https",
  "metrics-token",
  "slow-endpoints",
  "documents-per-person",
  "ai-latency",
  "ai-costs",
  "memory-growth",
  "error-jump",
  "restarts",
] as const;
export type RecommendationId = (typeof RECOMMENDATION_IDS)[number];
export type RecommendationGroup = "load" | "setup" | "performance" | "ai" | "anomaly";
export const RECOMMENDATION_GROUP: Record<RecommendationId, RecommendationGroup> = {
  "scale-up": "load",
  "over-provisioned": "load",
  disk: "load",
  "sqlite-postgres": "load",
  backup: "setup",
  mail: "setup",
  update: "setup",
  https: "setup",
  "metrics-token": "setup",
  "slow-endpoints": "performance",
  "documents-per-person": "performance",
  "ai-latency": "performance",
  "ai-costs": "ai",
  "memory-growth": "anomaly",
  "error-jump": "anomaly",
  restarts: "anomaly",
};

// Defaults; administrators change them under Überwachung → Empfehlungen.
export const DEFAULT_THRESHOLDS = {
  // Share of the limit at the busy time of a day (p95 of its minutes) …
  cpuHigh: 0.8,
  memHigh: 0.8,
  // … on at least this many of the last 7 days.
  highDays: 3,
  // Over-provisioned: below these at the busy time on every day (at least 3 days).
  cpuLow: 0.15,
  memLow: 0.4,
  // The disk: full within this many days, or used to this share.
  diskDaysLeft: 30,
  diskUsed: 0.85,
  // SQLite: from this many people active at once.
  sqliteActive: 75,
  // The last backup older than this.
  backupAgeDays: 3,
  // An endpoint slower than this (p95) with at least 20 requests a day.
  slowRouteMs: 2000,
  // Live documents per active person.
  documentsPerPerson: 8,
  // AI answers slower than this (p95).
  aiP95Ms: 20_000,
  // AI cost (or tokens) of the last 7 days to the 7 before.
  aiGrowth: 2,
  // One feature's share of the AI tokens.
  aiFeatureShare: 0.7,
  // Process memory growing by this share over the days while people do not.
  memGrowth: 0.5,
  // 5xx rate of the last 24 h to the 24 h before (and at least 1 %).
  errorJump: 3,
  // Restarts (gaps in the samples) within 7 days.
  restarts: 3,
} as const;
export type Thresholds = { -readonly [K in keyof typeof DEFAULT_THRESHOLDS]: number };
export const THRESHOLD_LIMITS: Record<keyof Thresholds, [number, number]> = {
  cpuHigh: [0.3, 1],
  memHigh: [0.3, 1],
  highDays: [1, 7],
  cpuLow: [0, 0.5],
  memLow: [0, 0.8],
  diskDaysLeft: [1, 365],
  diskUsed: [0.5, 0.99],
  sqliteActive: [5, 10_000],
  backupAgeDays: [1, 60],
  slowRouteMs: [100, 60_000],
  documentsPerPerson: [1, 100],
  aiP95Ms: [1000, 300_000],
  aiGrowth: [1.1, 20],
  aiFeatureShare: [0.3, 1],
  memGrowth: [0.1, 5],
  errorJump: [1.5, 50],
  restarts: [1, 50],
};
export function cleanThresholds(raw: unknown): Thresholds {
  const out = { ...DEFAULT_THRESHOLDS } as Thresholds;
  if (raw && typeof raw === "object")
    for (const key of Object.keys(DEFAULT_THRESHOLDS) as (keyof Thresholds)[]) {
      const v = Number((raw as Record<string, unknown>)[key]);
      const [min, max] = THRESHOLD_LIMITS[key];
      if (Number.isFinite(v)) out[key] = Math.min(max, Math.max(min, v));
    }
  return out;
}

/* ---------- The snapshot the rules read ---------- */

export type DayLoad = {
  day: number;
  // Shares of the limit at the busy time (p95 of the day's minutes).
  cpuPeak: number;
  memPeak: number;
  cpuMean: number;
  memMean: number;
  // The process's memory at the start and end of the day.
  rssFirst: number;
  rssLast: number;
  // Most people active at once (null: statistics off).
  activePeak: number | null;
  // p95 of the day's requests (ms), null without requests.
  p95: number | null;
  // Gaps of more than 5 minutes in the samples (restarts, outages).
  gaps: number;
  minutes: number;
};
export type RecommendationInput = {
  now: number;
  days: DayLoad[];
  limits: { cpu: number; cpuLimited: boolean; memory: number; memoryLimited: boolean };
  disk: { total: number | null; free: number | null; growthPerDay: number | null; uploads: number | null; database: number | null; trashedPages: number; versions: number };
  database: { backend: "sqlite" | "postgres"; commandP95: number | null; transactionMaxSeconds: number | null };
  setup: {
    backup: { enabled: boolean; lastAt: number | null; error: string | null };
    litestream: boolean;
    mail: boolean;
    version: string | null;
    latest: string | null;
    plainHttp: boolean;
    metricsToken: string | null;
  };
  routes: RouteStat[];
  searchBacklog: number;
  live: { documents: number; connections: number; activeNow: number };
  ai: {
    enabled: boolean;
    p95: number | null;
    requests: number;
    // The last 7 days and the 7 before: cost (null without prices) and tokens.
    cost: [number | null, number | null];
    tokens: [number, number];
    currency: string;
    topFeature: { feature: string; share: number } | null;
  };
  errors: { requests: number; errors: number; previous: { requests: number; errors: number } | null };
  statisticsOn: boolean;
};

export type Recommendation = {
  id: RecommendationId;
  group: RecommendationGroup;
  level: "warn" | "info";
  title: [string, string];
  reason: [string, string];
  action: [string, string];
  // A page of docs.flowplan.org: German, English.
  docs: [string, string];
  // For a bug report (anomalies): numbers only.
  debug?: Record<string, unknown>;
};

/* ---------- Wording ---------- */

const DOCS = "https://docs.flowplan.org";
const docs = (slug: string): [string, string] => [`${DOCS}/${slug}`, `${DOCS}/en/${slug}`];
const n = (v: number, digits = 0): [string, string] => [v.toLocaleString("de-DE", { maximumFractionDigits: digits }), v.toLocaleString("en-US", { maximumFractionDigits: digits })];
const pct = (share: number): [string, string] => {
  const [de, en] = n(share * 100, share < 0.1 ? 1 : 0);
  return [`${de} %`, `${en} %`];
};
const size = (bytes: number): [string, string] => {
  const units: [number, string][] = [
    [1024 ** 4, "TB"],
    [1024 ** 3, "GB"],
    [1024 ** 2, "MB"],
    [1024, "kB"],
  ];
  const [factor, unit] = units.find(([f]) => bytes >= f) || [1, "B"];
  const [de, en] = n(bytes / factor, bytes / factor < 10 ? 1 : 0);
  return [`${de} ${unit}`, `${en} ${unit}`];
};
const seconds = (ms: number): [string, string] => {
  if (ms < 1000) {
    const [de, en] = n(ms);
    return [`${de} ms`, `${en} ms`];
  }
  const [de, en] = n(ms / 1000, 1);
  return [`${de} s`, `${en} s`];
};
const money = (v: number, currency: string): [string, string] => {
  const f = (locale: string) => {
    try {
      return v.toLocaleString(locale, { style: "currency", currency, maximumFractionDigits: 2 });
    } catch {
      return `${v.toFixed(2)} ${currency}`;
    }
  };
  return [f("de-DE"), f("en-US")];
};
type Part = string | [string, string];
// A sentence from fixed text and numbers: de(…) and en(…) side by side.
function say(de: Part[], en: Part[]): [string, string] {
  const join = (parts: Part[], i: 0 | 1) => parts.map((p) => (typeof p === "string" ? p : p[i])).join("");
  return [join(de, 0), join(en, 1)];
}
const plural = (count: number, one: [string, string], many: [string, string]): [string, string] => (count === 1 ? one : many);

/* ---------- The rules ---------- */

type Rule = (x: RecommendationInput, t: Thresholds) => Recommendation | null;
const make = (id: RecommendationId, level: Recommendation["level"], title: [string, string], reason: [string, string], action: [string, string], link: [string, string], debug?: Record<string, unknown>): Recommendation => ({
  id,
  group: RECOMMENDATION_GROUP[id],
  level,
  title,
  reason,
  action,
  docs: link,
  ...(debug ? { debug } : {}),
});

// CPU or memory near the limit at peak times on several days, or answers
// getting slower on the days with more people.
export const scaleUp: Rule = (x, t) => {
  const days = x.days.filter((d) => d.minutes >= 60);
  const cpuDays = days.filter((d) => d.cpuPeak >= t.cpuHigh).length;
  const memDays = days.filter((d) => d.memPeak >= t.memHigh).length;
  const byPeople = days.filter((d) => d.activePeak !== null && d.p95 !== null).sort((a, b) => a.activePeak! - b.activePeak!);
  let slower: { ratio: number; few: number; many: number } | null = null;
  if (byPeople.length >= 4) {
    const half = Math.floor(byPeople.length / 2);
    const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
    const low = median(byPeople.slice(0, half).map((d) => d.p95!)),
      high = median(byPeople.slice(-half).map((d) => d.p95!));
    const peopleLow = median(byPeople.slice(0, half).map((d) => d.activePeak!)),
      peopleHigh = median(byPeople.slice(-half).map((d) => d.activePeak!));
    if (low > 0 && high / low >= 1.5 && high >= 500 && peopleHigh >= peopleLow * 1.3) slower = { ratio: high / low, few: low, many: high };
  }
  if (cpuDays < t.highDays && memDays < t.highDays && !(slower && (cpuDays || memDays))) return null;
  const reasons: [string, string][] = [];
  if (cpuDays >= t.highDays || (slower && cpuDays))
    reasons.push(say(["CPU über ", pct(t.cpuHigh), " des Limits an ", n(cpuDays), " der letzten ", n(days.length), " Tage zu Stoßzeiten"], ["CPU above ", pct(t.cpuHigh), " of the limit on ", n(cpuDays), " of the last ", n(days.length), " days at peak times"]));
  if (memDays >= t.highDays || (slower && memDays))
    reasons.push(say(["Arbeitsspeicher über ", pct(t.memHigh), " an ", n(memDays), " Tagen"], ["memory above ", pct(t.memHigh), " on ", n(memDays), " days"]));
  if (slower) reasons.push(say(["an Tagen mit mehr Personen antwortet Flowplan langsamer (p95 ", seconds(slower.many), " statt ", seconds(slower.few), ")"], ["on days with more people Flowplan answers more slowly (p95 ", seconds(slower.many), " instead of ", seconds(slower.few), ")"]));
  const big = x.days.some((d) => (d.activePeak ?? 0) >= t.sqliteActive);
  return make(
    "scale-up",
    "warn",
    ["Mehr Leistung einplanen", "Plan for more capacity"],
    [reasons.map((r) => r[0]).join("; ") + ".", capitalize(reasons.map((r) => r[1]).join("; ")) + "."],
    big
      ? ["Erhöhe das CPU- und Speicherlimit – bei dieser Größe lohnen sich PostgreSQL und mehrere Instanzen.", "Raise the CPU and memory limit – at this size PostgreSQL and several instances pay off."]
      : x.limits.cpuLimited || x.limits.memoryLimited
        ? ["Erhöhe das CPU- und Speicherlimit des Containers.", "Raise the container's CPU and memory limit."]
        : ["Gib dem Rechner mehr CPU und Arbeitsspeicher.", "Give the machine more CPU and memory."],
    big ? docs("kubernetes") : docs("sizing"),
  );
};
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const overProvisioned: Rule = (x, t) => {
  if (!x.limits.cpuLimited && !x.limits.memoryLimited) return null;
  const days = x.days.filter((d) => d.minutes >= 12 * 60);
  if (days.length < 3) return null;
  const cpu = Math.max(...days.map((d) => d.cpuPeak)),
    mem = Math.max(...days.map((d) => d.memPeak));
  if (cpu >= t.cpuLow || mem >= t.memLow) return null;
  return make(
    "over-provisioned",
    "info",
    ["Limits sind großzügig", "Limits are generous"],
    say(
      ["An ", n(days.length), " Tagen höchstens ", pct(cpu), " CPU und ", pct(mem), " Arbeitsspeicher des Limits, auch zu Stoßzeiten."],
      ["On ", n(days.length), " days at most ", pct(cpu), " CPU and ", pct(mem), " memory of the limit, at peak times too."],
    ),
    ["Du kannst die Limits senken und Ressourcen sparen.", "You can lower the limits and save resources."],
    docs("sizing"),
  );
};

export const disk: Rule = (x, t) => {
  const { total, free, growthPerDay } = x.disk;
  if (!total || free === null) return null;
  const used = 1 - free / total;
  const daysLeft = growthPerDay && growthPerDay > 0 ? free / growthPerDay : null;
  const soon = daysLeft !== null && daysLeft <= t.diskDaysLeft;
  if (!soon && used < t.diskUsed) return null;
  const extras: [string, string][] = [];
  if (x.disk.uploads && x.disk.uploads > total * 0.3) extras.push(say(["Uploads belegen ", size(x.disk.uploads)], ["uploads take ", size(x.disk.uploads)]));
  if (x.disk.versions >= 50_000) extras.push(say([n(x.disk.versions), " alte Versionen"], [n(x.disk.versions), " old versions"]));
  if (x.disk.trashedPages >= 1000) extras.push(say([n(x.disk.trashedPages), " Seiten im Papierkorb"], [n(x.disk.trashedPages), " pages in the trash"]));
  const head = soon
    ? say(["Bei ", size(growthPerDay!), " Zuwachs pro Tag ist der Speicherplatz in etwa ", n(Math.max(0, Math.floor(daysLeft!))), " Tagen voll (", pct(used), " belegt)"], ["At ", size(growthPerDay!), " growth per day the disk is full in about ", n(Math.max(0, Math.floor(daysLeft!))), " days (", pct(used), " used)"])
    : say(["Der Speicherplatz ist zu ", pct(used), " belegt (", size(free), " frei)"], ["The disk is ", pct(used), " used (", size(free), " free)"]);
  return make(
    "disk",
    soon && daysLeft! <= 7 ? "warn" : used >= 0.95 ? "warn" : "info",
    ["Speicherplatz wird knapp", "Disk space is running out"],
    [[head[0], ...extras.map((e) => e[0])].join("; ") + ".", [head[1], ...extras.map((e) => e[1])].join("; ") + "."],
    ["Räum auf (Papierkorb, Versionen, große Uploads), vergrößere das Volume oder lagere Dateien auf S3 aus.", "Clean up (trash, versions, large uploads), grow the volume or move files to S3."],
    docs("configuration-storage"),
  );
};

export const sqlitePostgres: Rule = (x, t) => {
  if (x.database.backend !== "sqlite") return null;
  const peak = Math.max(0, ...x.days.map((d) => d.activePeak ?? 0));
  const slowWrites = x.database.commandP95 !== null && x.database.commandP95 >= 1000;
  const longLocks = x.database.transactionMaxSeconds !== null && x.database.transactionMaxSeconds >= 2;
  if (peak < t.sqliteActive && !(slowWrites && peak >= t.sqliteActive / 2) && !longLocks) return null;
  const parts: [string, string][] = [];
  if (peak) parts.push(say(["bis zu ", n(peak), " Personen gleichzeitig aktiv"], ["up to ", n(peak), " people active at once"]));
  if (slowWrites) parts.push(say(["Änderungen brauchen bis zu ", seconds(x.database.commandP95!), " (p95)"], ["changes take up to ", seconds(x.database.commandP95!), " (p95)"]));
  if (longLocks) parts.push(say(["eine Schreibsperre von SQLite hielt ", seconds(x.database.transactionMaxSeconds! * 1000)], ["a SQLite write lock was held ", seconds(x.database.transactionMaxSeconds! * 1000)]));
  return make(
    "sqlite-postgres",
    "info",
    ["Wechsel zu PostgreSQL erwägen", "Consider moving to PostgreSQL"],
    [capitalize(parts.map((p) => p[0]).join(", ")) + " – SQLite lässt immer nur einen Schreibvorgang zu.", capitalize(parts.map((p) => p[1]).join(", ")) + " – SQLite allows only one write at a time."],
    ["Mit PostgreSQL laufen Schreibvorgänge parallel, und später auch mehrere Instanzen.", "With PostgreSQL writes run in parallel, and later several instances too."],
    docs("postgresql"),
  );
};

export const backup: Rule = (x, t) => {
  const b = x.setup.backup;
  if (x.setup.litestream && b.enabled && !b.error) return null;
  if (!b.enabled && !x.setup.litestream)
    return make("backup", "warn", ["Keine Sicherung eingerichtet", "No backup set up"], ["Weder die geplante Sicherung noch Litestream ist eingeschaltet.", "Neither the scheduled backup nor Litestream is switched on."], ["Schalte die geplante Sicherung ein oder richte Litestream mit S3 ein.", "Switch on the scheduled backup or set up Litestream with S3."], docs("storage-and-backups"));
  if (!b.enabled) return null;
  const age = b.lastAt === null ? null : (x.now - b.lastAt) / DAY;
  if (b.error)
    return make("backup", "warn", ["Die letzte Sicherung ist fehlgeschlagen", "The last backup failed"], say(["Fehler: ", b.error.slice(0, 120)], ["Error: ", b.error.slice(0, 120)]), ["Prüf das Ziel der Sicherung und starte sie von Hand.", "Check the backup's target and start it by hand."], docs("storage-and-backups"));
  if (age === null || age >= t.backupAgeDays)
    return make(
      "backup",
      "warn",
      ["Sicherung ist alt", "Backup is old"],
      age === null ? ["Es gibt noch keine Sicherung.", "There is no backup yet."] : say(["Die letzte Sicherung ist ", n(Math.floor(age)), " Tage alt."], ["The last backup is ", n(Math.floor(age)), " days old."]),
      ["Prüf, ob die geplante Sicherung läuft.", "Check that the scheduled backup runs."],
      docs("storage-and-backups"),
    );
  return null;
};

export const mail: Rule = (x) =>
  x.setup.mail
    ? null
    : make("mail", "info", ["Kein E-Mail-Versand", "No e-mail delivery"], ["SMTP ist nicht eingerichtet: Einladungen, Passwort-Links und Warnungen gehen nicht per E-Mail raus.", "SMTP is not set up: invitations, password links and alerts are not sent by e-mail."], ["Trag einen SMTP-Server ein.", "Enter an SMTP server."], docs("configuration-integrations"));

export const update: Rule = (x) => {
  if (!x.setup.latest || !x.setup.version) return null;
  const [a, b] = [x.setup.version, x.setup.latest].map((v) => v.split(".").map(Number));
  const behind = (b[0] - a[0]) * 100 + (b[1] - a[1]);
  return make(
    "update",
    behind >= 2 ? "warn" : "info",
    ["Neue Version verfügbar", "New version available"],
    say(["Hier läuft ", x.setup.version, ", aktuell ist ", x.setup.latest, "."], ["This runs ", x.setup.version, ", the current one is ", x.setup.latest, "."]),
    ["Aktualisiere das Image – Sicherheitskorrekturen kommen nur mit neuen Versionen.", "Update the image – security fixes only come with new versions."],
    docs("operations"),
  );
};

export const https: Rule = (x) =>
  x.setup.plainHttp
    ? make("https", "warn", ["Ohne HTTPS erreichbar", "Reachable without HTTPS"], ["APP_URL ist eine http-Adresse: Passwörter gehen unverschlüsselt durchs Netz, Passkeys und die Apps funktionieren nicht.", "APP_URL is an http address: passwords cross the network unencrypted, passkeys and the apps do not work."], ["Setz einen Reverse Proxy mit TLS davor und stell APP_URL auf https.", "Put a reverse proxy with TLS in front and set APP_URL to https."], docs("coolify-and-proxy"))
    : null;

export const metricsToken: Rule = (x) =>
  x.setup.metricsToken !== null && x.setup.metricsToken.length < 24
    ? make("metrics-token", "warn", ["Schwacher Token für /api/metrics", "Weak token for /api/metrics"], say(["FLOWPLAN_METRICS_TOKEN hat nur ", n(x.setup.metricsToken.length), " Zeichen."], ["FLOWPLAN_METRICS_TOKEN has only ", n(x.setup.metricsToken.length), " characters."]), ["Nimm einen zufälligen Token mit mindestens 32 Zeichen.", "Use a random token of at least 32 characters."], docs("monitoring"))
    : null;

// A known cause per kind of route, for the reason.
function routeCause(route: string, backlog: number): [string, string] {
  if (/\/search|search\./.test(route) && backlog >= 500) return say([" – der Suchindex wird gerade neu aufgebaut (", n(backlog), " Einträge warten)"], [" – the search index is being rebuilt (", n(backlog), " entries waiting)"]);
  if (/rows|database|views|collection/.test(route)) return [" – meist eine sehr große Datenbankansicht (Filter, Gruppen oder Formeln über viele Einträge)", " – usually a very large database view (filters, groups or formulas over many records)"];
  if (/export|archive|backup/.test(route)) return [" – Exporte und Sicherungen dauern bei großen Bereichen lange", " – exports and backups take long for large spaces"];
  if (/import/.test(route)) return [" – ein großer Import", " – a large import"];
  if (/\(pages\)/.test(route)) return [" – das erste Laden der Seiten (Rendern auf dem Server)", " – the first load of pages (rendering on the server)"];
  if (/\bai\b|ai\./.test(route)) return [" – wartet auf den KI-Anbieter", " – waits for the AI provider"];
  return ["", ""];
}
export const slowEndpoints: Rule = (x, t) => {
  const slow =x.routes.filter((r) => (r.p95 ?? 0) >= t.slowRouteMs && r.requests >= 20).sort((a, b) => (b.p95 ?? 0) - (a.p95 ?? 0));
  if (!slow.length) return null;
  const top = slow[0];
  const cause = routeCause(top.route, x.searchBacklog);
  return make(
    "slow-endpoints",
    (top.p95 ?? 0) >= t.slowRouteMs * 3 ? "warn" : "info",
    ["Langsame Endpunkte", "Slow endpoints"],
    say(
      [top.route, " braucht p95 ", seconds(top.p95!), " bei ", n(top.requests), " Anfragen", cause, slow.length > 1 ? [`; ${slow.length - 1} weitere über ${n(t.slowRouteMs / 1000, 1)[0]} s`, ""] : "", "."],
      [top.route, " takes p95 ", seconds(top.p95!), " over ", n(top.requests), " requests", cause, slow.length > 1 ? ["", `; ${slow.length - 1} more above ${n(t.slowRouteMs / 1000, 1)[1]} s`] : "", "."],
    ),
    ["Sieh dir unter Überwachung → Server an, was die Zeit braucht.", "See under Monitoring → Server what takes the time."],
    docs("monitoring"),
  );
};

export const documentsPerPerson: Rule = (x, t) => {
  const people = x.live.activeNow;
  if (people < 2 || x.live.documents < 10) return null;
  const per = x.live.documents / people;
  if (per < t.documentsPerPerson) return null;
  return make(
    "documents-per-person",
    "info",
    ["Viele offene Dokumente je Person", "Many open documents per person"],
    say([n(x.live.documents), " Dokumente sind live geöffnet bei ", n(people), " aktiven Personen (", n(per, 1), " je Person, ", n(x.live.connections), " Verbindungen)."], [n(x.live.documents), " documents are open live with ", n(people), " active people (", n(per, 1), " per person, ", n(x.live.connections), " connections)."]),
    ["Jedes offene Dokument hält eine Verbindung und Speicher – viele Tabs mit Seiten sind der übliche Grund.", "Every open document holds a connection and memory – many tabs with pages are the usual reason."],
    docs("sizing"),
  );
};

export const aiLatency: Rule = (x, t) =>
  x.ai.enabled && x.ai.p95 !== null && x.ai.requests >= 10 && x.ai.p95 >= t.aiP95Ms
    ? make("ai-latency", "info", ["KI antwortet langsam", "AI answers slowly"], say(["KI-Antworten brauchen p95 ", seconds(x.ai.p95), " (", n(x.ai.requests), " Anfragen in 7 Tagen)."], ["AI answers take p95 ", seconds(x.ai.p95), " (", n(x.ai.requests), " requests in 7 days)."]), ["Ein kleineres oder schnelleres Modell (oder mehr Leistung für Ollama) hilft.", "A smaller or faster model (or more power for Ollama) helps."], docs("ai"))
    : null;

export const aiCosts: Rule = (x, t) => {
  if (!x.ai.enabled) return null;
  const [costNow, costBefore] = x.ai.cost;
  const [tokNow, tokBefore] = x.ai.tokens;
  const parts: [string, string][] = [];
  if (costNow !== null && costBefore !== null && costBefore > 0 && costNow / costBefore >= t.aiGrowth && costNow >= 1)
    parts.push(say(["die Kosten der letzten 7 Tage sind auf ", money(costNow, x.ai.currency), " gestiegen (das ", n(costNow / costBefore, 1), "-Fache der 7 Tage davor)"], ["the cost of the last 7 days rose to ", money(costNow, x.ai.currency), " (", n(costNow / costBefore, 1), " times the 7 days before)"]));
  else if (costNow === null && tokBefore > 0 && tokNow / tokBefore >= t.aiGrowth && tokNow >= 100_000)
    parts.push(say(["die Tokens der letzten 7 Tage sind auf das ", n(tokNow / tokBefore, 1), "-Fache gestiegen"], ["the tokens of the last 7 days rose to ", n(tokNow / tokBefore, 1), " times"]));
  if (!parts.length) return null;
  if (x.ai.topFeature && x.ai.topFeature.share >= t.aiFeatureShare) parts.push(say(["„", x.ai.topFeature.feature, "“ braucht ", pct(x.ai.topFeature.share), " davon"], ["“", x.ai.topFeature.feature, "” uses ", pct(x.ai.topFeature.share), " of it"]));
  return make(
    "ai-costs",
    "warn",
    ["KI-Kosten steigen", "AI costs are rising"],
    [capitalize(parts.map((p) => p[0]).join("; ")) + ". Grenzen je Arbeitsbereich gibt es nicht.", capitalize(parts.map((p) => p[1]).join("; ")) + ". There are no limits per workspace."],
    ["Senk das Limit je Person und Stunde (FLOWPLAN_AI_REQUESTS_PER_HOUR), schalte die teuerste Funktion ab oder nimm ein günstigeres Modell.", "Lower the limit per person and hour (FLOWPLAN_AI_REQUESTS_PER_HOUR), switch off the most expensive feature or use a cheaper model."],
    docs("ai"),
  );
};

export const memoryGrowth: Rule = (x, t) => {
  const days = x.days.filter((d) => d.minutes >= 60);
  if (days.length < 3) return null;
  const first = days[0],
    last = days[days.length - 1];
  // Growing day after day (each day ends above the one before, give or take 5 %).
  const steady = days.every((d, i) => i === 0 || d.rssLast >= days[i - 1].rssLast * 0.95);
  const growth = first.rssFirst ? last.rssLast / first.rssFirst - 1 : 0;
  const peopleThen = first.activePeak ?? 0,
    peopleNow = last.activePeak ?? 0;
  const morePeople = peopleThen > 0 ? peopleNow / peopleThen - 1 : peopleNow > 0 ? 1 : 0;
  // A restart in between resets the memory: no steady growth then.
  if (!steady || growth < t.memGrowth || morePeople >= growth / 2 || days.some((d) => d.gaps > 0)) return null;
  return make(
    "memory-growth",
    "warn",
    ["Arbeitsspeicher wächst ohne mehr Nutzung", "Memory grows without more use"],
    say(
      ["Flowplan belegt seit ", n(days.length), " Tagen immer mehr Arbeitsspeicher (", size(first.rssFirst), " → ", size(last.rssLast), ", +", pct(growth), "), die Zahl der Personen blieb gleich – vielleicht ein Speicherleck."],
      ["Flowplan has used more and more memory for ", n(days.length), " days (", size(first.rssFirst), " → ", size(last.rssLast), ", +", pct(growth), "), while the number of people stayed the same – possibly a memory leak."],
    ),
    ["Kopier die Debug-Daten in einen Fehlerbericht; ein Neustart gibt den Speicher bis dahin frei.", "Copy the debug data into a bug report; a restart frees the memory until then."],
    docs("monitoring"),
    { rss: days.map((d) => ({ day: new Date(d.day).toISOString().slice(0, 10), first: d.rssFirst, last: d.rssLast, activePeak: d.activePeak })) },
  );
};

export const errorJump: Rule = (x, t) => {
  const p = x.errors.previous;
  if (!p || x.errors.requests < 200) return null;
  const now = x.errors.errors / x.errors.requests;
  const before = p.requests ? p.errors / p.requests : 0;
  if (now < 0.01 || now < Math.max(before, 0.001) * t.errorJump) return null;
  return make(
    "error-jump",
    "warn",
    ["Fehlerquote gesprungen", "Error rate jumped"],
    say(["", pct(now), " der Anfragen der letzten 24 Stunden endeten mit einem Serverfehler (5xx), am Tag davor ", pct(before), "."], ["", pct(now), " of the requests of the last 24 hours ended in a server error (5xx), the day before ", pct(before), "."]),
    ["Sieh in die Ereignisse und das Log des Containers; die Debug-Daten helfen in einem Fehlerbericht.", "Check the events and the container's log; the debug data help in a bug report."],
    docs("monitoring"),
    { requests: x.errors.requests, errors: x.errors.errors, previous: p },
  );
};

export const restarts: Rule = (x, t) => {
  const count = x.days.reduce((a, d) => a + d.gaps, 0);
  if (count < t.restarts) return null;
  return make(
    "restarts",
    "warn",
    ["Häufige Neustarts", "Frequent restarts"],
    say(["Flowplan war in den letzten 7 Tagen ", n(count), " ", plural(count, ["Mal", "time"], ["Mal", "times"]), " für mehr als 5 Minuten weg (Neustarts oder Ausfälle)."], ["Flowplan was gone for more than 5 minutes ", n(count), " ", plural(count, ["Mal", "time"], ["Mal", "times"]), " in the last 7 days (restarts or outages)."]),
    ["Prüf, ob der Container wegen zu wenig Arbeitsspeicher beendet wird (OOM); die Debug-Daten helfen in einem Fehlerbericht.", "Check whether the container is stopped for lack of memory (OOM); the debug data help in a bug report."],
    docs("monitoring"),
    { gaps: x.days.map((d) => ({ day: new Date(d.day).toISOString().slice(0, 10), gaps: d.gaps, memPeak: Math.round(d.memPeak * 100) / 100 })) },
  );
};

export const RULES: Record<RecommendationId, Rule> = {
  "scale-up": scaleUp,
  "over-provisioned": overProvisioned,
  disk,
  "sqlite-postgres": sqlitePostgres,
  backup,
  mail,
  update,
  https,
  "metrics-token": metricsToken,
  "slow-endpoints": slowEndpoints,
  "documents-per-person": documentsPerPerson,
  "ai-latency": aiLatency,
  "ai-costs": aiCosts,
  "memory-growth": memoryGrowth,
  "error-jump": errorJump,
  restarts,
};

// Every rule that is not switched off, warnings first.
export function evaluate(input: RecommendationInput, thresholds: Thresholds = { ...DEFAULT_THRESHOLDS }, off: RecommendationId[] = []): Recommendation[] {
  const out: Recommendation[] = [];
  for (const id of RECOMMENDATION_IDS) {
    if (off.includes(id)) continue;
    try {
      const r = RULES[id](input, thresholds);
      if (r) out.push(r);
    } catch {
      // One rule's bad number never hides the others.
    }
  }
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === "warn" ? -1 : 1));
}
