// Colours of the colour picker (components/ink/color-picker.tsx): "#rrggbb"
// and hue (0–360), saturation and value (0–1).
export type Hsv = { h: number; s: number; v: number };
const HEX = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i;

export function normalizeHex(value: string): string | null {
  const m = HEX.exec(value.trim());
  if (!m) return null;
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return `#${hex.toLowerCase()}`;
}
export function hexToHsv(hex: string): Hsv {
  const c = normalizeHex(hex) || "#000000";
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b),
    d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
}
export function hsvToHex({ h, s, v }: Hsv): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return "#" + [f(5), f(3), f(1)].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("");
}
