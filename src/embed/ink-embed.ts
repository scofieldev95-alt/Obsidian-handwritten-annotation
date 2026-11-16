import { Component, type App, type TFile } from 'obsidian';
import type HandwrittenAnnotationPlugin from '../main.ts';
import type { PageSource } from '../surface/annotator.ts';
import { Annotator } from '../surface/annotator.ts';

/** What Obsidian passes to an embed creator. */
export interface EmbedContext {
  app: App;
  containerEl: HTMLElement;
  sourcePath?: string;
  linktext?: string;
  displayMode?: boolean;
}

export interface EmbedKind {
  /** Opens the pages of the file (shared through a cache); returns a release function. */
  acquire(file: TFile): Promise<{ source: PageSource; release: () => void }>;
  /** Open full screen at a page; omitted when there is no full-screen view. */
  openFull?(file: TFile, page: number): void;
  /** Read the starting page from the link (`#page=4`). */
  pageFromSubpath?(subpath: string): number | null;
}

/**
 * `![[file.pdf]]` / `![[image.png]]` inside a note, made writable. Obsidian creates it, calls
 * loadFile(), and unloads it when the embed leaves the screen or the note closes.
 */
export class InkEmbed extends Component {
  private readonly plugin: HandwrittenAnnotationPlugin;
  private readonly containerEl: HTMLElement;
  private readonly file: TFile;
  private readonly subpath: string;
  private readonly kind: EmbedKind;
  private annotator: Annotator | null = null;
  private cleanup: (() => void)[] = [];
  private loading: Promise<void> | null = null;
  private loadedMtime = -1;
  private unloaded = false;

  constructor(plugin: HandwrittenAnnotationPlugin, ctx: EmbedContext, file: TFile, subpath: string, kind: EmbedKind) {
    super();
    this.plugin = plugin;
    this.containerEl = ctx.containerEl;
    this.file = file;
    this.subpath = subpath ?? '';
    this.kind = kind;
    this.containerEl.addClass('hwa-embed');
  }

  onload(): void {
    // the file changed on disk (replaced by a new version): reload its pages
    this.registerEvent(this.plugin.app.vault.on('modify', (f) => {
      if (f === this.file && this.file.stat.mtime !== this.loadedMtime) void this.reload();
    }));
  }

  loadFile(): Promise<void> {
    this.loading ??= this.loadPages();
    return this.loading;
  }

  onunload(): void {
    this.unloaded = true;
    this.teardown();
  }

  private async reload(): Promise<void> {
    await this.loading;
    if (this.unloaded) return;
    this.teardown();
    this.loading = this.loadPages();
    await this.loading;
  }

  private teardown(): void {
    this.annotator?.destroy();
    this.annotator = null;
    for (const fn of this.cleanup.splice(0)) fn();
  }

  private async loadPages(): Promise<void> {
    const status = this.containerEl.createDiv({ cls: 'hwa-status', text: 'Loading…' });
    this.loadedMtime = this.file.stat.mtime;
    try {
      const store = this.plugin.store;
      const fileId = await store.resolve(this.file.path, () => this.plugin.app.vault.readBinary(this.file));
      const doc = await store.acquire(fileId);
      if (this.unloaded) {
        void store.release(fileId);
        return;
      }
      this.cleanup.push(() => void store.release(fileId));
      const { source, release } = await this.kind.acquire(this.file);
      this.cleanup.push(release);
      if (this.unloaded) {
        this.teardown();
        return;
      }
      status.remove();
      // ![[image.png|300]]: Obsidian puts the size on the container
      const width = Number(this.containerEl.getAttribute('width'));
      if (width > 0) this.containerEl.style.maxWidth = `${Math.max(width, 240)}px`;
      const linked = this.kind.pageFromSubpath?.(this.subpath) ?? null;
      const startPage = linked ?? doc.lastViewedPage() ?? 1;
      this.annotator = new Annotator(this.containerEl, {
        app: this.plugin.app,
        doc,
        source,
        settings: this.plugin.tools,
        startPage,
        layout: 'fit',
        openFull: this.kind.openFull ? (page) => this.kind.openFull?.(this.file, page) : undefined,
        onPageChange: (page) => doc.setViewedPage(page),
      });
      void this.plugin.showSyncNotice(fileId, this.containerEl);
    } catch (err) {
      if (this.unloaded) return;
      console.error('[Handwritten Annotation]', err);
      status.setText(err instanceof Error && err.message ? err.message : 'This file could not be opened.');
      status.addClass('is-error');
    }
  }
}

/** `#page=4` → 4. */
export function pageFromSubpath(subpath: string): number | null {
  if (!subpath) return null;
  const params = new URLSearchParams(subpath.replace(/^#/, ''));
  const n = Number(params.get('page'));
  return Number.isInteger(n) && n >= 1 ? n : null;
}
