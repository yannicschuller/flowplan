// The duration of a WebM recording made by MediaRecorder (notebook audio,
// lib/notebook-audio.ts). Browsers write such files as a stream: the
// Segment has an unknown size and the Info element no Duration, so a player
// shows no length and seeks poorly. `webmDurationPatch` returns a new start
// of the file with Duration in Info (or the existing Duration overwritten);
// the rest of the file follows unchanged from `skip`.
//
// Only the usual MediaRecorder layout is changed: EBML header, then the
// Segment with Info before any SeekHead or Cues (those hold byte positions
// that inserting would break). Anything else returns null and the file is
// kept as it was.

type Vint = { value: number; length: number; unknown: boolean };

// An element id: 1–4 bytes, the length in the leading bits.
function readId(buf: Buffer, at: number): { id: number; length: number } | null {
  const first = buf[at];
  if (first === undefined) return null;
  const length = first & 0x80 ? 1 : first & 0x40 ? 2 : first & 0x20 ? 3 : first & 0x10 ? 4 : 0;
  if (!length || at + length > buf.length) return null;
  let id = 0;
  for (let i = 0; i < length; i++) id = id * 256 + buf[at + i];
  return { id, length };
}
// An element size: 1–8 bytes; all value bits set means "unknown".
function readSize(buf: Buffer, at: number): Vint | null {
  const first = buf[at];
  if (first === undefined || first === 0) return null;
  let length = 1;
  while (!(first & (0x80 >> (length - 1)))) length++;
  if (at + length > buf.length) return null;
  let value = first & (0xff >> length);
  let allOnes = value === 0xff >> length;
  for (let i = 1; i < length; i++) {
    value = value * 256 + buf[at + i];
    if (buf[at + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: allOnes };
}
// A size in exactly eight bytes (0x01 + 7 bytes), so it never needs to grow.
function size8(value: number) {
  const out = Buffer.alloc(8);
  out[0] = 0x01;
  let v = value;
  for (let i = 7; i >= 1; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return out;
}
// The same size in `length` bytes, or null when it does not fit.
function sizeIn(value: number, length: number) {
  if (value >= 2 ** (7 * length) - 1) return null;
  const out = Buffer.alloc(length);
  let v = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0] |= 0x80 >> (length - 1);
  return out;
}

const EBML = 0x1a45dfa3,
  SEGMENT = 0x18538067,
  INFO = 0x1549a966,
  SEEK_HEAD = 0x114d9b74,
  CUES = 0x1c53bb6b,
  TIMECODE_SCALE = 0x2ad7b1,
  DURATION = 0x4489;

export function webmDurationPatch(head: Buffer, durationMs: number): { head: Buffer; skip: number } | null {
  if (!(durationMs > 0) || !Number.isFinite(durationMs)) return null;
  const ebml = readId(head, 0);
  if (ebml?.id !== EBML) return null;
  const ebmlSize = readSize(head, ebml.length);
  if (!ebmlSize || ebmlSize.unknown) return null;
  const segmentAt = ebml.length + ebmlSize.length + ebmlSize.value;
  const segment = readId(head, segmentAt);
  if (segment?.id !== SEGMENT) return null;
  const segmentSize = readSize(head, segmentAt + segment.length);
  if (!segmentSize) return null;
  let at = segmentAt + segment.length + segmentSize.length;
  // The Segment's children up to Info.
  while (at < head.length) {
    const child = readId(head, at);
    if (!child) return null;
    if (child.id === SEEK_HEAD || child.id === CUES) return null;
    const size = readSize(head, at + child.length);
    if (!size || size.unknown) return null;
    const contentAt = at + child.length + size.length;
    const end = contentAt + size.value;
    if (child.id !== INFO) {
      at = end;
      continue;
    }
    if (end > head.length) return null;
    // Info's children: the time scale (ns per tick, default 1 ms) and the Duration.
    let scale = 1_000_000;
    let durationAt = -1,
      durationSize = 0;
    for (let p = contentAt; p < end; ) {
      const sub = readId(head, p);
      const subSize = sub && readSize(head, p + sub.length);
      if (!sub || !subSize || subSize.unknown) return null;
      const valueAt = p + sub.length + subSize.length;
      if (sub.id === TIMECODE_SCALE && subSize.value >= 1 && subSize.value <= 8) scale = head.readUIntBE(valueAt, Math.min(6, subSize.value));
      if (sub.id === DURATION) {
        durationAt = valueAt;
        durationSize = subSize.value;
      }
      p = valueAt + subSize.value;
    }
    const ticks = (durationMs * 1_000_000) / (scale || 1_000_000);
    if (durationAt >= 0 && (durationSize === 8 || durationSize === 4)) {
      const out = Buffer.from(head.subarray(0, end));
      if (durationSize === 8) out.writeDoubleBE(ticks, durationAt);
      else out.writeFloatBE(ticks, durationAt);
      return { head: out, skip: end };
    }
    if (durationAt >= 0) return null;
    // A new Duration (float64) at the end of Info; Info's size in 8 bytes.
    const value = Buffer.alloc(8);
    value.writeDoubleBE(ticks);
    const duration = Buffer.concat([Buffer.from([0x44, 0x89, 0x88]), value]);
    const content = Buffer.concat([head.subarray(contentAt, end), duration]);
    const infoHeader = Buffer.concat([head.subarray(at, at + child.length), size8(content.length)]);
    const grown = infoHeader.length + content.length - (end - at);
    // A Segment of known size grows by as much (same length of its size field).
    let segmentHeader = head.subarray(segmentAt, segmentAt + segment.length + segmentSize.length);
    if (!segmentSize.unknown) {
      const next = sizeIn(segmentSize.value + grown, segmentSize.length);
      if (!next) return null;
      segmentHeader = Buffer.concat([head.subarray(segmentAt, segmentAt + segment.length), next]);
    }
    const out = Buffer.concat([
      head.subarray(0, segmentAt),
      segmentHeader,
      head.subarray(segmentAt + segment.length + segmentSize.length, at),
      infoHeader,
      content,
    ]);
    return { head: out, skip: end };
  }
  return null;
}

// The Duration in milliseconds, if the start of a WebM file has one (tests, checks).
export function webmDurationMs(head: Buffer): number | null {
  const ebml = readId(head, 0);
  if (ebml?.id !== EBML) return null;
  const ebmlSize = readSize(head, ebml.length);
  if (!ebmlSize) return null;
  const segmentAt = ebml.length + ebmlSize.length + ebmlSize.value;
  const segment = readId(head, segmentAt);
  const segmentSize = segment && readSize(head, segmentAt + segment.length);
  if (segment?.id !== SEGMENT || !segmentSize) return null;
  for (let at = segmentAt + segment.length + segmentSize.length; at < head.length; ) {
    const child = readId(head, at);
    const size = child && readSize(head, at + child.length);
    if (!child || !size || size.unknown) return null;
    const contentAt = at + child.length + size.length;
    if (child.id === INFO) {
      let scale = 1_000_000,
        ticks: number | null = null;
      for (let p = contentAt; p < contentAt + size.value; ) {
        const sub = readId(head, p);
        const subSize = sub && readSize(head, p + sub.length);
        if (!sub || !subSize) return null;
        const valueAt = p + sub.length + subSize.length;
        if (sub.id === TIMECODE_SCALE) scale = head.readUIntBE(valueAt, Math.min(6, subSize.value));
        if (sub.id === DURATION) ticks = subSize.value === 8 ? head.readDoubleBE(valueAt) : head.readFloatBE(valueAt);
        p = valueAt + subSize.value;
      }
      return ticks === null ? null : (ticks * scale) / 1_000_000;
    }
    at = contentAt + size.value;
  }
  return null;
}
