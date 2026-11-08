"use client";
// The symbol of a node type (the catalogue names Phosphor icons).
import {
  ArrowBendDownRight,
  ArrowsOutCardinal,
  At,
  Bell,
  CalendarCheck,
  ChatCircle,
  CheckCircle,
  ClipboardText,
  Clock,
  Equals,
  FilePlus,
  GitFork,
  ListPlus,
  MagnifyingGlass,
  NotePencil,
  PencilLine,
  PencilSimple,
  Play,
  PlusCircle,
  Rows,
  Stamp,
  StopCircle,
  Tag,
  Circle,
  type Icon,
} from "@phosphor-icons/react";
import { nodeSpec } from "@/lib/workflows/catalog";

const ICONS: Record<string, Icon> = {
  ArrowBendDownRight,
  ArrowsOutCardinal,
  At,
  Bell,
  CalendarCheck,
  ChatCircle,
  CheckCircle,
  ClipboardText,
  Clock,
  Equals,
  FilePlus,
  GitFork,
  ListPlus,
  MagnifyingGlass,
  NotePencil,
  PencilLine,
  PencilSimple,
  Play,
  PlusCircle,
  Rows,
  Stamp,
  StopCircle,
  Tag,
};

export function NodeIcon({ type, size = 18 }: { type: string; size?: number }) {
  const C = ICONS[nodeSpec(type)?.icon || ""] || Circle;
  return <C size={size} className={`wf-icon wf-cat-${nodeSpec(type)?.category || "logic"}`} aria-hidden />;
}
