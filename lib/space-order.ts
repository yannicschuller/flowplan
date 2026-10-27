// The order of spaces in a workspace (schema 67, issue #48). spaces.position
// is a fractional sort key like pages.position; every list of spaces shown
// to people sorts by SPACE_ORDER. New spaces go to the end (the trigger
// spaces_position_insert in lib/db.ts), a space restored from the trash keeps
// its old place (its position never changes while it is there), a duplicate
// goes right after its original.
//
// "space.reorder" { workspaceId, order: [spaceIds] }: workspace owners send
// the spaces they see in the sidebar in their new order. Only those get new
// positions – between their new neighbours, so spaces the caller cannot see
// (private spaces of others, encrypted spaces without access, the trash)
// keep theirs. Their ids and names never appear in the request or the answer.
import { z } from "zod";
import { all, one, run } from "./db";
import { HttpError } from "./auth";
import { pageRole, requireMember, spaceRole } from "./permissions";
import type { Identity, Page, Space } from "./types";

// ORDER BY for every query that lists spaces for people.
export const SPACE_ORDER = "position,rowid";

type Slot = { id: string; position: number | null };

// The spaces of a workspace someone sees in the sidebar: those they may
// read, and those holding a page shared with them. `pageSpaces` are the
// spaces of the readable pages when the caller already knows them.
export function visibleSpaces(user: Identity, workspaceId: string, pageSpaces?: Set<string>): Space[] {
  const spaces = all<Space>(`SELECT * FROM spaces WHERE workspace_id=? ORDER BY ${SPACE_ORDER}`, workspaceId);
  return spaces.filter((s) => {
    if (spaceRole(user, s)) return true;
    if (pageSpaces) return pageSpaces.has(s.id);
    if (s.deleted_at) return false;
    return all<Page>("SELECT * FROM pages WHERE space_id=? AND synced=0", s.id).some((p) => pageRole(user, p));
  });
}

// New positions for `order` (the visible spaces in their new order) among
// all spaces of the workspace (`slots`, sorted, with distinct positions).
// The longest run of spaces already in the right relative order keeps its
// positions; every other one gets a position between its new neighbours.
// Only changed positions are returned. null: the gaps are too small – the
// caller spreads the positions out and asks again.
export function reorderPositions(slots: Slot[], order: string[]): Map<string, number> | null {
  const position = new Map(slots.map((s) => [s.id, s.position ?? 0]));
  const values = order.map((id) => position.get(id)!);
  // Longest strictly increasing subsequence (patience sorting).
  const tails: number[] = [],
    previous: number[] = new Array(values.length).fill(-1);
  values.forEach((value, i) => {
    let lo = 0,
      hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[tails[mid]] < value) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) previous[i] = tails[lo - 1];
    tails[lo] = i;
  });
  const kept = new Set<number>();
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = previous[i]) kept.add(i);
  const changes = new Map<string, number>();
  let before = -Infinity;
  for (let i = 0; i < order.length; ) {
    if (kept.has(i)) {
      before = values[i];
      i++;
      continue;
    }
    // A run of spaces to place between `before` and the next kept one.
    let end = i;
    while (end < order.length && !kept.has(end)) end++;
    const after = end < order.length ? values[end] : Infinity,
      count = end - i;
    for (let k = 1; k <= count; k++) {
      const value =
        before === -Infinity && after === Infinity
          ? k
          : before === -Infinity
            ? after - (count - k + 1)
            : after === Infinity
              ? before + k
              : before + ((after - before) * k) / (count + 1);
      if (!Number.isFinite(value)) return null;
      changes.set(order[i + k - 1], value);
    }
    if (before !== -Infinity && after !== Infinity && (after - before) / (count + 1) < 1e-9) return null;
    before = changes.get(order[end - 1])!;
    i = end;
  }
  return changes;
}

// All spaces of a workspace in their order, with distinct positions: ties
// and missing values (data from before, imports) are spread out to 1…n first.
function slots(workspaceId: string, spread = false): Slot[] {
  const list = all<Slot>(`SELECT id,position FROM spaces WHERE workspace_id=? ORDER BY ${SPACE_ORDER}`, workspaceId);
  const distinct = list.every((s, i) => s.position !== null && (i === 0 || s.position > list[i - 1].position!));
  if (distinct && !spread) return list;
  list.forEach((s, i) => {
    s.position = i + 1;
    run("UPDATE spaces SET position=? WHERE id=?", i + 1, s.id);
  });
  return list;
}

const reorderInput = z.object({
  workspaceId: z.uuid(),
  order: z.array(z.uuid()).min(1).max(1000),
});
export function reorderSpaces(user: Identity, input: unknown) {
  const { workspaceId, order } = reorderInput.parse(input);
  requireMember(user, workspaceId, "owner");
  if (new Set(order).size !== order.length) throw new HttpError(400, "Ein Bereich steht mehrfach in der Reihenfolge.");
  const visible = visibleSpaces(user, workspaceId).filter((s) => !s.deleted_at);
  const ids = new Set(visible.map((s) => s.id));
  // Unknown and hidden spaces get the same answer: nothing tells them apart.
  if (order.some((id) => !ids.has(id))) throw new HttpError(404, "Bereich nicht gefunden.");
  // Visible spaces the request leaves out (created meanwhile) keep their place.
  let changes = reorderPositions(slots(workspaceId), order);
  if (!changes) changes = reorderPositions(slots(workspaceId, true), order);
  if (!changes) throw new HttpError(409, "Die Reihenfolge ließ sich nicht speichern. Bitte neu laden.");
  for (const [id, position] of changes) run("UPDATE spaces SET position=? WHERE id=?", position, id);
  return {
    ok: true as const,
    order: all<{ id: string }>(`SELECT id FROM spaces WHERE workspace_id=? ORDER BY ${SPACE_ORDER}`, workspaceId)
      .map((s) => s.id)
      .filter((id) => ids.has(id)),
  };
}

// A duplicate goes right after its original (before the next space, seen or
// not). Called right after the copy's row exists.
export function placeAfter(spaceId: string, originalId: string) {
  const original = one<Space & { position: number | null }>("SELECT workspace_id FROM spaces WHERE id=?", originalId);
  if (!original) return;
  let list = slots(original.workspace_id).filter((s) => s.id !== spaceId);
  let at = list.findIndex((s) => s.id === originalId);
  const between = () => {
    const before = list[at].position!,
      after = list[at + 1]?.position;
    return after === undefined || after === null ? before + 1 : (before + after) / 2;
  };
  let position = between();
  if (list[at + 1] && (position <= list[at].position! || position >= list[at + 1].position!)) {
    list = slots(original.workspace_id, true).filter((s) => s.id !== spaceId);
    at = list.findIndex((s) => s.id === originalId);
    position = between();
  }
  run("UPDATE spaces SET position=? WHERE id=?", position, spaceId);
}
