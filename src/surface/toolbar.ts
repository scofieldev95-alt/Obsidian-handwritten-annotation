import { setIcon } from 'obsidian';
import type { Tool } from '../ink/types.ts';
import { ERASER_SIZES, HIGHLIGHTER_WIDTHS, PEN_WIDTHS, type SettingsStore } from '../settings.ts';

export interface ToolbarActions {
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  hasSelection(): boolean;
  deleteSelection(): void;
  /** Page navigation; omitted for single-page files. */
  pages?: {
    current(): number;
    count(): number;
    go(page: number): void;
    ask(): void;
  };
  /** Open full screen; omitted where we already are full screen. */
  openFull?: () => void;
  /** View only (reading view): just page navigation and full screen, no tools. */
  readOnly?: boolean;
  /** Zoom controls (full-screen view only). */
  zoom?: {
    level(): number;
    zoomIn(): void;
    zoomOut(): void;
    reset(): void;
  };
}

const TOOL_BUTTONS: { tool: Tool; icon: string; label: string }[] = [
  { tool: 'pen', icon: 'pen-line', label: 'Pen' },
  { tool: 'highlighter', icon: 'highlighter', label: 'Highlighter' },
  { tool: 'eraser', icon: 'eraser', label: 'Eraser' },
  { tool: 'lasso', icon: 'lasso', label: 'Lasso (select and move)' },
];

/** The compact toolbar above every annotated page. Rebuilt whenever the state changes. */
export class Toolbar {
  readonly el: HTMLDivElement;
  private readonly settings: SettingsStore;
  private readonly actions: ToolbarActions;
  private readonly off: () => void;

