// Windows of a WebM recording that is still going on (lib/meetings.ts,
// transcribing while recording). MediaRecorder with a timeslice gives
// pieces of ONE file: only the first carries the header (EBML, Segment,
// Info, Tracks), and the later ones start in the middle of a cluster. A
// window that a decoder reads is therefore the header of piece 0 followed
// by the bytes from the start of a cluster (ID 1F 43 B6 75, then its size
// and its Timecode E7) onwards – checked with real pieces of Chromium's
// MediaRecorder (tests/fixtures/mediarecorder). The cluster's timecode is
// where the window starts in the recording. No server imports.

const CLUSTER = [0x1f, 0x43, 0xb6, 0x75];
const EBML = [0x1a, 0x45, 0xdf, 0xa3];

// An EBML variable-length number at `pos`: its length in bytes and value
// (null for the reserved "unknown size").
function vint(bytes: Uint8Array, pos: number): { length: number; value: number | null } | null {
  const first = bytes[pos];
  if (first === undefined || first === 0) return null;
  let length = 1;
  while (!(first & (0x80 >> (length - 1)))) length++;
  if (length > 8 || pos + length > bytes.length) return null;
  let value = first & (0xff >> length);
  let unknown = value === 0xff >> length;
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[pos + i];
    if (bytes[pos + i] !== 0xff) unknown = false;
  }
  return { length, value: unknown ? null : value };
}
const uint = (bytes: Uint8Array, pos: number, length: number) => {
  let value = 0;
  for (let i = 0; i < length; i++) value = value * 256 + bytes[pos + i];
  return value;
};
const at = (bytes: Uint8Array, pos: number, id: number[]) => id.every((b, i) => bytes[pos + i] === b);

export type WebmCluster = { offset: number; time: number };

// The clusters that start in `bytes`: where, and their timecode in the
// recording's ticks (TimecodeScale, normally milliseconds).
export function webmClusters(bytes: Uint8Array, from = 0): WebmCluster[] {
  const out: WebmCluster[] = [];
  for (let pos = Math.max(0, from); pos + 4 < bytes.length; pos++) {
    if (bytes[pos] !== 0x1f || !at(bytes, pos, CLUSTER)) continue;
    const size = vint(bytes, pos + 4);
    if (!size) continue;
    const tc = pos + 4 + size.length;
    // The first child of a cluster is its Timecode (E7).
    if (bytes[tc] !== 0xe7) continue;
    const length = vint(bytes, tc + 1);
    if (!length || length.value === null || length.value < 1 || length.value > 8 || tc + 1 + length.length + length.value > bytes.length) continue;
    out.push({ offset: pos, time: uint(bytes, tc + 1 + length.length, length.value) });
  }
  return out;
}

// The header of the first piece (everything before its first cluster) and
// the length of a tick in seconds; null when it is no WebM.
export function webmHeader(first: Uint8Array): { header: Uint8Array; tick: number; clusters: WebmCluster[] } | null {
  if (!at(first, 0, EBML)) return null;
  const clusters = webmClusters(first);
  if (!clusters.length) return null;
  const header = first.subarray(0, clusters[0].offset);
  // TimecodeScale (2A D7 B1) in nanoseconds, 1 000 000 by default.
  let scale = 1_000_000;
  for (let pos = 0; pos + 3 < header.length; pos++)
    if (at(header, pos, [0x2a, 0xd7, 0xb1])) {
      const size = vint(header, pos + 3);
      if (size?.value && size.value <= 8) scale = uint(header, pos + 3 + size.length, size.value) || scale;
      break;
    }
  return { header, tick: scale / 1e9, clusters };
}

// A decodable window: the header, then the window's first piece from
// `offset` (a cluster start) and the pieces after it. `pieces[0]` is the
// recording's first piece when `fromStart` (then it goes as it is).
export function webmWindow(header: Uint8Array, pieces: Uint8Array[], offset: number, fromStart: boolean): Blob {
  const parts: Uint8Array[] = fromStart && offset === header.length ? [pieces[0]] : [header, pieces[0].subarray(offset)];
  parts.push(...pieces.slice(1));
  return new Blob(parts as BlobPart[], { type: "audio/webm" });
}
