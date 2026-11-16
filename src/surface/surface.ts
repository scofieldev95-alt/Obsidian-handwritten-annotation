import { StrokeBuilder, makeStroke } from '../ink/builder.ts';
import { densify, outlinePoints, outlineStroke, segmentLength, strokeBounds, unionBounds } from '../ink/geometry.ts';
import { eraseFromStroke, lassoSelect, strokeTouched, translateStroke } from '../ink/hit.ts';
import type { Bounds, InkTool, Stroke } from '../ink/types.ts';
import type { InkDocument } from '../model/document.ts';
import { newStrokeId } from '../model/ids.ts';
import type { SettingsStore } from '../settings.ts';

/** What sits under the ink: a PDF page, an image, or blank paper. */
export interface PageBackground {
  /** Page size in page units. */
  readonly width: number;
  readonly height: number;
  /**
   * Paint the page. `ctx` is already scaled so 1 unit = 1 page unit; `pxPerUnit` is the number of
   * device pixels per page unit (for choosing a render resolution).
   */
  draw(ctx: CanvasRenderingContext2D, pxPerUnit: number): void | Promise<void>;
}

type Mode = 'draw' | 'erase' | 'lasso' | 'move';

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

/**
 * One writable page: the background, the ink, and pointer input. The ink is drawn with the page
 * at the element's width; all coordinates stored are page units.
 */
export class InkSurface {
  readonly el: HTMLDivElement;
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
  private bgToken = 0;
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  private destroyed = false;

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
  private frame = 0;
  private needInk = false;
  private needLive = false;
  /** Time of the last pen event: touches right after are treated as a resting palm. */
  private lastPenTime = 0;

  constructor(opts: {
    doc: InkDocument;
    page: number;
    background: PageBackground;
    settings: SettingsStore;
    /** Called when undo/redo availability or the selection changes. */
    onState: () => void;
  }) {
    this.doc = opts.doc;
    this.page = opts.page;
    this.background = opts.background;
    this.settings = opts.settings;
    this.onState = opts.onState;

    this.el = document.createElement('div');
    this.el.className = 'hwa-surface';
    this.el.tabIndex = 0;
    this.bg = this.layer('hwa-layer-bg');
    this.hl = this.layer('hwa-layer-hl');
    this.ink = this.layer('hwa-layer-ink');
    this.live = this.layer('hwa-layer-live');
    this.overlay = this.layer('hwa-layer-overlay');
    this.applyAspect();
    this.applyTool();

    this.listen(this.el, 'pointerdown', (e) => this.onDown(e as PointerEvent));
    this.listen(this.el, 'pointermove', (e) => this.onMove(e as PointerEvent));
    this.listen(this.el, 'pointerup', (e) => this.onUp(e as PointerEvent));
    this.listen(this.el, 'pointercancel', (e) => this.onUp(e as PointerEvent));
    this.listen(this.el, 'pointerleave', () => this.setHover(null));
    // Apple Pencil: stop the page from scrolling under the pen; a finger still scrolls.
    this.listen(this.el, 'touchstart', (e) => this.onTouch(e as TouchEvent), { passive: false });
    this.listen(this.el, 'touchmove', (e) => this.onTouch(e as TouchEvent), { passive: false });
    // keep clicks from reaching the editor underneath (embeds in notes)
    for (const type of ['mousedown', 'click', 'dblclick', 'contextmenu']) {
      this.listen(this.el, type, (e) => e.stopPropagation());
    }

    this.cleanups.push(this.doc.onChange((page) => {
      if (page === null || page === this.page) this.onDocChange();
    }));
    this.cleanups.push(this.settings.on(() => this.applyTool()));

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.el);
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

  destroy(): void {
    if (this.destroyed) return;
    // finish a stroke in progress rather than losing it
    if (this.mode) this.finishGesture();
    this.destroyed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    for (const fn of this.cleanups) fn();
    this.el.remove();
  }

  // ---- layout and rendering ----

