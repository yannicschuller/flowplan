// Server side of rack planning on whiteboards (#90):
// - own device templates of a workspace (schema 86 in lib/db.ts), next to
//   the built-in device library (lib/whiteboard-rack-library.ts);
// - the NetBox import: the address and token a person enters are used for
//   this one request through the SSRF-safe fetch (lib/safe-fetch.ts) and
//   are neither stored nor logged. NETBOX_ALLOW_PRIVATE=true lets an
//   administrator allow NetBox on internal addresses and plain http.
import { z } from "zod";
import { all, audit, id, one, run } from "./db";
import { HttpError } from "./auth";
import { isGuest, requireMember, requirePage } from "./permissions";
import { safeFetch } from "./safe-fetch";
import { cleanDevice } from "./whiteboard-rack";
import { netboxToRacks, type NetboxData } from "./whiteboard-rack-netbox";
import type { Identity } from "./types";

function boardPage(user: Identity, pageId: unknown, write = false) {
  const page = requirePage(user, z.uuid().parse(pageId), write);
  if (page.kind !== "whiteboard") throw new HttpError(400, "Kein Whiteboard.");
  return page;
}

// ---- own device templates ----

type Row = { id: string; workspace_id: string; name: string; device: string; fill: string | null; created_by: string | null; created_at: number };
export function listRackTemplates(user: Identity, pageId: unknown) {
  const page = boardPage(user, pageId);
  const role = requireMember(user, page.workspace_id);
  // Guests see only their own, like whiteboard templates.
  const guest = isGuest(user, page.workspace_id);
  return all<Row>(
    "SELECT * FROM rack_device_templates WHERE workspace_id=? AND (?=0 OR created_by=?) ORDER BY name COLLATE NOCASE",
    page.workspace_id,
    guest ? 1 : 0,
    user.id,
  ).flatMap((row) => {
    let device;
    try {
      device = cleanDevice(JSON.parse(row.device));
    } catch {
      device = null;
    }
    if (!device) return [];
    return [{ id: row.id, name: row.name, device, fill: row.fill || undefined, canDelete: row.created_by === user.id || role === "owner" }];
  });
}
const saveInput = z.object({
  name: z.string().trim().min(1).max(120),
  device: z.unknown(),
  fill: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .optional(),
});
export function saveRackTemplate(user: Identity, pageId: unknown, raw: unknown) {
  const page = boardPage(user, pageId, true);
  requireMember(user, page.workspace_id, "editor");
  const input = saveInput.parse(raw);
  const device = cleanDevice(input.device);
  if (!device) throw new HttpError(400, "Ungültiges Gerät.");
  if ((one<{ n: number }>("SELECT COUNT(*) n FROM rack_device_templates WHERE workspace_id=?", page.workspace_id)?.n || 0) >= 500)
    throw new HttpError(409, "Dieser Arbeitsbereich hat schon 500 eigene Geräte.");
  const templateId = id();
  run(
    "INSERT INTO rack_device_templates(id,workspace_id,name,device,fill,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
    templateId,
    page.workspace_id,
    input.name,
    JSON.stringify(device),
    input.fill || null,
    user.id,
    Date.now(),
  );
  return { id: templateId };
}
export function deleteRackTemplate(user: Identity, pageId: unknown, templateId: unknown) {
  const page = boardPage(user, pageId);
  const role = requireMember(user, page.workspace_id, "editor");
  const row = one<Row>("SELECT * FROM rack_device_templates WHERE id=? AND workspace_id=?", z.uuid().parse(templateId), page.workspace_id);
  if (!row) throw new HttpError(404, "Vorlage fehlt.");
  if (row.created_by !== user.id && role !== "owner")
    throw new HttpError(403, "Nur der Ersteller oder ein Besitzer darf die Vorlage verwalten.");
  run("DELETE FROM rack_device_templates WHERE id=?", row.id);
  return { ok: true };
}

// ---- NetBox ----

