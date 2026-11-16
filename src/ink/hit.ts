import { densify, maxRadius, radiusAt, strokeBounds } from './geometry.ts';
import type { Bounds, Stroke } from './types.ts';

/** Distance from point P to segment AB. */
export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Distance between segments AB and CD (0 when they cross). */
export function segmentDistance(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): number {
  if (segmentsCross(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  return Math.min(
    distToSegment(ax, ay, cx, cy, dx, dy),
    distToSegment(bx, by, cx, cy, dx, dy),
    distToSegment(cx, cy, ax, ay, bx, by),
    distToSegment(dx, dy, ax, ay, bx, by),
  );
}

function segmentsCross(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean {
  const d1 = cross(cx, cy, dx, dy, ax, ay);
  const d2 = cross(cx, cy, dx, dy, bx, by);
  const d3 = cross(ax, ay, bx, by, cx, cy);
  const d4 = cross(ax, ay, bx, by, dx, dy);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function cross(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}

/** Bounds of the eraser's path segment, grown by its radius. */
export function capsuleBounds(ax: number, ay: number, bx: number, by: number, r: number): Bounds {
  return { minX: Math.min(ax, bx) - r, minY: Math.min(ay, by) - r, maxX: Math.max(ax, bx) + r, maxY: Math.max(ay, by) + r };
}

export function boundsOverlap(a: Bounds, b: Bounds): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/** Does the eraser, moving from A to B with radius r, touch the painted stroke? */
export function strokeTouched(s: Stroke, ax: number, ay: number, bx: number, by: number, r: number): boolean {
  if (!boundsOverlap(strokeBounds(s), capsuleBounds(ax, ay, bx, by, r))) return false;
  const p = s.pts;
  const n = p.length / 3;
  if (n === 1) return distToSegment(p[0], p[1], ax, ay, bx, by) <= r + radiusAt(s, p[2]);
  for (let i = 0; i < n - 1; i++) {
    const sr = Math.max(radiusAt(s, p[3 * i + 2]), radiusAt(s, p[3 * i + 5]));
    const d = segmentDistance(p[3 * i], p[3 * i + 1], p[3 * i + 3], p[3 * i + 4], ax, ay, bx, by);
    if (d <= r + sr) return true;
  }
  return false;
}

/**
 * Partial erase: cuts away the parts of the stroke's centre line inside the eraser path (A→B,
 * radius r). Returns null when the stroke is untouched, otherwise the remaining pieces as point
 * arrays (possibly none). The stroke is densified first so the cut follows the eraser closely.
 */
export function eraseFromStroke(s: Stroke, ax: number, ay: number, bx: number, by: number, r: number): number[][] | null {
  if (!strokeTouched(s, ax, ay, bx, by, r)) return null;
  const pts = densify(s.pts, Math.max(0.25, Math.min(r * 0.4, 1.5)));
  const n = pts.length / 3;
  const pieces: number[][] = [];
  let run: number[] = [];
  let removed = false;
  for (let i = 0; i < n; i++) {
    const x = pts[3 * i], y = pts[3 * i + 1];
    // erase where the eraser covers the centre line plus half the ink's own radius
    const reach = r + radiusAt(s, pts[3 * i + 2]) * 0.5;
    if (distToSegment(x, y, ax, ay, bx, by) <= reach) {
      removed = true;
      if (run.length) pieces.push(run);
      run = [];
    } else {
      run.push(round2(x), round2(y), pts[3 * i + 2]);
    }
  }
  if (run.length) pieces.push(run);
  if (!removed) return null;
  // drop crumbs: single points and pieces shorter than the stroke is wide
  const minLen = Math.max(0.5, maxRadius(s));
  return pieces.filter((piece) => piece.length >= 6 && pathLength(piece) >= minLen);
}

export function pathLength(pts: number[]): number {
  let len = 0;
  for (let i = 3; i < pts.length; i += 3) len += Math.hypot(pts[i] - pts[i - 3], pts[i + 1] - pts[i - 2]);
  return len;
}

/** Ray-casting point-in-polygon; `poly` is flat [x, y, x, y, …]. */
export function pointInPolygon(x: number, y: number, poly: number[]): boolean {
  let inside = false;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[2 * i], yi = poly[2 * i + 1], xj = poly[2 * j], yj = poly[2 * j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Strokes the lasso loop selects: at least 60 % of a stroke's points must be inside. */
export function lassoSelect(strokes: readonly Stroke[], poly: number[], share = 0.6): string[] {
  if (poly.length < 6) return [];
  const ids: string[] = [];
  for (const s of strokes) {
    const n = s.pts.length / 3;
    let inside = 0;
    for (let i = 0; i < n; i++) if (pointInPolygon(s.pts[3 * i], s.pts[3 * i + 1], poly)) inside++;
    if (n > 0 && inside / n >= share) ids.push(s.id);
  }
  return ids;
}

/** Copy of a stroke moved by (dx, dy), with a new id. */
export function translateStroke(s: Stroke, dx: number, dy: number, id: string): Stroke {
  const pts = s.pts.slice();
  for (let i = 0; i < pts.length; i += 3) {
    pts[i] = round2(pts[i] + dx);
    pts[i + 1] = round2(pts[i + 1] + dy);
  }
  return { ...s, id, pts };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
