import { z } from "zod";

const identifier = z
  .object({
    client: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    clock: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export const relativePositionSchema = z
  .object({
    type: identifier.nullable().optional(),
    tname: z.literal("default").nullable().optional(),
    item: identifier.nullable().optional(),
    assoc: z.number().int().min(-1).max(1).optional(),
  })
  .strict()
  .refine((p) => !!p.type !== !!p.tname, "Ungültige Position.");
export const cursorSchema = z
  .object({
    anchor: relativePositionSchema,
    head: relativePositionSchema,
  })
  .strict();
// Block/offset address shared by member documents and guest projections.
const textPoint = z
  .object({ b: z.number().int().min(0).max(1_000_000), o: z.number().int().min(0).max(10_000_000) })
  .strict();
export const textCursorSchema = z.object({ anchor: textPoint, head: textPoint }).strict();
export const cursorRequestSchema = z
  .object({
    clientId: z.uuid(),
    pageId: z.string().min(1).max(128),
    rowId: z.string().min(1).max(128).optional(),
    generation: z.string().min(1).max(128),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    cursor: cursorSchema.nullable(),
    // The same position as text address, for guests on share links.
    text: textCursorSchema.nullable().optional(),
  })
  .strict();
export type Cursor = z.infer<typeof cursorSchema>;
export type CursorRequest = z.infer<typeof cursorRequestSchema>;
export type TextCursorValue = z.infer<typeof textCursorSchema>;
// Members carry a Yjs cursor; guests (and members as seen by guests) a
// text address.
export type CursorPeer = {
  id: string;
  userId: string;
  name: string;
  cursor?: Cursor;
  text?: TextCursorValue;
  expiresInMs: number;
};
export const CURSOR_LEASE_MS = 15_000;
export function cursorColor(userId: string) {
  let value = 0;
  for (const char of userId) value = (value * 31 + char.charCodeAt(0)) >>> 0;
  return ["#9952b8", "#287baf", "#bc505c", "#298069", "#94651d", "#6660c4"][
    value % 6
  ];
}
