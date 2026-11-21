import { StrokeBuilder, makeStroke } from '../ink/builder.ts';
import { densify, outlinePoints, outlineStroke, segmentLength, strokeBounds, unionBounds } from '../ink/geometry.ts';
import { eraseFromStroke, lassoSelect, strokeTouched, translateStroke } from '../ink/hit.ts';
import type { Bounds, InkTool, Stroke } from '../ink/types.ts';
import type { InkDocument } from '../model/document.ts';
import { newStrokeId } from '../model/ids.ts';
import type { SettingsStore } from '../settings.ts';

/** Where the page lands on a canvas, in device pixels: device = page × k + (ox, oy). */
export interface RenderView {
  k: number;
  ox: number;
  oy: number;
  /** Canvas size in device pixels. */
  w: number;
  h: number;
}

/** What sits under the ink: a PDF page, an image, or blank paper. */
export interface PageBackground {
  /** Page size in page units. */
  readonly width: number;
  readonly height: number;
  /**
   * Paint the page for `view` onto `ctx` (identity transform, device pixels). The surface clips
   * the result to the page and fills the paper white first.
   */
  render(ctx: CanvasRenderingContext2D, view: RenderView, signal: AbortSignal): void | Promise<void>;
}

/**
 * `fit`: the page fills the element's width and the element takes the page's height (embeds).
 * `viewport`: the element has a fixed size and the page can be zoomed and panned (full screen).
 */
export type SurfaceLayout = 'fit' | 'viewport';

type Mode = 'draw' | 'erase' | 'lasso' | 'move';

interface Camera {
  /** CSS px per page unit. */
  scale: number;
  /** Page origin in CSS px from the element's top-left. */
  ox: number;
  oy: number;
}

/** A rendered page image; `view.ox/oy` is where the page origin lies inside `canvas`. */
interface Snapshot {
  canvas: HTMLCanvasElement;
  view: RenderView;
}

const pathCache = new WeakMap<Stroke, Path2D>();

function strokePath(s: Stroke): Path2D {
  let p = pathCache.get(s);
  if (!p) {
    p = new Path2D();
    outlineStroke(s, p);
    pathCache.set(s, p);
  }
  return p;
}

/** Pixels the selection box is grown by, so it is easy to grab. */
const SELECTION_PAD_PX = 8;
/** Margin around the page in the full-screen view, CSS px. */
const VIEW_MARGIN = 24;
/** The widest the page is shown at 100 % in the full-screen view, CSS px. */
const MAX_BASE_WIDTH = 1000;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 8;
/** Largest page canvas we render in one piece (device px²); bigger gets clipped to the view. */
const MAX_SNAPSHOT_AREA = 4_000_000;

/**
 * One writable page: the background, the ink, and pointer input. All stored coordinates are
 * page units; the camera only changes how they are shown.
 */
export class InkSurface {
  readonly el: HTMLDivElement;
  private readonly layout: SurfaceLayout;
  private readonly bg: HTMLCanvasElement;
  private readonly hl: HTMLCanvasElement;
  private readonly ink: HTMLCanvasElement;
  private readonly live: HTMLCanvasElement;
  private readonly overlay: HTMLCanvasElement;
  private readonly doc: InkDocument;
  private readonly settings: SettingsStore;
  private readonly onState: () => void;
  private readonly cleanups: (() => void)[] = [];
  private readonly resizeObserver: ResizeObserver;

  private page: number;
  private background: PageBackground;
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  private cam: Camera = { scale: 1, ox: 0, oy: 0 };
  /** Zoom relative to "fit width" (viewport layout only). */
  private zoom = 1;
  private destroyed = false;

  // background rendering
  private bgAbort: AbortController | null = null;
  private bgTimer = 0;
  /** Whole page, rendered once per page: shown blurry while zooming before the crisp render. */
  private quick: Snapshot | null = null;
  /** The last crisp render, reused (transformed) during gestures. */
  private crisp: Snapshot | null = null;

