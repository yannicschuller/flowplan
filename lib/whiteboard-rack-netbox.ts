// NetBox → racks on a whiteboard (#90). The server fetches sites, racks,
// devices, their interfaces, ports and cables from the NetBox REST API
// (lib/whiteboard-rack-server.ts); this maps the answers to the JSON format
// of the rack export (lib/whiteboard-rack.ts racksJson), which the board
// then checks and places like an imported file. Pure, so it can be tested.
import { MAX_IPS, MAX_ROLES, RACK_JSON_FORMAT, cableTypes, cleanIp, cleanRoles, deviceKinds, nicPort, normalizeMac, type CableType, type DeviceKind, type Face, type PortType } from "./whiteboard-rack";

type Ref = { id?: number; name?: string; slug?: string; value?: string; label?: string; display?: string } | null | undefined;
export type NetboxRack = { id: number; name?: string; display?: string; site?: Ref; location?: Ref; u_height?: number; width?: Ref; max_weight?: number | null; weight_unit?: Ref };
export type NetboxDeviceType = { id: number; model?: string; manufacturer?: Ref; u_height?: number; is_full_depth?: boolean; weight?: number | null; weight_unit?: Ref };
export type NetboxDevice = {
  id: number;
  name?: string | null;
  display?: string;
  device_type?: NetboxDeviceType | Ref;
  role?: Ref;
  device_role?: Ref;
  rack?: Ref;
  position?: number | null;
  face?: Ref;
  serial?: string;
  asset_tag?: string | null;
  comments?: string;
  // Host name and addresses (#187): NetBox has no host name field, so the
  // primary IP's DNS name stands for it.
  primary_ip?: NetboxIpRef;
  primary_ip4?: NetboxIpRef;
  primary_ip6?: NetboxIpRef;
  oob_ip?: NetboxIpRef;
  tags?: { name?: string; slug?: string; display?: string }[] | null;
};
type NetboxIpRef = { id?: number; address?: string; dns_name?: string; display?: string } | null | undefined;
// An IP address assigned to an interface (ipam/ip-addresses).
export type NetboxIpAddress = { id: number; address?: string; dns_name?: string; assigned_object_type?: string | null; assigned_object_id?: number | null; status?: Ref };
export type NetboxPort = {
  id: number;
  device?: Ref;
  name?: string;
  label?: string;
  type?: Ref;
  untagged_vlan?: { vid?: number; name?: string } | null;
  maximum_draw?: number | null;
  allocated_draw?: number | null;
  mgmt_only?: boolean;
  // MAC of an interface: NetBox up to 4.1 has mac_address, 4.2 and later
  // primary_mac_address (and mac_address as a read-only copy).
  mac_address?: string | null;
  primary_mac_address?: { mac_address?: string } | null;
};
export type NetboxTermination = { object_type?: string; termination_type?: string; object_id?: number; termination_id?: number; object?: { id?: number; device?: Ref } };
export type NetboxCable = {
  id: number;
  label?: string;
  type?: string | Ref;
  color?: string;
  length?: number | null;
  length_unit?: Ref;
  description?: string;
  a_terminations?: NetboxTermination[];
  b_terminations?: NetboxTermination[];
};
export type NetboxData = {
  racks: NetboxRack[];
  devices: NetboxDevice[];
  deviceTypes: NetboxDeviceType[];
  interfaces: NetboxPort[];
  frontPorts: NetboxPort[];
  rearPorts: NetboxPort[];
  consolePorts: NetboxPort[];
  powerPorts: NetboxPort[];
  powerOutlets: NetboxPort[];
  cables: NetboxCable[];
  ipAddresses?: NetboxIpAddress[];
};
// Kinds of ports, as NetBox's API names them in cable terminations.
export const NETBOX_PORT_OBJECTS = {
  interfaces: "dcim.interface",
  frontPorts: "dcim.frontport",
  rearPorts: "dcim.rearport",
  consolePorts: "dcim.consoleport",
  powerPorts: "dcim.powerport",
  powerOutlets: "dcim.poweroutlet",
} as const;
type PortSource = keyof typeof NETBOX_PORT_OBJECTS;

