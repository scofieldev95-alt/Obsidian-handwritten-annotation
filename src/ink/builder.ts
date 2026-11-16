import type { InkTool, Sample, Stroke } from './types.ts';

/**
 * One Euro filter: strong smoothing when the pen moves slowly (removes jitter), little smoothing
 * when it moves fast (no lag). Works on one coordinate.
 */
export class OneEuroFilter {
  private readonly minCutoff: number;
  private readonly beta: number;
  private readonly dCutoff: number;
  private value: number | null = null;
  private deriv = 0;
  private lastT = 0;

  constructor(minCutoff: number, beta: number, dCutoff = 1) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  filter(v: number, tMs: number): number {
    if (this.value === null) {
      this.value = v;
      this.lastT = tMs;
      return v;
    }
    let dt = (tMs - this.lastT) / 1000;
    if (!(dt > 0)) dt = 1 / 240;
    this.lastT = tMs;
    const alpha = (cutoff: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
    const d = (v - this.value) / dt;
    this.deriv += alpha(this.dCutoff) * (d - this.deriv);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.deriv);
    this.value += alpha(cutoff) * (v - this.value);
    return this.value;
  }
}

/** Filter tuning, in screen pixels (the hand moves in screen space, whatever the zoom). */
const MIN_CUTOFF = 2.2;
const BETA = 0.025;
/** Samples closer than this (screen px) to the last kept one are merged. */
const MIN_STEP_PX = 0.7;

/**
 * Turns raw pointer samples into a stroke while the pen moves. Samples come in page units; the
 * filter runs in screen pixels (`scale` = screen px per page unit at the time of writing).
 */
export class StrokeBuilder {
  readonly pts: number[] = [];
  private readonly fx: OneEuroFilter;
  private readonly fy: OneEuroFilter;
  private readonly scale: number;
  private readonly hasPressure: boolean;
  private smoothP = -1;
  private last: Sample | null = null;

  constructor(scale: number, hasPressure: boolean) {
    this.scale = scale > 0 ? scale : 1;
    this.hasPressure = hasPressure;
    this.fx = new OneEuroFilter(MIN_CUTOFF, BETA);
    this.fy = new OneEuroFilter(MIN_CUTOFF, BETA);
  }

  add(s: Sample): void {
    this.last = s;
    const x = this.fx.filter(s.x * this.scale, s.t) / this.scale;
    const y = this.fy.filter(s.y * this.scale, s.t) / this.scale;
    const rawP = this.hasPressure ? clamp01(s.p) : 0.5;
    this.smoothP = this.smoothP < 0 ? rawP : this.smoothP + 0.35 * (rawP - this.smoothP);
    const n = this.pts.length;
    if (n >= 3) {
      const dx = (x - this.pts[n - 3]) * this.scale;
      const dy = (y - this.pts[n - 2]) * this.scale;
      if (dx * dx + dy * dy < MIN_STEP_PX * MIN_STEP_PX) {
        // keep the strongest pressure of merged samples so dots and slow strokes don't thin out
        this.pts[n - 1] = Math.max(this.pts[n - 1], round3(this.smoothP));
        return;
      }
    }
    this.pts.push(round2(x), round2(y), round3(this.smoothP));
  }

  /** Ends the stroke where the pen really lifted (the filter lags a little behind). */
  finish(): number[] {
    const s = this.last;
    const n = this.pts.length;
    if (s && n >= 3) {
      const dx = (s.x - this.pts[n - 3]) * this.scale;
      const dy = (s.y - this.pts[n - 2]) * this.scale;
      if (dx * dx + dy * dy >= MIN_STEP_PX * MIN_STEP_PX) this.pts.push(round2(s.x), round2(s.y), this.pts[n - 1]);
    }
    return this.pts;
  }
}

export function makeStroke(
  id: string,
  tool: InkTool,
  color: string,
  width: number,
  pressure: boolean,
  pts: number[],
  at: number,
): Stroke {
  return { id, tool, color, width, pressure: tool === 'highlighter' ? false : pressure, pts, at };
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
