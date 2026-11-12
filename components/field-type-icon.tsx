"use client";
// One icon per property type in the table's column headers (#242), so
// columns are told apart at a glance; AI properties show a sparkle.
import {
  ArrowUpRight, At, CalendarBlank, CaretCircleDown, ChartPieSlice, CheckSquare, Clock, Function as FunctionIcon, Hash, LinkSimple,
  ListBullets, ListChecks, MagnifyingGlass, Paperclip, PersonSimpleRun, Phone, Quotes, Sparkle, TextT, Ticket, Timer, User, UserCircle,
  type Icon,
} from "@phosphor-icons/react";
import type { Field, FieldType } from "@/lib/types";

const ICONS: Record<FieldType, Icon> = {
  text: TextT,
  number: Hash,
  date: CalendarBlank,
  select: CaretCircleDown,
  multiselect: ListBullets,
  checkbox: CheckSquare,
  url: LinkSimple,
  email: At,
  phone: Phone,
  checklist: ListChecks,
  person: User,
  relation: ArrowUpRight,
  rollup: MagnifyingGlass,
  formula: FunctionIcon,
  created_at: Clock,
  updated_at: Clock,
  created_by: UserCircle,
  updated_by: UserCircle,
  files: Paperclip,
  id: Ticket,
  progress: ChartPieSlice,
  time: Timer,
  sprint: PersonSimpleRun,
  aliases: Quotes,
};

export function FieldTypeIcon({ field }: { field: Pick<Field, "type" | "ai"> }) {
  const TypeIcon = field.ai ? Sparkle : ICONS[field.type] || TextT;
  return <TypeIcon size={13} aria-hidden />;
}
