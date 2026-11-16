import type { EraserMode, Tool } from './ink/types.ts';

export interface PluginSettings {
  tool: Tool;
  pen: { color: string; width: number };
  highlighter: { color: string; width: number };
  eraser: { mode: EraserMode; size: number };
  penColors: string[];
  highlighterColors: string[];
  /** Let a finger draw (off: a finger scrolls, only a pen or mouse writes). */
  fingerDraw: boolean;
  /** PDFs opened from the file list use our view. */
  openPdfs: boolean;
  /** ![[file.pdf]] in notes is writable. */
  pdfEmbeds: boolean;
  /** ![[image.png]] (png, jpg, webp) in notes is writable. */
  imageEmbeds: boolean;
}

/** Width presets in page units (PDF points). */
export const PEN_WIDTHS = [0.8, 1.6, 3];
export const HIGHLIGHTER_WIDTHS = [8, 14, 22];
export const ERASER_SIZES = [4, 10, 22];

export const DEFAULT_SETTINGS: PluginSettings = {
  tool: 'pen',
  pen: { color: '#1f1f1f', width: PEN_WIDTHS[1] },
  highlighter: { color: '#ffe14d', width: HIGHLIGHTER_WIDTHS[1] },
  eraser: { mode: 'stroke', size: ERASER_SIZES[1] },
  penColors: ['#1f1f1f', '#2156d1', '#d93025', '#188038', '#8e44ad'],
  highlighterColors: ['#ffe14d', '#9be37a', '#ff9ecb', '#8fd3ff', '#ffb36b'],
  fingerDraw: false,
  openPdfs: true,
  pdfEmbeds: true,
  imageEmbeds: true,
};

const TOOLS: Tool[] = ['pen', 'highlighter', 'eraser', 'lasso'];
const HEX = /^#[0-9a-f]{6}$/i;

/** Accepts anything (old or hand-edited data.json) and returns valid settings. */
export function sanitizeSettings(raw: unknown): PluginSettings {
  const d = structuredClone(DEFAULT_SETTINGS);
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Record<string, unknown>;
  const pen = obj(r.pen);
  const hl = obj(r.highlighter);
  const eraser = obj(r.eraser);
  if (TOOLS.includes(r.tool as Tool)) d.tool = r.tool as Tool;
  if (hex(pen.color)) d.pen.color = pen.color;
  if (num(pen.width, 0.2, 20)) d.pen.width = pen.width;
  if (hex(hl.color)) d.highlighter.color = hl.color;
  if (num(hl.width, 2, 60)) d.highlighter.width = hl.width;
  if (eraser.mode === 'stroke' || eraser.mode === 'partial') d.eraser.mode = eraser.mode;
  if (num(eraser.size, 1, 80)) d.eraser.size = eraser.size;
  if (colors(r.penColors)) d.penColors = r.penColors;
  if (colors(r.highlighterColors)) d.highlighterColors = r.highlighterColors;
  for (const key of ['fingerDraw', 'openPdfs', 'pdfEmbeds', 'imageEmbeds'] as const) {
    const v = r[key];
    if (typeof v === 'boolean') d[key] = v;
  }
  return d;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function hex(v: unknown): v is string {
  return typeof v === 'string' && HEX.test(v);
}

function num(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}

function colors(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.length <= 12 && v.every((c) => typeof c === 'string' && HEX.test(c));
}

type Listener = (s: PluginSettings) => void;

/** Shared tool settings: every annotator on screen listens, so they all show the same tool. */
export class SettingsStore {
  data: PluginSettings;
  private readonly listeners = new Set<Listener>();
  private readonly save: (s: PluginSettings) => void;

  constructor(data: PluginSettings, save: (s: PluginSettings) => void) {
    this.data = data;
    this.save = save;
  }

  update(mutate: (s: PluginSettings) => void): void {
    mutate(this.data);
    this.save(this.data);
    for (const fn of this.listeners) fn(this.data);
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
