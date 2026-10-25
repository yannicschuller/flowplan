// The look of the start page's header (components/home).
import type { CSSProperties } from "react";
import type { HomeAppearance } from "@/lib/home-layout-schema";

// Header gradients (lib/home-layout-schema.ts headerGradients).
export const GRADIENTS: Record<string, string> = {
  dawn: "linear-gradient(135deg, #f6d5c3 0%, #e9c6e6 55%, #c9d4f4 100%)",
  ocean: "linear-gradient(135deg, #bfe3f0 0%, #9cc3e8 50%, #7f9ee0 100%)",
  forest: "linear-gradient(135deg, #d7ebd2 0%, #a6cfae 50%, #6fa38d 100%)",
  dusk: "linear-gradient(135deg, #3b3f8f 0%, #7a4f9a 55%, #d07a8a 100%)",
  sand: "linear-gradient(135deg, #f5ead7 0%, #ead2b0 55%, #d9b48a 100%)",
  slate: "linear-gradient(135deg, #2d3340 0%, #4a5468 55%, #6e7a92 100%)",
};
export function headerStyle(header: HomeAppearance["header"]): CSSProperties | null {
  if (header.type === "color") return { background: header.value };
  if (header.type === "gradient") return { background: GRADIENTS[header.value] };
  if (header.type === "image") return { backgroundImage: `url("${header.value}")`, backgroundSize: "cover", backgroundPosition: `50% ${header.position}%` };
  return null;
}

