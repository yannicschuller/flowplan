// The laser pointer of a notebook presentation
// (components/notebook/notebook-presentation.tsx): the recent points of the
// pointer as line segments that get thinner and fainter with age – a
// short trail behind the glowing dot.
export type TrailPoint = { x: number; y: number; t: number };
export type TrailSegment = { x1: number; y1: number; x2: number; y2: number; weight: number };

// Segments between the points younger than `duration`, `weight` 1 for the
// newest and towards 0 for the oldest. Jumps (a pointer that left and came
// back elsewhere, or a pause) break the trail.
export function pointerTrail(points: TrailPoint[], now: number, duration: number, maxGap = 250): TrailSegment[] {
  const out: TrailSegment[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i];
    if (now - b.t >= duration || b.t - a.t > maxGap) continue;
    const weight = Math.max(0, Math.min(1, 1 - (now - b.t) / duration));
    if (weight > 0) out.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, weight: Math.round(weight * 100) / 100 });
  }
  return out;
}