  private layer(cls: string): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.className = `hwa-layer ${cls}`;
    this.el.appendChild(c);
    return c;
  }

  private listen(target: EventTarget, type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions): void {
    target.addEventListener(type, fn, opts);
    this.cleanups.push(() => target.removeEventListener(type, fn, opts));
  }

  private applyAspect(): void {
    this.el.style.aspectRatio = `${this.background.width} / ${this.background.height}`;
  }

  private applyTool(): void {
    const tool = this.settings.data.tool;
    if (this.el.dataset.tool !== tool) {
      this.el.dataset.tool = tool;
      if (tool !== 'lasso') this.clearSelection();
      this.setHover(null);
    }
  }

  /** Page units → CSS px. */
  private get scale(): number {
    return this.cssW / this.background.width;
  }

  private resize(force = false): void {
    if (this.destroyed) return;
    const w = this.el.clientWidth;
    const h = w * (this.background.height / this.background.width);
    const dpr = window.devicePixelRatio || 1;
    if (!force && Math.abs(w - this.cssW) < 0.5 && Math.abs(h - this.cssH) < 0.5 && dpr === this.dpr) return;
    if (w < 1) return;
    this.cssW = w;
    this.cssH = h;
    this.dpr = dpr;
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));
    for (const c of [this.bg, this.hl, this.ink, this.live, this.overlay]) {
      c.width = pw;
      c.height = ph;
    }
    void this.drawBackground();
    this.renderInk();
    this.renderLive();
    this.renderOverlay();
  }

  private async drawBackground(): Promise<void> {
    const token = ++this.bgToken;
    const ctx = this.bg.getContext('2d');
    if (!ctx) return;
    const k = this.dpr * this.scale;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, this.bg.width, this.bg.height);
    ctx.setTransform(k, 0, 0, k, 0, 0);
    try {
      await this.background.draw(ctx, k);
    } catch (err) {
      if (token === this.bgToken) console.error('[Handwritten Annotation] could not draw the page', err);
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
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.needInk) this.renderInk();
      if (this.needLive) {
        this.renderLive();
        this.renderOverlay();
      }
      this.needInk = false;
      this.needLive = false;
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
    const k = this.dpr * this.scale;
    ctx.setTransform(k, 0, 0, k, 0, 0);
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
    const px = 1 / this.scale; // one CSS pixel in page units
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

  private toPage(e: PointerEvent): { x: number; y: number } {
    const r = this.el.getBoundingClientRect();
    const k = r.width / this.background.width;
    return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k };
  }

  private inPage(p: { x: number; y: number }): boolean {
    return p.x >= 0 && p.y >= 0 && p.x <= this.background.width && p.y <= this.background.height;
  }

  private onTouch(e: TouchEvent): void {
    const stylus = Array.from(e.changedTouches).some((t) => (t as Touch & { touchType?: string }).touchType === 'stylus');
    // a pen touch, or a palm resting while the pen writes: don't scroll
    if (stylus || this.pointerId !== null || performance.now() - this.lastPenTime < 400) e.preventDefault();
  }

  private onDown(e: PointerEvent): void {
    if (e.pointerType === 'pen') this.lastPenTime = performance.now();
    if (this.pointerId !== null) return;
    if (e.pointerType === 'touch' && !this.settings.data.fingerDraw) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const p = this.toPage(e);
    if (!this.inPage(p)) return;
    e.preventDefault();
    e.stopPropagation();
    this.el.setPointerCapture(e.pointerId);
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
        this.builder = new StrokeBuilder(this.scale, pressure);
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
          if (Math.hypot(p.x - this.lassoPts[n - 2], p.y - this.lassoPts[n - 1]) * this.scale >= 2) this.lassoPts.push(p.x, p.y);
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
    if (e.pointerId !== this.pointerId) return;
    if (e.pointerType === 'pen') this.lastPenTime = performance.now();
    if (e.type === 'pointerup' && this.mode === 'draw') this.addSamples(e);
    this.finishGesture();
    if (this.el.hasPointerCapture(e.pointerId)) this.el.releasePointerCapture(e.pointerId);
  }

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
        // draw it on the ink layer right away so nothing flickers before the next frame
        this.doc.apply(this.page, [stroke], []);
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
    const pad = SELECTION_PAD_PX / this.scale;
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

function coalesced(e: PointerEvent): PointerEvent[] {
  const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
  return list.length ? list : [e];
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
