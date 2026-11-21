import { App, Modal, Platform, Setting } from 'obsidian';
import type { InkDocument } from '../model/document.ts';
import type { SettingsStore } from '../settings.ts';
import { InkSurface, type PageBackground, type SurfaceLayout } from './surface.ts';
import { Toolbar } from './toolbar.ts';

/** Pages to annotate: a PDF, an image (one page) or blank paper. */
export interface PageSource {
  readonly pageCount: number;
  page(n: number): Promise<PageBackground>;
}

export interface AnnotatorOptions {
  app: App;
  doc: InkDocument;
  source: PageSource;
  settings: SettingsStore;
  startPage: number;
  layout: SurfaceLayout;
  /** Show the ink but don't write (reading view). */
  readOnly?: boolean;
  openFull?: (page: number) => void;
  onPageChange?: (page: number) => void;
}

/** Toolbar + one writable page + page navigation. Used in embeds and in the full-screen view. */
export class Annotator {
  readonly el: HTMLDivElement;
  private readonly opts: AnnotatorOptions;
  private readonly toolbar: Toolbar;
  private readonly stage: HTMLDivElement;
  private surface: InkSurface | null = null;
  private page: number;
  private loadToken = 0;
  private destroyed = false;

  constructor(parent: HTMLElement, opts: AnnotatorOptions) {
    this.opts = opts;
    this.page = clampPage(opts.startPage, opts.source.pageCount);
    this.el = parent.createDiv({ cls: `hwa-annotator is-${opts.layout}` });
    if (opts.readOnly) this.el.addClass('is-read-only');
    if (Platform.isPhone) this.el.addClass('is-phone');
    this.toolbar = new Toolbar(opts.settings, {
      readOnly: opts.readOnly === true,
      undo: () => this.surface?.undo(),
      redo: () => this.surface?.redo(),
      canUndo: () => this.surface?.canUndo() ?? false,
      canRedo: () => this.surface?.canRedo() ?? false,
      hasSelection: () => this.surface?.hasSelection() ?? false,
      deleteSelection: () => this.surface?.deleteSelection(),
      pages: {
        current: () => this.page,
        count: () => this.opts.source.pageCount,
        go: (p) => void this.goTo(p),
        ask: () => this.askPage(),
      },
      openFull: opts.openFull ? () => opts.openFull?.(this.page) : undefined,
      zoom: opts.layout === 'viewport'
        ? {
            level: () => this.surface?.zoomLevel ?? 1,
            zoomIn: () => this.surface?.zoomBy(1.25),
            zoomOut: () => this.surface?.zoomBy(0.8),
            reset: () => this.surface?.resetZoom(),
          }
        : undefined,
    });
    this.el.appendChild(this.toolbar.el);
    this.stage = this.el.createDiv({ cls: 'hwa-stage' });
    this.el.addEventListener('keydown', (e) => this.onKey(e));
    void this.goTo(this.page, true);
  }

  get currentPage(): number {
    return this.page;
  }

  async goTo(page: number, first = false): Promise<void> {
    page = clampPage(page, this.opts.source.pageCount);
    if (page === this.page && !first) return;
    const token = ++this.loadToken;
    this.page = page;
    this.toolbar.render();
    let bg: PageBackground;
    try {
      bg = await this.opts.source.page(page);
    } catch (err) {
      console.error('[Handwritten Annotation] could not load page', page, err);
      if (token === this.loadToken) this.showError(`Could not load page ${page}.`);
      return;
    }
    if (token !== this.loadToken || this.destroyed) return;
    this.stage.querySelector('.hwa-error')?.remove();
    if (this.surface) {
      this.surface.setPage(page, bg);
    } else {
      this.surface = new InkSurface({
        doc: this.opts.doc,
        page,
        background: bg,
        settings: this.opts.settings,
        layout: this.opts.layout,
        readOnly: this.opts.readOnly === true,
        onState: () => this.toolbar.render(),
      });
      this.stage.appendChild(this.surface.el);
    }
    this.toolbar.render();
    if (!first) this.opts.onPageChange?.(page);
  }

  destroy(): void {
    this.destroyed = true;
    this.surface?.destroy();
    this.toolbar.destroy();
    this.el.remove();
  }

  private showError(text: string): void {
    this.stage.querySelector('.hwa-error')?.remove();
    this.stage.createDiv({ cls: 'hwa-error', text });
  }

  private askPage(): void {
    new PagePrompt(this.opts.app, this.opts.source.pageCount, this.page, (p) => void this.goTo(p)).open();
  }

  private onKey(e: KeyboardEvent): void {
    const s = this.surface;
    if (!s || this.opts.readOnly) return;
    const mod = Platform.isMacOS ? e.metaKey : e.ctrlKey;
    let handled = true;
    if (mod && e.key.toLowerCase() === 'z') {
      if (e.shiftKey) s.redo();
      else s.undo();
    } else if (mod && e.key.toLowerCase() === 'y') {
      s.redo();
    } else if ((e.key === 'Backspace' || e.key === 'Delete') && s.hasSelection()) {
      s.deleteSelection();
    } else if (e.key === 'Escape' && s.hasSelection()) {
      s.clearSelection();
    } else if (this.opts.layout === 'viewport' && !mod && (e.key === 'ArrowLeft' || e.key === 'PageUp')) {
      void this.goTo(this.page - 1);
    } else if (this.opts.layout === 'viewport' && !mod && (e.key === 'ArrowRight' || e.key === 'PageDown')) {
      void this.goTo(this.page + 1);
    } else {
      handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }
}

function clampPage(p: number, count: number): number {
  if (!Number.isFinite(p)) return 1;
  return Math.min(Math.max(1, Math.round(p)), Math.max(1, count));
}

class PagePrompt extends Modal {
  private readonly count: number;
  private value: number;
  private readonly done: (page: number) => void;

  constructor(app: App, count: number, current: number, done: (page: number) => void) {
    super(app);
    this.count = count;
    this.value = current;
    this.done = done;
  }

  onOpen(): void {
    this.setTitle('Go to page');
    const submit = () => {
      this.close();
      this.done(this.value);
    };
    new Setting(this.contentEl).setName(`Page (1–${this.count})`).addText((t) => {
      t.inputEl.type = 'number';
      t.inputEl.min = '1';
      t.inputEl.max = String(this.count);
      t.setValue(String(this.value));
      t.onChange((v) => { this.value = Number(v); });
      t.inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      window.setTimeout(() => t.inputEl.select(), 0);
    });
    new Setting(this.contentEl).addButton((b) => b.setButtonText('Go').setCta().onClick(submit));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