const value = (ref: Ref | string | undefined) => (typeof ref === "string" ? ref : ref?.value || ref?.slug || ref?.name || "").toLowerCase();
const text = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
export function netboxPortType(source: PortSource, type: string): PortType | null {
  const t = type.toLowerCase();
  if (source === "powerPorts" || source === "powerOutlets") {
    for (const c of ["c13", "c14", "c19", "c20"] as const) if (t.includes(c)) return c;
    if (/schuko|cee-7/.test(t)) return "schuko";
    if (/dc|-48v/.test(t)) return "dc";
    return source === "powerPorts" ? "c14" : "c13";
  }
  if (source === "consolePorts") return /usb/.test(t) ? "usb" : "console";
  if (source === "frontPorts" || source === "rearPorts") return /mpo|mtp/.test(t) ? "mpo" : /^lc|-lc/.test(t) ? "lc" : /^sc|-sc/.test(t) ? "sc" : "rj45";
  if (/^(virtual|lag|bridge)$|wireless|ieee802\.11|cellular|lte/.test(t)) return null;
  if (/qsfp28|qsfp-dd|osfp|100gbase/.test(t)) return "qsfp28";
  if (/qsfpp|qsfp|40gbase/.test(t)) return "qsfp+";
  if (/sfp28|25gbase/.test(t)) return "sfp28";
  if (/sfpp|sfp\+|10gbase-x/.test(t)) return "sfp+";
  if (/sfp|1000base-x/.test(t)) return "sfp";
  return "rj45";
}
export function netboxCableType(type: string): CableType {
  const t = type.toLowerCase();
  if ((cableTypes as readonly string[]).includes(t)) return t as CableType;
  if (/om3/.test(t)) return "om3";
  if (/om4/.test(t)) return "om4";
  if (/om5/.test(t)) return "om5";
  if (/smf|os1|os2/.test(t)) return "os2";
  if (/mmf/.test(t)) return "om4";
  if (/dac/.test(t)) return "dac";
  if (/aoc/.test(t)) return "aoc";
  if (/power/.test(t)) return "power";
  if (/cat5/.test(t)) return "cat5e";
  return "other";
}
export function netboxKind(role: string): DeviceKind {
  const r = role.toLowerCase();
  const found: [RegExp, DeviceKind][] = [
    [/patch/, "patch"],
    [/firewall|fw\b|utm/, "firewall"],
    [/router|gateway|wan/, "router"],
    [/switch|access|core|leaf|spine|aggregation|tor\b/, "switch"],
    [/pdu/, "pdu"],
    [/ups|usv/, "ups"],
    [/storage|nas|san|backup/, "storage"],
    [/blank/, "blank"],
    [/shelf/, "shelf"],
    [/server|host|hypervisor|compute|node|esx|proxmox/, "server"],
  ];
  return found.find(([re]) => re.test(r))?.[1] ?? (deviceKinds.includes(r as DeviceKind) ? (r as DeviceKind) : "other");
}
const toKg = (weight: number | null | undefined, unit: Ref) => {
  if (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0) return undefined;
  const u = value(unit);
  const kg = u === "g" ? weight / 1000 : u === "lb" ? weight * 0.4536 : u === "oz" ? weight * 0.02835 : weight;
  return Math.round(kg * 10) / 10;
};
const toMetres = (length: number | null | undefined, unit: Ref) => {
  if (typeof length !== "number" || !Number.isFinite(length) || length < 0) return undefined;
  const u = value(unit);
  const m = u === "cm" ? length / 100 : u === "km" ? length * 1000 : u === "ft" ? length * 0.3048 : u === "in" ? length * 0.0254 : length;
  return Math.round(m * 100) / 100;
};
// The default side of a device's ports: servers are cabled at the back,
// network gear at the front; power at the back.
function portFace(kind: DeviceKind, source: PortSource): Face {
  if (source === "frontPorts") return "front";
  if (source === "rearPorts" || source === "powerPorts" || source === "powerOutlets") return "rear";
  return ["switch", "router", "firewall", "patch"].includes(kind) ? "front" : "rear";
}

