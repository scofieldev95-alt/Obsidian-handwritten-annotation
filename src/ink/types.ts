// Core ink types. Everything in src/ink is free of Obsidian and the DOM so it can be unit-tested in Node.

export type InkTool = 'pen' | 'highlighter';
export type Tool = InkTool | 'eraser' | 'lasso';
export type EraserMode = 'stroke' | 'partial';

/**
 * One finished stroke. Strokes are immutable: editing (move, partial erase) removes a stroke and
 * adds new ones. Coordinates are page units (PDF points for PDFs, pixels for images), so the ink
 * sits in the same place on the page at any zoom and on any screen.
 */
export interface Stroke {
  id: string;
  tool: InkTool;
  /** CSS hex colour, #rrggbb. */
  color: string;
  /** Base width in page units. */
  width: number;
  /** True when `pts` carry real pen pressure (Apple Pencil, pen tablet). */
  pressure: boolean;
  /** Flat [x, y, p, x, y, p, …]; x/y in page units, p (pressure) in 0..1. */
  pts: number[];
  /** Creation time, ms since epoch. Used for paint order. */
  at: number;
}

export interface Sample {
  x: number;
  y: number;
  /** Pressure 0..1 (0.5 when the device has none). */
  p: number;
  /** Time in ms. */
  t: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
