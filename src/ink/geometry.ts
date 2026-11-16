import type { Bounds, Stroke } from './types.ts';

/** The subset of CanvasPath / Path2D that outlines need (so tests can record the calls). */
export interface PathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, start: number, end: number, ccw?: boolean): void;
  closePath(): void;
}

type WidthInfo = Pick<Stroke, 'width' | 'pressure' | 'tool'>;

/** Radius at pressure p. Without pressure (mouse, highlighter) the width is constant. */
export function radiusAt(s: WidthInfo, p: number): number {
  const half = s.width / 2;
  if (!s.pressure || s.tool === 'highlighter') return half;
  const c = Math.pow(p < 0 ? 0 : p > 1 ? 1 : p, 0.75);
  return half * (0.3 + 0.95 * c);
}

/** Largest radius the stroke can have (for bounds and hit tests). */
export function maxRadius(s: WidthInfo): number {
  return s.pressure && s.tool !== 'highlighter' ? (s.width / 2) * 1.25 : s.width / 2;
}

/**
 * Inserts points along a centripetal Catmull-Rom spline so the stroke stays a smooth curve at any
 * zoom. Segments longer than `maxSeg` page units are subdivided. Returns flat [x, y, p, …].
 */
export function densify(pts: number[], maxSeg: number): number[] {
  const n = pts.length / 3;
  if (n < 3) return pts.slice();
  const out: number[] = [pts[0], pts[1], pts[2]];
  const px = (i: number) => pts[3 * i];
  const py = (i: number) => pts[3 * i + 1];
  for (let i = 0; i < n - 1; i++) {
    const x1 = px(i), y1 = py(i), x2 = px(i + 1), y2 = py(i + 1);
    const p1 = pts[3 * i + 2], p2 = pts[3 * i + 5];
    const len = Math.hypot(x2 - x1, y2 - y1);
    const steps = Math.min(48, Math.max(1, Math.ceil(len / maxSeg)));
    if (steps === 1) {
      out.push(x2, y2, p2);
      continue;
    }
    // neighbours; at the ends, reflect so the curve leaves straight
    const x0 = i > 0 ? px(i - 1) : 2 * x1 - x2;
    const y0 = i > 0 ? py(i - 1) : 2 * y1 - y2;
    const x3 = i + 2 < n ? px(i + 2) : 2 * x2 - x1;
    const y3 = i + 2 < n ? py(i + 2) : 2 * y2 - y1;
    const t1 = knot(x0, y0, x1, y1);
    const t2 = t1 + knot(x1, y1, x2, y2);
    const t3 = t2 + knot(x2, y2, x3, y3);
    for (let s = 1; s <= steps; s++) {
      const u = s / steps;
      if (s === steps) {
        out.push(x2, y2, p2);
        break;
      }
      const t = t1 + u * (t2 - t1);
      out.push(
        catmull(x0, x1, x2, x3, t1, t2, t3, t),
        catmull(y0, y1, y2, y3, t1, t2, t3, t),
        p1 + (p2 - p1) * u,
      );
    }
  }
  return out;
}

function knot(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.sqrt(Math.hypot(bx - ax, by - ay)), 1e-4);
}

/** Barry–Goldman evaluation with t0 = 0. */
function catmull(p0: number, p1: number, p2: number, p3: number, t1: number, t2: number, t3: number, t: number): number {
  const a1 = ((t1 - t) / t1) * p0 + (t / t1) * p1;
  const a2 = ((t2 - t) / (t2 - t1)) * p1 + ((t - t1) / (t2 - t1)) * p2;
  const a3 = ((t3 - t) / (t3 - t2)) * p2 + ((t - t2) / (t3 - t2)) * p3;
  const b1 = ((t2 - t) / t2) * a1 + (t / t2) * a2;
  const b2 = ((t3 - t) / (t3 - t1)) * a2 + ((t - t1) / (t3 - t1)) * a3;
  return ((t2 - t) / (t2 - t1)) * b1 + ((t - t1) / (t2 - t1)) * b2;
}

/** Spacing used to densify a stroke before outlining. */
export function segmentLength(s: WidthInfo): number {
  return Math.max(0.35, Math.min(2, s.width * 0.45));
}

/**
 * Outline of a stroke as a union of tapered capsules (circle–tangent–circle per segment). Every
 * sub-path winds the same way, so filling with the nonzero rule paints the union in one pass —
 * which also keeps semi-transparent ink uniform where the stroke crosses itself.
 */
export function outlineStroke(s: Stroke, sink: PathSink): void {
  outlinePoints(s, densify(s.pts, segmentLength(s)), sink);
}

export function outlinePoints(s: WidthInfo, pts: number[], sink: PathSink): void {
  const n = pts.length / 3;
  if (n === 0) return;
  let x1 = pts[0], y1 = pts[1], r1 = radiusAt(s, pts[2]);
  if (n === 1) {
    circle(sink, x1, y1, r1);
    return;
  }
  for (let i = 1; i < n; i++) {
    const x2 = pts[3 * i], y2 = pts[3 * i + 1], r2 = radiusAt(s, pts[3 * i + 2]);
    capsule(sink, x1, y1, r1, x2, y2, r2);
    x1 = x2;
    y1 = y2;
    r1 = r2;
  }
}

function circle(sink: PathSink, x: number, y: number, r: number): void {
  sink.moveTo(x + r, y);
  sink.arc(x, y, r, 0, 2 * Math.PI);
  sink.closePath();
}

function capsule(sink: PathSink, x1: number, y1: number, r1: number, x2: number, y2: number, r2: number): void {
  const dx = x2 - x1, dy = y2 - y1;
  const d = Math.hypot(dx, dy);
  if (d <= Math.abs(r1 - r2) || d < 1e-6) {
    // one circle contains the other
    if (r2 >= r1) circle(sink, x2, y2, r2);
    else circle(sink, x1, y1, r1);
    return;
  }
  const theta = Math.atan2(dy, dx);
  const alpha = Math.acos((r1 - r2) / d);
  const a = theta + alpha;
  const b = theta - alpha + 2 * Math.PI;
  // angles always increase, so every capsule winds the same way
  sink.moveTo(x1 + r1 * Math.cos(a), y1 + r1 * Math.sin(a));
  sink.arc(x1, y1, r1, a, b);
  sink.lineTo(x2 + r2 * Math.cos(b), y2 + r2 * Math.sin(b));
  sink.arc(x2, y2, r2, theta - alpha, theta + alpha);
  sink.closePath();
}

const boundsCache = new WeakMap<Stroke, Bounds>();

/** Bounding box including the stroke's width. */
export function strokeBounds(s: Stroke): Bounds {
  let b = boundsCache.get(s);
  if (b) return b;
  const r = maxRadius(s);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < s.pts.length; i += 3) {
    const x = s.pts[i], y = s.pts[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  b = { minX: minX - r, minY: minY - r, maxX: maxX + r, maxY: maxY + r };
  boundsCache.set(s, b);
  return b;
}

export function unionBounds(list: Bounds[]): Bounds | null {
  if (!list.length) return null;
  const u = { ...list[0] };
  for (const b of list) {
    if (b.minX < u.minX) u.minX = b.minX;
    if (b.minY < u.minY) u.minY = b.minY;
    if (b.maxX > u.maxX) u.maxX = b.maxX;
    if (b.maxY > u.maxY) u.maxY = b.maxY;
  }
  return u;
}