  constructor(settings: SettingsStore, actions: ToolbarActions) {
    this.settings = settings;
    this.actions = actions;
    this.el = createDiv({ cls: 'hwa-toolbar' });
    // the toolbar is a normal UI: never let clicks reach the editor underneath
    for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick']) {
      this.el.addEventListener(type, (e) => e.stopPropagation());
    }
    this.off = settings.on(() => this.render());
    this.render();
  }

  destroy(): void {
    this.off();
    this.el.remove();
  }

  render(): void {
    const s = this.settings.data;
    this.el.empty();
    const readOnly = this.actions.readOnly === true;
    const multiPage = (this.actions.pages?.count() ?? 1) > 1;
    // reading view: nothing to show for a single page, so no bar at all
    this.el.toggleClass('hwa-toolbar-hidden', readOnly && !multiPage);
    this.el.toggleClass('is-read-only', readOnly);
    if (readOnly) {
      this.el.createDiv({ cls: 'hwa-spacer' });
      this.renderNavigation();
      return;
    }

    const tools = group(this.el, 'hwa-tools');
    for (const b of TOOL_BUTTONS) {
      button(tools, b.icon, b.label, () => this.settings.update((d) => { d.tool = b.tool; }), s.tool === b.tool);
    }

    const opts = group(this.el, 'hwa-options');
    if (s.tool === 'pen' || s.tool === 'highlighter') {
      const isPen = s.tool === 'pen';
      const current = isPen ? s.pen : s.highlighter;
      const palette = isPen ? s.penColors : s.highlighterColors;
      for (const color of palette) {
        const sw = opts.createEl('button', { cls: 'hwa-swatch', attr: { 'aria-label': color } });
        sw.style.setProperty('--hwa-swatch', color);
        if (color.toLowerCase() === current.color.toLowerCase()) sw.addClass('is-active');
        sw.addEventListener('click', () => this.settings.update((d) => { (isPen ? d.pen : d.highlighter).color = color; }));
      }
      const custom = opts.createEl('label', { cls: 'hwa-swatch hwa-swatch-custom', attr: { 'aria-label': 'Custom colour' } });
      if (!palette.some((c) => c.toLowerCase() === current.color.toLowerCase())) {
        custom.addClass('is-active');
        custom.style.setProperty('--hwa-swatch', current.color);
      }
      const input = custom.createEl('input', { type: 'color' });
      input.value = current.color;
      input.addEventListener('change', () => this.settings.update((d) => { (isPen ? d.pen : d.highlighter).color = input.value; }));
      sep(opts);
      const widths = isPen ? PEN_WIDTHS : HIGHLIGHTER_WIDTHS;
      widths.forEach((w, i) => {
        const b = opts.createEl('button', { cls: 'hwa-size', attr: { 'aria-label': ['Thin', 'Medium', 'Thick'][i] } });
        b.createDiv({ cls: 'hwa-size-dot' }).style.setProperty('--hwa-size', `${4 + i * 4}px`);
        if (current.width === w) b.addClass('is-active');
        b.addEventListener('click', () => this.settings.update((d) => { (isPen ? d.pen : d.highlighter).width = w; }));
      });
    } else if (s.tool === 'eraser') {
      const seg = opts.createDiv({ cls: 'hwa-segmented' });
      for (const [mode, label] of [['stroke', 'Whole stroke'], ['partial', 'Partial']] as const) {
        const b = seg.createEl('button', { text: label });
        if (s.eraser.mode === mode) b.addClass('is-active');
        b.addEventListener('click', () => this.settings.update((d) => { d.eraser.mode = mode; }));
      }
      sep(opts);
      ERASER_SIZES.forEach((size, i) => {
        const b = opts.createEl('button', { cls: 'hwa-size', attr: { 'aria-label': ['Small', 'Medium', 'Large'][i] + ' eraser' } });
        b.createDiv({ cls: 'hwa-size-dot is-ring' }).style.setProperty('--hwa-size', `${6 + i * 5}px`);
        if (s.eraser.size === size) b.addClass('is-active');
        b.addEventListener('click', () => this.settings.update((d) => { d.eraser.size = size; }));
      });
    } else if (s.tool === 'lasso') {
      const del = button(opts, 'trash-2', 'Delete selection', () => this.actions.deleteSelection());
      del.disabled = !this.actions.hasSelection();
      if (!this.actions.hasSelection()) opts.createSpan({ cls: 'hwa-hint', text: 'Draw a loop around ink' });
    }

    this.el.createDiv({ cls: 'hwa-spacer' });

    const hist = group(this.el, 'hwa-history');
    button(hist, 'undo-2', 'Undo', () => this.actions.undo()).disabled = !this.actions.canUndo();
    button(hist, 'redo-2', 'Redo', () => this.actions.redo()).disabled = !this.actions.canRedo();

    this.renderNavigation();
  }

  /** Page arrows, zoom and full screen: shown in every mode. */
  private renderNavigation(): void {
    const pages = this.actions.pages;
    if (pages && pages.count() > 1) {
      const nav = group(this.el, 'hwa-pages');
      const cur = pages.current();
      button(nav, 'chevron-left', 'Previous page', () => pages.go(cur - 1)).disabled = cur <= 1;
      const label = nav.createEl('button', { cls: 'hwa-page-label', text: `${cur} / ${pages.count()}`, attr: { 'aria-label': 'Go to page…' } });
      label.addEventListener('click', () => pages.ask());
      button(nav, 'chevron-right', 'Next page', () => pages.go(cur + 1)).disabled = cur >= pages.count();
    }

    const zoom = this.actions.zoom;
    if (zoom) {
      const z = group(this.el, 'hwa-zoom');
      button(z, 'zoom-out', 'Zoom out', () => zoom.zoomOut());
      const pct = z.createEl('button', { cls: 'hwa-page-label', text: `${Math.round(zoom.level() * 100)}%`, attr: { 'aria-label': 'Fit width' } });
      pct.addEventListener('click', () => zoom.reset());
      button(z, 'zoom-in', 'Zoom in', () => zoom.zoomIn());
    }

    if (this.actions.openFull) {
      const full = group(this.el, 'hwa-full');
      const open = this.actions.openFull;
      button(full, 'maximize-2', 'Open full screen', () => open());
    }
  }
}

function group(parent: HTMLElement, cls: string): HTMLDivElement {
  return parent.createDiv({ cls: `hwa-group ${cls}` });
}

function sep(parent: HTMLElement): void {
  parent.createDiv({ cls: 'hwa-sep' });
}

function button(parent: HTMLElement, icon: string, label: string, onClick: () => void, active = false): HTMLButtonElement {
  const b = parent.createEl('button', { cls: 'hwa-btn clickable-icon', attr: { 'aria-label': label } });
  setIcon(b, icon);
  if (active) b.addClass('is-active');
  b.addEventListener('click', onClick);
  return b;
}
