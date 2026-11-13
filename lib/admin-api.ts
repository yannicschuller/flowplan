// The admin API for hosted offerings (off by default): a billing service
// reads an account's limits and usage and sets its limits – nothing else.
// Only when FLOWPLAN_ADMIN_API_TOKEN is set (at least 32 characters);
// otherwise every path answers 404. The token goes as
// `Authorization: Bearer <token>` and is compared in constant time; session
// cookies and personal API tokens never reach it. Wrong tokens count per
// address (ten within 15 minutes lock the address out for this API) and are
// security events (admin_api.refused). Changes are audit-logged with the
// actor "admin-api".
//
//   GET /api/admin-api/users?email=<email>  → { users: [User] }
//   GET /api/admin-api/users/:id            → User
//   PUT /api/admin-api/users/:id/limits     { storageMb?, workspaces?, ai?, aiTokensPerMonth? } → User
//
// null = back to the instance default; 0 = unlimited for storageMb,
// workspaces and aiTokensPerMonth. Fields left out stay as they are.
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { all, audit, one } from "./db";
import { HttpError } from "./auth";
import { allow } from "./action-limits";
import { clientAddress } from "./client-address";
import { blockedRequest, securityEvent } from "./security-events";
import { readTextLimited } from "./request-body";
import { accountedBytes, aiTokensThisMonth, effectiveUserLimits, ownedWorkspaces, setUserLimits, storedUserLimits } from "./user-limits";

export const ADMIN_API_ACTOR = "admin-api";
const MIN_TOKEN = 32;
export const adminApiToken = () => {
  const token = process.env.FLOWPLAN_ADMIN_API_TOKEN?.trim() || "";
  return token.length >= MIN_TOKEN ? token : "";
};

const limitsInput = z
  .object({
    storageMb: z.number().int().min(0).max(10_000_000).nullable().optional(),
    workspaces: z.number().int().min(0).max(10_000).nullable().optional(),
    ai: z.boolean().nullable().optional(),
    aiTokensPerMonth: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
  })
  .strict();
const LIMIT_KEYS = ["storageMb", "workspaces", "ai", "aiTokensPerMonth"] as const;

const state = globalThis as unknown as { flowplanAdminApiFailures?: Map<string, number[]> };
const FAIL_WINDOW = 15 * 60_000,
  FAIL_MAX = 10;
function failures(address: string, now: number) {
  const map = (state.flowplanAdminApiFailures ??= new Map<string, number[]>());
  const list = (map.get(address) || []).filter((at) => at > now - FAIL_WINDOW);
  map.set(address, list);
  return list;
}
const digest = (value: string) => createHash("sha256").update(value).digest();

function authorize(req: Request, token: string, now: number) {
  const address = clientAddress(req.headers) || "unknown";
  if (failures(address, now).length >= FAIL_MAX) {
    securityEvent("admin_api.refused", { headers: req.headers, detail: "limit" });
    throw new HttpError(429, "Zu viele ungültige Anfragen. Bitte in 15 Minuten erneut versuchen.");
  }
  if (!allow(`admin-api-ip:${address}`, 600, 60_000, now)) throw new HttpError(429, "Zu viele Anfragen in kurzer Zeit. Bitte später erneut versuchen.");
  const header = req.headers.get("authorization") || "";
  const given = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  // Hashes of equal length: the comparison takes the same time whatever was sent.
  const matches = !!given && timingSafeEqual(digest(given), digest(token));
  if (!matches) {
    failures(address, now).push(now);
    securityEvent("admin_api.refused", { headers: req.headers, detail: given ? "wrong token" : "no token" });
    throw new HttpError(401, "Ungültiges Token.");
  }
  if (!allow("admin-api", 1200, 60_000, now)) throw new HttpError(429, "Zu viele Anfragen in kurzer Zeit. Bitte später erneut versuchen.");
}

type Row = { id: string; email: string; name: string; created_at: string | null };
const ACCOUNT = "SELECT id,email,name,created_at FROM users WHERE demo_until IS NULL AND subject NOT LIKE 'deleted:%'";
const iso = (value: string | null) => {
  if (!value) return null;
  const date = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(" ", "T")}Z` : value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
};
export async function adminApiUser(row: Row) {
  const stored = await storedUserLimits(row.id);
  const effective = await effectiveUserLimits(row.id);
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    createdAt: iso(row.created_at),
    limits: Object.fromEntries(LIMIT_KEYS.map((k) => [k, stored[k] ?? null])),
    effective: Object.fromEntries(LIMIT_KEYS.map((k) => [k, effective[k]])),
    usage: { usedBytes: await accountedBytes(row.id), ownedWorkspaces: await ownedWorkspaces(row.id), aiTokensThisMonth: await aiTokensThisMonth(row.id) },
  };
}
const userRow = async (id: string) => {
  const row = z.uuid().safeParse(id).success ? await one<Row>(`${ACCOUNT} AND id=?`, id) : undefined;
  if (!row) throw new HttpError(404, "Benutzer nicht gefunden.");
  return row;
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

export async function adminApi(req: Request, now = Date.now()): Promise<Response> {
  const token = adminApiToken();
  if (!token) return json({ error: "Not found" }, 404);
  try {
    if (await blockedRequest(req.headers, now)) throw new HttpError(403, "Zugriff verweigert.");
    authorize(req, token, now);
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/admin-api\/?/, "").split("/").filter(Boolean);
    if (path[0] !== "users" || path.length > 3) throw new HttpError(404, "Nicht gefunden.");
    if (path.length === 1) {
      if (req.method !== "GET") throw new HttpError(405, "Methode nicht erlaubt.");
      const email = z.string().trim().min(3).max(320).parse(url.searchParams.get("email") ?? "");
      const users = [];
      for (const row of await all<Row>(`${ACCOUNT} AND lower(email)=lower(?) ORDER BY created_at,id`, email)) users.push(await adminApiUser(row));
      return json({ users });
    }
    if (path.length === 2) {
      if (req.method !== "GET") throw new HttpError(405, "Methode nicht erlaubt.");
      return json(await adminApiUser(await userRow(path[1])));
    }
    if (path[2] !== "limits") throw new HttpError(404, "Nicht gefunden.");
    if (req.method !== "PUT") throw new HttpError(405, "Methode nicht erlaubt.");
    const row = await userRow(path[1]);
    let body: unknown;
    try {
      body = JSON.parse((await readTextLimited(req, 16_384)) || "{}");
    } catch {
      throw new HttpError(400, "Ungültige Eingabe.");
    }
    const input = limitsInput.parse(body);
    const before = await storedUserLimits(row.id);
    const next = { ...before };
    for (const key of LIMIT_KEYS)
      if (key in input) {
        if (input[key] === null) delete next[key];
        else (next as Record<string, unknown>)[key] = input[key];
      }
    const changed = LIMIT_KEYS.some((k) => (before[k] ?? null) !== (next[k] ?? null));
    if (changed) {
      await setUserLimits(row.id, next);
      await audit(ADMIN_API_ACTOR, "admin.userLimits", row.id, JSON.stringify(Object.fromEntries(LIMIT_KEYS.map((k) => [k, next[k] ?? null]))));
    }
    return json(await adminApiUser(row));
  } catch (e) {
    if (e instanceof z.ZodError) return json({ error: "Ungültige Eingabe.", details: e.issues.map((i) => i.message) }, 400);
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error("Admin API", e);
    return json({ error: "Die Anfrage konnte nicht verarbeitet werden." }, 500);
  }
}