const netboxInput = z.object({
  url: z.string().trim().min(8).max(500),
  token: z.string().trim().min(8).max(300),
  // Slug of a site (optional) and names of racks (optional, comma-separated).
  site: z.string().trim().max(100).optional(),
  racks: z.string().trim().max(1000).optional(),
});
const MAX_RACKS = 20;
type Page<T> = { results?: T[]; next?: string | null };
export type NetboxFetch = (url: string, headers: Record<string, string>) => Promise<{ status: number; body: string }>;
const defaultFetch: NetboxFetch = async (url, headers) => {
  const allowPrivate = process.env.NETBOX_ALLOW_PRIVATE === "true";
  const result = await safeFetch(url, { headers, accept: "application/json", allowPrivate, maxBytes: 15_000_000, timeout: 20_000 });
  return { status: result.status, body: result.body };
};
// The NetBox API's base address from what a person entered.
export function netboxBase(raw: string) {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new HttpError(400, "Ungültige NetBox-Adresse.");
  }
  if (url.username || url.password) throw new HttpError(400, "Ungültige NetBox-Adresse.");
  const path = url.pathname.replace(/\/+$/, "").replace(/\/api$/, "");
  return `${url.origin}${path}/api`;
}
export async function fetchNetbox(raw: unknown, fetcher: NetboxFetch = defaultFetch): Promise<NetboxData> {
  const input = netboxInput.parse(raw);
  const base = netboxBase(input.url);
  // NetBox 4.5 tokens ("nbt_…") are bearer tokens, older ones "Token …".
  const headers = { Authorization: input.token.startsWith("nbt_") ? `Bearer ${input.token}` : `Token ${input.token}`, Accept: "application/json" };
  const list = async <T>(path: string, params: [string, string][]): Promise<T[]> => {
    const query = new URLSearchParams([...params, ["limit", "1000"]]);
    let next: string | null = `${base}/${path}/?${query}`;
    const out: T[] = [];
    for (let pageNo = 0; next && pageNo < 20; pageNo++) {
      // Follow-up pages only on the same server.
      if (!next.startsWith(`${new URL(base).origin}/`)) break;
      let answer;
      try {
        answer = await fetcher(next, headers);
      } catch (error) {
        // Refused addresses (internal, not https) say so; anything else is
        // NetBox not answering.
        if (error instanceof HttpError && error.status === 400) throw error;
        throw new HttpError(502, "NetBox ist nicht erreichbar.");
      }
      if (answer.status === 401 || answer.status === 403) throw new HttpError(400, "NetBox hat den Token abgelehnt.");
      if (answer.status === 404) throw new HttpError(400, "Unter dieser Adresse antwortet keine NetBox-API.");
      if (answer.status < 200 || answer.status >= 300) throw new HttpError(502, `NetBox antwortet mit Fehler ${answer.status}.`);
      let data: Page<T>;
      try {
        data = JSON.parse(answer.body);
      } catch {
        throw new HttpError(502, "Die Antwort von NetBox ist kein JSON.");
      }
      out.push(...(Array.isArray(data.results) ? data.results : []));
      next = typeof data.next === "string" ? data.next : null;
    }
    return out;
  };
  // Many ids per request, in batches.
  const byIds = async <T>(path: string, key: string, ids: number[]) => {
    const out: T[] = [];
    for (let i = 0; i < ids.length; i += 50) out.push(...(await list<T>(path, ids.slice(i, i + 50).map((n) => [key, String(n)]))));
    return out;
  };
  const rackParams: [string, string][] = [];
  if (input.site) rackParams.push(["site", input.site]);
  const names = (input.racks || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_RACKS);
  for (const name of names) rackParams.push(["name", name]);
  const racks = (await list<NetboxData["racks"][number]>("dcim/racks", rackParams)).slice(0, MAX_RACKS);
  if (!racks.length) throw new HttpError(404, "In NetBox wurden keine passenden Racks gefunden.");
  const devices = await byIds<NetboxData["devices"][number]>("dcim/devices", "rack_id", racks.map((r) => r.id));
  const deviceIds = devices.map((d) => d.id).slice(0, 2000);
  const typeIds = [...new Set(devices.map((d) => (d.device_type as { id?: number } | undefined)?.id).filter((n): n is number => typeof n === "number"))];
  const [deviceTypes, interfaces, frontPorts, rearPorts, consolePorts, powerPorts, powerOutlets, cables] = await Promise.all([
    byIds<NetboxData["deviceTypes"][number]>("dcim/device-types", "id", typeIds),
    byIds<NetboxData["interfaces"][number]>("dcim/interfaces", "device_id", deviceIds),
    byIds<NetboxData["frontPorts"][number]>("dcim/front-ports", "device_id", deviceIds),
    byIds<NetboxData["rearPorts"][number]>("dcim/rear-ports", "device_id", deviceIds),
    byIds<NetboxData["consolePorts"][number]>("dcim/console-ports", "device_id", deviceIds),
    byIds<NetboxData["powerPorts"][number]>("dcim/power-ports", "device_id", deviceIds),
    byIds<NetboxData["powerOutlets"][number]>("dcim/power-outlets", "device_id", deviceIds),
    byIds<NetboxData["cables"][number]>("dcim/cables", "device_id", deviceIds),
  ]);
  // A cable between two of the devices is listed for both of them.
  const unique = [...new Map(cables.map((c) => [c.id, c])).values()];
  return { racks, devices, deviceTypes, interfaces, frontPorts, rearPorts, consolePorts, powerPorts, powerOutlets, cables: unique };
}
export async function netboxImport(user: Identity, pageId: unknown, raw: unknown, fetcher?: NetboxFetch) {
  if (user.demo) throw new HttpError(403, "In der Demo nicht verfügbar. Registriere dich, um das zu nutzen.");
  const page = boardPage(user, pageId, true);
  if (page.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
  const data = await fetchNetbox(raw, fetcher);
  const result = netboxToRacks(data);
  audit(user.id, "whiteboard.netbox", page.id, `racks:${result.racks.length} devices:${result.devices.length} cables:${result.cables.length}`);
  return result;
}
