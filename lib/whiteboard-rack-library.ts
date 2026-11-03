// The device library for racks (#90): typical devices with their height,
// ports, power draw and weight, and plain racks. Each workspace can add its
// own devices (lib/whiteboard-rack-server.ts). Values are typical figures,
// meant as a starting point; every device can be edited on the board.
import { RACK_U, addPorts, deviceKindNames, innerWidth, rackSize, type DeviceData, type DeviceKind, type Face, type PortType, type RackData, type RackPort } from "./whiteboard-rack";
import type { WhiteboardItem } from "./whiteboard-model";

type T = (de: string, en: string) => string;
export { deviceKindNames };
type PortSpec = { count: number; type: PortType; face: Face; prefix: string; start?: number };
// A run of ports: how many, which type, which side, their name prefix.
const p = (count: number, type: PortType, face: Face, prefix: string, start?: number): PortSpec => ({ count, type, face, prefix, start });
export type DeviceTemplate = {
  key: string;
  name: [string, string];
  kind: DeviceKind;
  height: number;
  mount?: DeviceData["mount"];
  depth?: DeviceData["depth"];
  powerW?: number;
  weightKg?: number;
  maxPowerW?: number;
  ports: PortSpec[];
  keywords?: string;
};
const psu = (n = 2, type: PortType = "c14"): PortSpec => p(n, type, "rear", "PSU");
// i18n-table: 1 – device names of the library
export const deviceTemplates: DeviceTemplate[] = [
  { key: "server-1u", name: ["Server 1 HE", "Server 1U"], kind: "server", height: 1, powerW: 350, weightKg: 16, ports: [p(2, "rj45", "rear", "eth"), p(2, "sfp+", "rear", "sfp"), p(1, "rj45", "rear", "BMC"), psu()], keywords: "server rechner host" },
  { key: "server-2u", name: ["Server 2 HE", "Server 2U"], kind: "server", height: 2, powerW: 500, weightKg: 26, ports: [p(4, "rj45", "rear", "eth"), p(2, "sfp28", "rear", "sfp"), p(1, "rj45", "rear", "BMC"), psu()], keywords: "server rechner host" },
  { key: "server-4u", name: ["Server 4 HE", "Server 4U"], kind: "server", height: 4, powerW: 900, weightKg: 40, ports: [p(4, "rj45", "rear", "eth"), p(2, "qsfp28", "rear", "qsfp"), p(1, "rj45", "rear", "BMC"), psu(2, "c20")], keywords: "server gpu storage host" },
  { key: "switch-24", name: ["Switch 24 Ports", "Switch 24 ports"], kind: "switch", height: 1, powerW: 45, weightKg: 4, ports: [p(24, "rj45", "front", ""), p(4, "sfp+", "front", "SFP"), p(1, "console", "front", "CON"), psu(1)], keywords: "switch netzwerk network ethernet" },
  { key: "switch-48", name: ["Switch 48 Ports", "Switch 48 ports"], kind: "switch", height: 1, powerW: 80, weightKg: 6, ports: [p(48, "rj45", "front", ""), p(4, "sfp+", "front", "SFP"), p(1, "console", "front", "CON"), psu(2)], keywords: "switch netzwerk network ethernet" },
  { key: "switch-sfp", name: ["Switch 24 × SFP+", "Switch 24 × SFP+"], kind: "switch", height: 1, powerW: 120, weightKg: 7, ports: [p(24, "sfp+", "front", ""), p(4, "qsfp28", "front", "Q"), p(1, "console", "front", "CON"), psu(2)], keywords: "switch glasfaser fibre fiber core aggregation" },
  { key: "patch-24", name: ["Patchfeld 24 Ports", "Patch panel 24 ports"], kind: "patch", height: 1, weightKg: 1.5, ports: [p(24, "rj45", "front", ""), p(24, "rj45", "rear", "R")], keywords: "patchpanel patchfeld kupfer copper" },
  { key: "patch-48", name: ["Patchfeld 48 Ports", "Patch panel 48 ports"], kind: "patch", height: 2, weightKg: 2.5, ports: [p(48, "rj45", "front", ""), p(48, "rj45", "rear", "R")], keywords: "patchpanel patchfeld kupfer copper" },
  { key: "patch-fibre", name: ["LWL-Patchfeld 24 LC", "Fibre panel 24 LC"], kind: "patch", height: 1, weightKg: 2, ports: [p(24, "lc", "front", ""), p(24, "lc", "rear", "R")], keywords: "glasfaser lwl fibre fiber patchpanel" },
  { key: "router", name: ["Router", "Router"], kind: "router", height: 1, powerW: 60, weightKg: 5, ports: [p(4, "rj45", "front", "Gi"), p(2, "sfp+", "front", "Te"), p(1, "console", "front", "CON"), psu(1)], keywords: "router wan internet gateway" },
  { key: "firewall", name: ["Firewall", "Firewall"], kind: "firewall", height: 1, powerW: 90, weightKg: 6, ports: [p(8, "rj45", "front", "port"), p(2, "sfp+", "front", "x"), p(1, "console", "front", "CON"), psu()], keywords: "firewall sicherheit security utm" },
  { key: "storage-2u", name: ["Storage/NAS 2 HE", "Storage/NAS 2U"], kind: "storage", height: 2, powerW: 250, weightKg: 22, ports: [p(4, "rj45", "rear", "eth"), p(2, "sfp+", "rear", "sfp"), psu()], keywords: "nas san storage speicher" },
  { key: "ups-2u", name: ["USV 2 HE", "UPS 2U"], kind: "ups", height: 2, powerW: 60, weightKg: 32, maxPowerW: 2700, ports: [p(1, "c20", "rear", "IN"), p(8, "c13", "rear", "OUT"), p(1, "rj45", "rear", "NET")], keywords: "usv ups unterbrechungsfreie strom power batterie" },
  { key: "pdu-1u", name: ["PDU 1 HE (8 × C13)", "PDU 1U (8 × C13)"], kind: "pdu", height: 1, weightKg: 3, maxPowerW: 3680, ports: [p(1, "c20", "rear", "IN"), p(8, "c13", "rear", "")], keywords: "pdu steckdosenleiste strom power" },
  { key: "pdu-0u", name: ["PDU senkrecht (0 HE)", "Vertical PDU (0U)"], kind: "pdu", height: 20, mount: "right", weightKg: 5, maxPowerW: 7400, ports: [p(18, "c13", "rear", ""), p(6, "c19", "rear", "C19-")], keywords: "pdu 0u 0he senkrecht vertical zero strom power" },
  { key: "blank-1u", name: ["Blindplatte 1 HE", "Blanking panel 1U"], kind: "blank", height: 1, weightKg: 0.3, ports: [], keywords: "blind blank abdeckung" },
  { key: "blank-2u", name: ["Blindplatte 2 HE", "Blanking panel 2U"], kind: "blank", height: 2, weightKg: 0.5, ports: [], keywords: "blind blank abdeckung" },
  { key: "cable-1u", name: ["Kabelführung 1 HE", "Cable manager 1U"], kind: "cable", height: 1, weightKg: 1, ports: [], keywords: "kabel cable management führung" },
  { key: "shelf-1u", name: ["Fachboden 1 HE", "Shelf 1U"], kind: "shelf", height: 1, weightKg: 3, ports: [], keywords: "fachboden shelf ablage" },
  { key: "shelf-2u", name: ["Fachboden 2 HE", "Shelf 2U"], kind: "shelf", height: 2, weightKg: 4, ports: [], keywords: "fachboden shelf ablage" },
];
export const libraryGroups: [string, [string, string], DeviceKind[]][] = [
  ["compute", ["Server und Speicher", "Servers and storage"], ["server", "storage"]],
  ["network", ["Netzwerk", "Network"], ["switch", "router", "firewall", "patch"]],
  ["power", ["Strom", "Power"], ["ups", "pdu"]],
  ["passive", ["Zubehör", "Accessories"], ["blank", "cable", "shelf", "other"]],
];
export function templatePorts(specs: PortSpec[]): RackPort[] {
  let ports: RackPort[] = [];
  for (const { count, type, face, prefix, start } of specs) ports = addPorts(ports, count, type, face, prefix, start ?? 1);
  return ports;
}
export function templateDevice(template: DeviceTemplate): DeviceData {
  const d: DeviceData = { kind: template.kind, height: template.height, ports: templatePorts(template.ports) };
  if (template.mount) d.mount = template.mount;
  if (template.depth) d.depth = template.depth;
  if (template.powerW !== undefined) d.powerW = template.powerW;
  if (template.weightKg !== undefined) d.weightKg = template.weightKg;
  if (template.maxPowerW !== undefined) d.maxPowerW = template.maxPowerW;
  return d;
}
// A new device element from a device (library or own template).
export function deviceItem(device: DeviceData, name: string, at: { x: number; y: number }, fill?: string): Omit<WhiteboardItem, "id" | "z"> {
  return {
    type: "device",
    x: Math.round(at.x),
    y: Math.round(at.y),
    w: innerWidth(19),
    h: device.height * RACK_U,
    text: name,
    device: { ...device, ports: device.ports.map((p) => ({ ...p })) },
    ...(fill ? { fill } : {}),
  };
}
export const rackPresets = [42, 24, 12] as const;
export function rackItem(units: number, t: T, at: { x: number; y: number }): Omit<WhiteboardItem, "id" | "z"> {
  const rack: RackData = { u: units, width: 19, face: "front" };
  return { type: "rack", x: Math.round(at.x), y: Math.round(at.y), ...rackSize(rack), text: units <= 12 ? t("Wandschrank", "Wall cabinet") : `Rack ${units}U`, rack };
}
export function searchTemplates(query: string, t: T) {
  const q = query.trim().toLowerCase();
  if (!q) return deviceTemplates;
  return deviceTemplates.filter((d) => `${t(...d.name)} ${d.name.join(" ")} ${d.keywords || ""}`.toLowerCase().includes(q));
}