  // input
  private pointerId: number | null = null;
  private mode: Mode | null = null;
  private builder: StrokeBuilder | null = null;
  private liveStyle: { tool: InkTool; color: string; width: number; pressure: boolean } | null = null;
  private erasePrev: { x: number; y: number } | null = null;
  private eraseRemoved = new Map<string, Stroke>();
  private eraseAdded = new Map<string, Stroke>();
  private lassoPts: number[] = [];
  private selection = new Set<string>();
  private selBounds: Bounds | null = null;
  private moveStart: { x: number; y: number } | null = null;
  private moveDelta = { x: 0, y: 0 };
  private hover: { x: number; y: number } | null = null;
  /** Fingers on the full-screen view (pan / pinch). */
  private touches = new Map<number, { x: number; y: number }>();
  private pinch: { dist: number; cx: number; cy: number } | null = null;
  /** Time of the last pen event: touches right after are treated as a resting palm. */
  private lastPenTime = 0;

  private frame = 0;
  private needInk = false;
  private needLive = false;
  private needBgQuick = false;

  constructor(opts: {
    doc: InkDocument;
    page: number;
    background: PageBackground;
    settings: SettingsStore;
    layout: SurfaceLayout;
    /** Show the ink only: no writing, and the page behaves like a picture (reading view). */
    readOnly?: boolean;
    /** Called when undo/redo, the selection or the zoom changes. */
    onState: () => void;
  }) {
    this.doc = opts.doc;
    this.page = opts.page;
    this.background = opts.background;
    this.settings = opts.settings;
    this.layout = opts.layout;
    this.onState = opts.onState;

    this.el = createDiv({ cls: `hwa-surface is-${this.layout}` });
    this.bg = this.layer('hwa-layer-bg');
    this.hl = this.layer('hwa-layer-hl');
    this.ink = this.layer('hwa-layer-ink');
    this.live = this.layer('hwa-layer-live');
    this.overlay = this.layer('hwa-layer-overlay');
    this.applyAspect();

    if (opts.readOnly) {
      // no input at all: clicks, scrolling and text selection around it work as for a normal picture
      this.el.addClass('is-read-only');
    } else {
      this.el.tabIndex = 0;
      this.applyTool();
      this.listenForInput();
      this.cleanups.push(this.settings.on(() => this.applyTool()));
    }

    this.cleanups.push(this.doc.onChange((page) => {
      if (page === null || page === this.page) this.onDocChange();
    }));

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.el);
  }

  private listenForInput(): void {
    this.listen(this.el, 'pointerdown', (e) => this.onDown(e as PointerEvent));
    this.listen(this.el, 'pointermove', (e) => this.onMove(e as PointerEvent));
    this.listen(this.el, 'pointerup', (e) => this.onUp(e as PointerEvent));
    this.listen(this.el, 'pointercancel', (e) => this.onUp(e as PointerEvent));
    this.listen(this.el, 'pointerleave', () => this.setHover(null));
    // Apple Pencil: stop the page from scrolling under the pen; a finger still scrolls.
    this.listen(this.el, 'touchstart', (e) => this.onTouch(e as TouchEvent), { passive: false });
    this.listen(this.el, 'touchmove', (e) => this.onTouch(e as TouchEvent), { passive: false });
    if (this.layout === 'viewport') this.listen(this.el, 'wheel', (e) => this.onWheel(e as WheelEvent), { passive: false });
    // keep clicks from reaching the editor underneath (embeds in notes)
    for (const type of ['mousedown', 'click', 'dblclick', 'contextmenu']) {
      this.listen(this.el, type, (e) => e.stopPropagation());
    }
  }

  get pageNumber(): number {
    return this.page;
  }

  /** Show another page (and its background). */
  setPage(page: number, background: PageBackground): void {
    this.cancelGesture();
    this.clearSelection();
    this.page = page;
    this.background = background;
    this.quick = null;
    this.crisp = null;
    this.zoom = 1;
    this.applyAspect();
    this.resize(true);
    this.onState();
  }

  canUndo(): boolean {
    return this.doc.canUndo(this.page);
  }

  canRedo(): boolean {
    return this.doc.canRedo(this.page);
  }

  undo(): void {
    this.cancelGesture();
    this.clearSelection();
    this.doc.undo(this.page);
  }

  redo(): void {
    this.cancelGesture();
    this.clearSelection();
    this.doc.redo(this.page);
  }

  hasSelection(): boolean {
    return this.selection.size > 0;
  }

  deleteSelection(): void {
    const sel = this.selectedStrokes();
    this.clearSelection();
    if (sel.length) this.doc.apply(this.page, [], sel);
  }

  clearSelection(): void {
    if (!this.selection.size && !this.selBounds) return;
    this.selection.clear();
    this.selBounds = null;
    this.moveStart = null;
    this.moveDelta = { x: 0, y: 0 };
    this.scheduleOverlay();
    this.onState();
  }

  /** Zoom relative to fit width (viewport layout). */
  get zoomLevel(): number {
    return this.zoom;
  }

  /** Zoom by a factor around the view's centre (or a point in CSS px). */
  zoomBy(factor: number, cx = this.cssW / 2, cy = this.cssH / 2): void {
    if (this.layout !== 'viewport') return;
    const base = this.baseScale();
    const z = clamp(this.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const s = base * z;
    const r = s / this.cam.scale;
    this.zoom = z;
    this.cam = { scale: s, ox: cx - (cx - this.cam.ox) * r, oy: cy - (cy - this.cam.oy) * r };
    this.clampCamera();
    this.cameraChanged();
  }

  /** Back to fit width, top of the page. */
  resetZoom(): void {
    if (this.layout !== 'viewport') return;
    this.zoom = 1;
    this.fitCamera();
    this.cameraChanged();
  }

  destroy(): void {
    if (this.destroyed) return;
    // finish a stroke in progress rather than losing it
    if (this.mode) this.finishGesture();
    this.destroyed = true;
    window.cancelAnimationFrame(this.frame);
    window.clearTimeout(this.bgTimer);
    this.bgAbort?.abort();
    this.resizeObserver.disconnect();
    for (const fn of this.cleanups) fn();
    this.el.remove();
  }

  // ---- layout and camera ----

  private layer(cls: string): HTMLCanvasElement {
    return this.el.createEl('canvas', { cls: `hwa-layer ${cls}` });
  }

  private listen(target: EventTarget, type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions): void {
    target.addEventListener(type, fn, opts);
    this.cleanups.push(() => target.removeEventListener(type, fn, opts));
  }

  private applyAspect(): void {
    if (this.layout === 'fit') this.el.style.aspectRatio = `${this.background.width} / ${this.background.height}`;
  }

  private applyTool(): void {
    const tool = this.settings.data.tool;
    if (this.el.dataset.tool !== tool) {
      this.el.dataset.tool = tool;
      if (tool !== 'lasso') this.clearSelection();
      this.setHover(null);
    }
  }

  private baseScale(): number {
    const avail = Math.max(50, this.cssW - 2 * VIEW_MARGIN);
    return Math.min(avail, MAX_BASE_WIDTH) / this.background.width;
  }

  private fitCamera(): void {
    if (this.layout === 'fit') {
      this.cam = { scale: this.cssW / this.background.width, ox: 0, oy: 0 };
      return;
    }
    const s = this.baseScale() * this.zoom;
    this.cam = { scale: s, ox: (this.cssW - this.background.width * s) / 2, oy: VIEW_MARGIN };
    this.clampCamera();
  }

  /** Keep the page reachable: centred when smaller than the view, edges within the margin otherwise. */
  private clampCamera(): void {
    const c = this.cam;
    const pw = this.background.width * c.scale;
    const ph = this.background.height * c.scale;
    c.ox = pw + 2 * VIEW_MARGIN <= this.cssW ? (this.cssW - pw) / 2 : clamp(c.ox, this.cssW - pw - VIEW_MARGIN, VIEW_MARGIN);
    c.oy = ph + 2 * VIEW_MARGIN <= this.cssH ? (this.cssH - ph) / 2 : clamp(c.oy, this.cssH - ph - VIEW_MARGIN, VIEW_MARGIN);
  }

  private resize(force = false): void {
    if (this.destroyed) return;
    const w = this.el.clientWidth;
    const h = this.layout === 'fit' ? w * (this.background.height / this.background.width) : this.el.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (!force && Math.abs(w - this.cssW) < 0.5 && Math.abs(h - this.cssH) < 0.5 && dpr === this.dpr) return;
    if (w < 1 || h < 1) return;
    const first = this.cssW === 0 || force;
    this.cssW = w;
    this.cssH = h;
    this.dpr = dpr;
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));
    for (const c of [this.bg, this.hl, this.ink, this.live, this.overlay]) {
      c.width = pw;
      c.height = ph;
    }
    if (first || this.layout === 'fit') this.fitCamera();
    else this.clampCamera();
    this.drawBackgroundQuick();
    this.renderBackground();
    this.renderInk();
    this.renderLive();
    this.renderOverlay();
  }

  /** The camera moved: redraw now with what we have, render the page crisply when it stops. */
  private cameraChanged(): void {
    this.needInk = true;
    this.needLive = true;
    this.needBgQuick = true;
    this.schedule();
    window.clearTimeout(this.bgTimer);
    this.bgTimer = window.setTimeout(() => this.renderBackground(), 140);
    this.onState();
  }

  private view(): RenderView {
    const d = this.dpr;
    return { k: this.cam.scale * d, ox: this.cam.ox * d, oy: this.cam.oy * d, w: this.bg.width, h: this.bg.height };
  }

  /** Page rectangle in device px for a view. */
  private pageRect(v: RenderView): [number, number, number, number] {
    return [v.ox, v.oy, this.background.width * v.k, this.background.height * v.k];
  }

  /** Paint the paper and whatever page image we already have (scaled), without waiting. */
  private drawBackgroundQuick(): void {
    const ctx = this.bg.getContext('2d');
    if (!ctx) return;
    const v = this.view();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, v.w, v.h);
    const [x, y, w, h] = this.pageRect(v);
    if (this.layout === 'viewport') {
      ctx.shadowColor = 'rgba(0, 0, 0, 0.18)';
      ctx.shadowBlur = 8 * this.dpr;
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x, y, w, h);
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    for (const snap of [this.quick, this.crisp]) {
      if (!snap) continue;
      // scale the snapshot so its page origin lands on the current page origin
      const r = v.k / snap.view.k;
      ctx.drawImage(snap.canvas, v.ox - snap.view.ox * r, v.oy - snap.view.oy * r, snap.canvas.width * r, snap.canvas.height * r);
    }
    ctx.restore();
  }

  /** Render the page crisply for the current camera (async for PDFs; the latest call wins). */
  private renderBackground(): void {
    if (this.destroyed || this.cssW < 1) return;
    this.bgAbort?.abort();
    const abort = new AbortController();
    this.bgAbort = abort;
    const full = this.view();
    // render only the part of the page on screen, unless the whole page is small enough
    const [px, py, pw, ph] = this.pageRect(full);
    const whole = pw * ph <= MAX_SNAPSHOT_AREA;
    const view: RenderView = whole
      ? { k: full.k, ox: 0, oy: 0, w: Math.ceil(pw), h: Math.ceil(ph) }
      : (() => {
          const x0 = Math.max(0, px), y0 = Math.max(0, py);
          const x1 = Math.min(full.w, px + pw), y1 = Math.min(full.h, py + ph);
          return { k: full.k, ox: px - x0, oy: py - y0, w: Math.max(1, Math.ceil(x1 - x0)), h: Math.max(1, Math.ceil(y1 - y0)) };
        })();
    const canvas = createEl('canvas');
    canvas.width = view.w;
    canvas.height = view.h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, view.w, view.h);
    const done = () => {
      if (abort.signal.aborted || this.destroyed) return;
      this.crisp = { canvas, view };
      if (whole && (!this.quick || this.quick.view.k < view.k)) this.quick = this.crisp;
      this.drawBackgroundQuick();
    };
    try {
      const r = this.background.render(ctx, view, abort.signal);
      if (r instanceof Promise) {
        r.then(done, (err) => {
          if (!abort.signal.aborted) console.error('[Handwritten Annotation] could not draw the page', err);
        });
      } else {
        done();
      }
    } catch (err) {
      console.error('[Handwritten Annotation] could not draw the page', err);
    }
  }

  private onDocChange(): void {
    // drop selected strokes that no longer exist (undo, another device)
    if (this.selection.size) {
      const alive = new Set(this.doc.strokes(this.page).map((s) => s.id));
      for (const id of [...this.selection]) if (!alive.has(id)) this.selection.delete(id);
      this.selBounds = this.selection.size ? unionBounds(this.selectedStrokes().map(strokeBounds)) : null;
      this.scheduleOverlay();
    }
    this.needInk = true;
    this.schedule();
    this.onState();
  }

  private schedule(): void {
    if (this.frame || this.destroyed) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = 0;
      if (this.needBgQuick) this.drawBackgroundQuick();
      if (this.needInk) this.renderInk();
      if (this.needLive) {
        this.renderLive();
        this.renderOverlay();
      }
      this.needInk = false;
      this.needLive = false;
      this.needBgQuick = false;
    });
  }

  private scheduleOverlay(): void {
    this.needLive = true;
    this.schedule();
  }

  private beginPageCtx(c: HTMLCanvasElement): CanvasRenderingContext2D | null {
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    const v = this.view();
    ctx.setTransform(v.k, 0, 0, v.k, v.ox, v.oy);
    ctx.beginPath();
    ctx.rect(0, 0, this.background.width, this.background.height);
    ctx.clip();
    return ctx;
  }

  private renderInk(): void {
    const hl = this.beginPageCtx(this.hl);
    const ink = this.beginPageCtx(this.ink);
    if (!hl || !ink) return;
    const moving = this.mode === 'move' ? this.moveDelta : null;
    for (const s of this.doc.strokes(this.page)) {
      const ctx = s.tool === 'highlighter' ? hl : ink;
      ctx.fillStyle = s.color;
      if (moving && this.selection.has(s.id)) {
        ctx.save();
        ctx.translate(moving.x, moving.y);
        ctx.fill(strokePath(s), 'nonzero');
        ctx.restore();
      } else {
        ctx.fill(strokePath(s), 'nonzero');
      }
    }
  }

  private renderLive(): void {
    const ctx = this.beginPageCtx(this.live);
    if (!ctx) return;
    const style = this.liveStyle;
    if (this.mode !== 'draw' || !this.builder || !style) return;
    const path = new Path2D();
    outlinePoints(style, densify(this.builder.pts, segmentLength(style)), path);
    ctx.fillStyle = style.color;
    ctx.fill(path, 'nonzero');
  }

  private renderOverlay(): void {
    const ctx = this.beginPageCtx(this.overlay);
    if (!ctx) return;
    const px = 1 / this.cam.scale; // one CSS pixel in page units
    const accent = getComputedStyle(this.el).getPropertyValue('--interactive-accent').trim() || '#7c3aed';
    if (this.mode === 'lasso' && this.lassoPts.length >= 4) {
      ctx.beginPath();
      ctx.moveTo(this.lassoPts[0], this.lassoPts[1]);
      for (let i = 2; i < this.lassoPts.length; i += 2) ctx.lineTo(this.lassoPts[i], this.lassoPts[i + 1]);
      ctx.closePath();
      ctx.fillStyle = 'rgba(124, 58, 237, 0.06)';
      ctx.fill();
      ctx.setLineDash([5 * px, 4 * px]);
      ctx.lineWidth = 1.25 * px;
      ctx.strokeStyle = accent;
      ctx.stroke();
    }
    if (this.selBounds) {
      const b = this.selBounds;
      const pad = SELECTION_PAD_PX * px;
      const d = this.mode === 'move' ? this.moveDelta : { x: 0, y: 0 };
      ctx.setLineDash([6 * px, 4 * px]);
      ctx.lineWidth = 1.25 * px;
      ctx.strokeStyle = accent;
      ctx.strokeRect(b.minX - pad + d.x, b.minY - pad + d.y, b.maxX - b.minX + 2 * pad, b.maxY - b.minY + 2 * pad);
    }
    if (this.hover && this.settings.data.tool === 'eraser') {
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(this.hover.x, this.hover.y, this.settings.data.eraser.size, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.fill();
      ctx.lineWidth = 1 * px;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.stroke();
    }
  }

  // ---- input ----

  private local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.el.getBoundingClientRect();
    // the element can be scaled by CSS (e.g. a zoomed-out canvas); correct for that
    const sx = this.cssW ? r.width / this.cssW : 1;
    const sy = this.cssH ? r.height / this.cssH : 1;
    return { x: (e.clientX - r.left) / sx, y: (e.clientY - r.top) / sy };
  }

  private toPage(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const l = this.local(e);
    return { x: (l.x - this.cam.ox) / this.cam.scale, y: (l.y - this.cam.oy) / this.cam.scale };
  }

  private inPage(p: { x: number; y: number }): boolean {
    return p.x >= 0 && p.y >= 0 && p.x <= this.background.width && p.y <= this.background.height;
  }

  private onTouch(e: TouchEvent): void {
    const stylus = Array.from(e.changedTouches).some((t) => (t as Touch & { touchType?: string }).touchType === 'stylus');
    // full screen: we pan and zoom ourselves. Embed: a pen touch, or a palm while the pen writes, must not scroll.
    if (this.layout === 'viewport' || stylus || this.pointerId !== null || performance.now() - this.lastPenTime < 400) {
      e.preventDefault();
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.cssH : 1;
    if (e.ctrlKey || e.metaKey) {
      // trackpad pinch arrives as ctrl + wheel
      const l = this.local(e);
      this.zoomBy(Math.exp((-e.deltaY * unit) / 300), l.x, l.y);
    } else {
      this.cam.ox -= (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * unit;
      this.cam.oy -= (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * unit;
      this.clampCamera();
      this.cameraChanged();
    }
  }

  private onDown(e: PointerEvent): void {
    if (e.pointerType === 'pen') this.lastPenTime = performance.now();
    if (e.pointerType === 'touch' && !this.settings.data.fingerDraw) {
      if (this.layout === 'viewport' && this.pointerId === null) this.touchDown(e);
      return;
    }
    if (this.pointerId !== null) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const p = this.toPage(e);
    if (!this.inPage(p)) return;
    // the pen takes over: stop any finger pan
    this.touches.clear();
    this.pinch = null;
    e.preventDefault();
    e.stopPropagation();
    capture(this.el, e.pointerId);
    this.pointerId = e.pointerId;
    this.el.focus({ preventScroll: true });

    const s = this.settings.data;
    switch (s.tool) {
      case 'pen':
      case 'highlighter': {
        const style = s.tool === 'pen' ? s.pen : s.highlighter;
        const pressure = e.pointerType === 'pen' && s.tool === 'pen';
        this.mode = 'draw';
        this.liveStyle = { tool: s.tool, color: style.color, width: style.width, pressure };
        this.live.classList.toggle('hwa-layer-hl', s.tool === 'highlighter');
        this.builder = new StrokeBuilder(this.cam.scale, pressure);
        this.addSamples(e);
        break;
      }
      case 'eraser':
        this.mode = 'erase';
        this.eraseRemoved.clear();
        this.eraseAdded.clear();
        this.erasePrev = p;
        this.eraseAlong(p);
        this.setHover(p);
        break;
      case 'lasso':
        if (this.selBounds && this.inSelection(p)) {
          this.mode = 'move';
          this.moveStart = p;
          this.moveDelta = { x: 0, y: 0 };
        } else {
          this.clearSelection();
          this.mode = 'lasso';
          this.lassoPts = [p.x, p.y];
        }
        break;
    }
    this.scheduleOverlay();
  }

  private onMove(e: PointerEvent): void {
    if (e.pointerType === 'pen') this.lastPenTime = performance.now();
    if (this.touches.has(e.pointerId)) {
      this.touchMove(e);
      return;
    }
    if (this.pointerId === null) {
      // hovering mouse or pen: show the eraser ring
      if (this.settings.data.tool === 'eraser' && e.pointerType !== 'touch') this.setHover(this.toPage(e));
      return;
    }
    if (e.pointerId !== this.pointerId) return;
    e.preventDefault();
    switch (this.mode) {
      case 'draw':
        this.addSamples(e);
        break;
      case 'erase':
        for (const ev of coalesced(e)) {
          const p = this.toPage(ev);
          this.eraseAlong(p);
          this.hover = p;
        }
        break;
      case 'lasso':
        for (const ev of coalesced(e)) {
          const p = this.toPage(ev);
          const n = this.lassoPts.length;
          if (Math.hypot(p.x - this.lassoPts[n - 2], p.y - this.lassoPts[n - 1]) * this.cam.scale >= 2) this.lassoPts.push(p.x, p.y);
        }
        break;
      case 'move': {
        const p = this.toPage(e);
        if (!this.moveStart || !this.selBounds) break;
        const b = this.selBounds;
        // keep the selection on the page
        const dx = clamp(p.x - this.moveStart.x, Math.min(0, -b.minX), Math.max(0, this.background.width - b.maxX));
        const dy = clamp(p.y - this.moveStart.y, Math.min(0, -b.minY), Math.max(0, this.background.height - b.maxY));
        this.moveDelta = { x: dx, y: dy };
        this.needInk = true;
        break;
      }
    }
    this.scheduleOverlay();
  }

  private onUp(e: PointerEvent): void {
    if (this.touches.has(e.pointerId)) {
      this.touches.delete(e.pointerId);
      this.pinch = null;
      this.resetPinch();
      return;
    }
    if (e.pointerId !== this.pointerId) return;
    if (e.pointerType === 'pen') this.lastPenTime = performance.now();
    if (e.type === 'pointerup' && this.mode === 'draw') this.addSamples(e);
    this.finishGesture();
    try {
      if (this.el.hasPointerCapture(e.pointerId)) this.el.releasePointerCapture(e.pointerId);
    } catch {
      // already released
    }
  }

  // ---- finger pan / pinch (full-screen view) ----

  private touchDown(e: PointerEvent): void {
    // a palm right after the pen: ignore
    if (performance.now() - this.lastPenTime < 400) return;
    if (this.touches.size >= 2) return;
    capture(this.el, e.pointerId);
    this.touches.set(e.pointerId, this.local(e));
    this.resetPinch();
  }

  private resetPinch(): void {
    const pts = [...this.touches.values()];
    if (pts.length === 2) {
      this.pinch = {
        dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
        cx: (pts[0].x + pts[1].x) / 2,
        cy: (pts[0].y + pts[1].y) / 2,
      };
    } else {
      this.pinch = null;
    }
  }

  private touchMove(e: PointerEvent): void {
    const prev = this.touches.get(e.pointerId);
    if (!prev) return;
    const cur = this.local(e);
    this.touches.set(e.pointerId, cur);
    if (this.touches.size === 1) {
      this.cam.ox += cur.x - prev.x;
      this.cam.oy += cur.y - prev.y;
      this.clampCamera();
      this.cameraChanged();
      return;
    }
    const pts = [...this.touches.values()];
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    const cx = (pts[0].x + pts[1].x) / 2;
    const cy = (pts[0].y + pts[1].y) / 2;
    if (this.pinch && this.pinch.dist > 0) {
      this.cam.ox += cx - this.pinch.cx;
      this.cam.oy += cy - this.pinch.cy;
      this.zoomBy(dist / this.pinch.dist, cx, cy);
    }
    this.pinch = { dist, cx, cy };
  }

  // ---- strokes, eraser, lasso ----

  private addSamples(e: PointerEvent): void {
    if (!this.builder) return;
    for (const ev of coalesced(e)) {
      const p = this.toPage(ev);
      const pressure = ev.pointerType === 'pen' ? ev.pressure || 0.5 : 0.5;
      this.builder.add({ x: p.x, y: p.y, p: pressure, t: ev.timeStamp });
    }
  }

  private finishGesture(): void {
    const mode = this.mode;
    this.mode = null;
    this.pointerId = null;
    if (mode === 'draw' && this.builder && this.liveStyle) {
      const pts = this.builder.finish();
      const st = this.liveStyle;
      this.builder = null;
      this.liveStyle = null;
      if (pts.length >= 3) {
        const stroke = makeStroke(newStrokeId(this.doc.deviceId), st.tool, st.color, st.width, st.pressure, pts.slice(), Date.now());
        this.doc.apply(this.page, [stroke], []);
        // draw it on the ink layer right away so nothing flickers before the next frame
        this.renderInk();
        this.needInk = false;
      }
      this.renderLive();
    } else if (mode === 'erase') {
      this.doc.pushHistory(this.page, { added: [...this.eraseAdded.values()], removed: [...this.eraseRemoved.values()] });
      this.eraseAdded.clear();
      this.eraseRemoved.clear();
      this.erasePrev = null;
    } else if (mode === 'lasso') {
      const ids = lassoSelect(this.doc.strokes(this.page), this.lassoPts);
      this.lassoPts = [];
      this.selection = new Set(ids);
      this.selBounds = ids.length ? unionBounds(this.selectedStrokes().map(strokeBounds)) : null;
      this.onState();
    } else if (mode === 'move') {
      const { x: dx, y: dy } = this.moveDelta;
      this.moveStart = null;
      this.moveDelta = { x: 0, y: 0 };
      if (Math.abs(dx) + Math.abs(dy) > 0.01) {
        const originals = this.selectedStrokes();
        const moved = originals.map((s) => translateStroke(s, dx, dy, newStrokeId(this.doc.deviceId)));
        this.selection = new Set(moved.map((s) => s.id));
        this.doc.apply(this.page, moved, originals);
        this.selBounds = unionBounds(moved.map(strokeBounds));
      } else {
        this.needInk = true;
      }
    }
    this.scheduleOverlay();
  }

  private cancelGesture(): void {
    if (this.mode === 'erase') {
      // keep what was erased, as one undo step
      this.finishGesture();
      return;
    }
    this.mode = null;
    this.pointerId = null;
    this.builder = null;
    this.liveStyle = null;
    this.lassoPts = [];
    this.renderLive();
    this.scheduleOverlay();
  }

  /** Erase along the segment from the previous eraser position to p. */
  private eraseAlong(p: { x: number; y: number }): void {
    const a = this.erasePrev ?? p;
    this.erasePrev = p;
    const r = this.settings.data.eraser.size;
    const partial = this.settings.data.eraser.mode === 'partial';
    const added: Stroke[] = [];
    const removed: Stroke[] = [];
    for (const s of this.doc.strokes(this.page)) {
      if (partial) {
        const pieces = eraseFromStroke(s, a.x, a.y, p.x, p.y, r);
        if (pieces === null) continue;
        removed.push(s);
        for (const pts of pieces) added.push({ ...s, id: newStrokeId(this.doc.deviceId), pts });
      } else if (strokeTouched(s, a.x, a.y, p.x, p.y, r)) {
        removed.push(s);
      }
    }
    if (!removed.length) return;
    for (const s of removed) {
      // a piece made earlier in this same drag isn't an original
      if (this.eraseAdded.has(s.id)) this.eraseAdded.delete(s.id);
      else this.eraseRemoved.set(s.id, s);
    }
    for (const s of added) this.eraseAdded.set(s.id, s);
    this.doc.apply(this.page, added, removed, false);
  }

  private inSelection(p: { x: number; y: number }): boolean {
    const b = this.selBounds;
    if (!b) return false;
    const pad = SELECTION_PAD_PX / this.cam.scale;
    return p.x >= b.minX - pad && p.x <= b.maxX + pad && p.y >= b.minY - pad && p.y <= b.maxY + pad;
  }

  private selectedStrokes(): Stroke[] {
    return this.doc.strokes(this.page).filter((s) => this.selection.has(s.id));
  }

  private setHover(p: { x: number; y: number } | null): void {
    if (!p && !this.hover) return;
    this.hover = p;
    this.scheduleOverlay();
  }
}

/** Keep receiving this pointer's events even outside the element (fails harmlessly if the pointer is gone). */
function capture(el: HTMLElement, pointerId: number): void {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    // the pointer already lifted
  }
}

function coalesced(e: PointerEvent): PointerEvent[] {
  const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
  return list.length ? list : [e];
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