// The addresses of a device: primary IPv4 and IPv6 first, then the
// out-of-band (BMC) address.
export function netboxIps(d: NetboxDevice) {
  const out: string[] = [];
  for (const ref of [d.primary_ip4, d.primary_ip6, d.primary_ip, d.oob_ip]) {
    const ip = cleanIp(ref?.address);
    if (ip && !out.includes(ip)) out.push(ip);
  }
  return out.slice(0, MAX_IPS);
}
const portMac = (port: NetboxPort) => normalizeMac(port.primary_mac_address?.mac_address) || normalizeMac(port.mac_address);
// The device's role and its tags become its roles.
export function netboxRoles(d: NetboxDevice) {
  const role = d.role || d.device_role;
  const names = [text(role?.name || role?.display, 40), ...(d.tags || []).map((tag) => text(tag?.name || tag?.display, 40))];
  return cleanRoles(names.filter(Boolean))?.slice(0, MAX_ROLES);
}
export function netboxToRacks(data: NetboxData) {
  const types = new Map(data.deviceTypes.map((t) => [t.id, t]));
  // Interface → its first IP address (ipam, when the token may read it).
  const interfaceIps = new Map<number, string>();
  for (const a of data.ipAddresses || []) {
    const ip = cleanIp(a.address);
    if (ip && a.assigned_object_type === "dcim.interface" && typeof a.assigned_object_id === "number" && !interfaceIps.has(a.assigned_object_id)) interfaceIps.set(a.assigned_object_id, ip);
  }
  const racks = data.racks.slice(0, 50).map((r) => {
    const width = Number(value(r.width)) || 19;
    return {
      id: `nb-rack-${r.id}`,
      name: text(r.name || r.display) || `Rack ${r.id}`,
      u: Math.max(1, Math.min(60, Math.round(Number(r.u_height) || 42))),
      width: width <= 10 ? 10 : width >= 21 ? 23 : 19,
      location: [text(r.site?.name), text(r.location?.name)].filter(Boolean).join(" · ") || undefined,
      face: "front",
      ...(toKg(r.max_weight, r.weight_unit) ? { maxWeightKg: toKg(r.max_weight, r.weight_unit) } : {}),
    };
  });
  const rackIds = new Set(data.racks.map((r) => r.id));
  const portsBy = new Map<number, { source: PortSource; port: NetboxPort }[]>();
  for (const source of Object.keys(NETBOX_PORT_OBJECTS) as PortSource[])
    for (const port of data[source]) {
      const device = port.device?.id;
      if (typeof device === "number") portsBy.set(device, [...(portsBy.get(device) || []), { source, port }]);
    }
  // NetBox port → our port id, per device.
  const portIds = new Map<string, { device: string; port: string }>();
  const devices = data.devices.slice(0, 2000).map((d) => {
    const typeRef = (d.device_type || {}) as NetboxDeviceType;
    const type = types.get(typeRef.id) || typeRef;
    const kind = netboxKind(value(d.role || d.device_role) || text(d.role?.name || d.device_role?.name));
    const height = Math.max(1, Math.min(60, Math.ceil(Number(type.u_height) || 1)));
    const racked = typeof d.position === "number" && d.rack?.id && rackIds.has(d.rack.id);
    const face = value(d.face) === "rear" ? "rear" : "front";
    const id = `nb-dev-${d.id}`;
    let powerW = 0;
    const ports = (portsBy.get(d.id) || []).flatMap(({ source, port }, i) => {
      const portType = netboxPortType(source, value(port.type));
      if (!portType) return [];
      if (source === "powerPorts") powerW += Number(port.allocated_draw || port.maximum_draw || 0) || 0;
      const portId = `p${i + 1}`;
      portIds.set(`${NETBOX_PORT_OBJECTS[source]}:${port.id}`, { device: id, port: portId });
      const nic = source === "interfaces" && nicPort(portType);
      const mac = nic ? portMac(port) : null;
      const ip = nic ? interfaceIps.get(port.id) : undefined;
      return [
        {
          id: portId,
          name: text(port.name, 40) || portId,
          type: portType,
          face: portFace(kind, source),
          ...(text(port.label, 80) ? { label: text(port.label, 80) } : {}),
          ...(port.untagged_vlan?.vid ? { vlan: String(port.untagged_vlan.vid) } : {}),
          ...(mac ? { mac } : {}),
          ...(ip ? { ip } : {}),
        },
      ];
    });
    // The device's MAC: that of the interface holding its primary IP, else
    // of the first interface with a MAC that is not for management only.
    const own = (portsBy.get(d.id) || []).filter((p) => p.source === "interfaces" && portMac(p.port));
    const primaryIds = new Set((data.ipAddresses || []).filter((a) => [d.primary_ip4?.id, d.primary_ip6?.id, d.primary_ip?.id].includes(a.id)).map((a) => a.assigned_object_id));
    const main = own.find((p) => primaryIds.has(p.port.id)) || own.find((p) => !p.port.mgmt_only) || own[0];
    const mac = main ? portMac(main.port) : null;
    const ips = netboxIps(d);
    const roles = netboxRoles(d);
    const hostname = text(d.primary_ip4?.dns_name || d.primary_ip6?.dns_name || d.primary_ip?.dns_name, 253);
    return {
      id,
      name: text(d.name || d.display) || text(type.model) || `#${d.id}`,
      ...(racked ? { rack: `nb-rack-${d.rack!.id}`, u: Math.max(1, Math.floor(d.position!)) } : {}),
      kind,
      height,
      ...(hostname ? { hostname } : {}),
      ...(ips.length ? { ips } : {}),
      ...(mac ? { mac } : {}),
      ...(roles ? { roles } : {}),
      ...(type.is_full_depth === false ? { depth: face } : {}),
      ...(text(type.manufacturer?.name) ? { manufacturer: text(type.manufacturer?.name, 80) } : {}),
      ...(text(type.model) ? { model: text(type.model, 80) } : {}),
      ...(text(d.serial) ? { serial: text(d.serial, 80) } : {}),
      ...(powerW ? { powerW } : {}),
      ...(toKg(type.weight, type.weight_unit) ? { weightKg: toKg(type.weight, type.weight_unit) } : {}),
      ...(text(d.comments) ? { notes: text(d.comments, 4000) } : {}),
      ports: ports.slice(0, 200),
    };
  });
  const end = (list: NetboxTermination[] | undefined) => {
    const t = list?.[0];
    if (!t) return null;
    const kind = t.object_type || t.termination_type || "";
    const objectId = t.object_id ?? t.termination_id ?? t.object?.id;
    return portIds.get(`${kind}:${objectId}`) || null;
  };
  const cables = data.cables.slice(0, 20000).flatMap((c) => {
    const a = end(c.a_terminations),
      b = end(c.b_terminations);
    if (!a || !b) return [];
    const color = /^[0-9a-f]{6}$/i.test(c.color || "") ? `#${c.color!.toLowerCase()}` : undefined;
    return [
      {
        id: `nb-cable-${c.id}`,
        a,
        b,
        type: netboxCableType(value(c.type as Ref | string)),
        ...(color ? { color } : {}),
        ...(toMetres(c.length, c.length_unit) !== undefined ? { length: toMetres(c.length, c.length_unit) } : {}),
        ...(text(c.label, 80) ? { label: text(c.label, 80) } : {}),
        ...(text(c.description) ? { notes: text(c.description, 2000) } : {}),
      },
    ];
  });
  return { format: RACK_JSON_FORMAT, version: 1, racks, devices, cables };
}
