import { FileView, Menu, type TFile, type ViewStateResult, type WorkspaceLeaf } from 'obsidian';
import type HandwrittenAnnotationPlugin from '../main.ts';
import type { InkDocument } from '../model/document.ts';
import { IMAGE_EXTENSIONS } from '../image/image-source.ts';
import { Annotator, type PageSource } from '../surface/annotator.ts';

export const PDF_VIEW = 'hwa-pdf';
export const IMAGE_VIEW = 'hwa-image';

/** Obsidian's own view types. */
export const CORE_PDF_VIEW = 'pdf';
export const CORE_IMAGE_VIEW = 'image';

interface Loaded {
  file: TFile;
  fileId: string;
  doc: InkDocument;
  releaseSource: () => void;
  annotator: Annotator;
}

/** A PDF or image opened full screen: one page at a time, zoomable, with its ink. */
export class InkFileView extends FileView {
  private readonly plugin: HandwrittenAnnotationPlugin;
  private readonly kind: 'pdf' | 'image';
  private loaded: Loaded | null = null;
  private token = 0;
  /** Page asked for in the view state (e.g. "open full screen" from an embed). */
  private requestedPage: number | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: HandwrittenAnnotationPlugin, kind: 'pdf' | 'image') {
    super(leaf);
    this.plugin = plugin;
    this.kind = kind;
    this.navigation = true;
  }

  getViewType(): string {
    return this.kind === 'pdf' ? PDF_VIEW : IMAGE_VIEW;
  }

  getIcon(): string {
    return this.kind === 'pdf' ? 'file-text' : 'image';
  }

  canAcceptExtension(extension: string): boolean {
    const ext = extension.toLowerCase();
    return this.kind === 'pdf' ? ext === 'pdf' : IMAGE_EXTENSIONS.includes(ext);
  }

  getState(): Record<string, unknown> {
    const state = super.getState();
    const page = this.loaded?.annotator.currentPage;
    return page ? { ...state, page } : state;
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const page = (state as { page?: unknown } | null)?.page;
    if (typeof page === 'number' && page >= 1) {
      this.requestedPage = page;
      // same file already open: just go to the page
      if (this.loaded && (state as { file?: string }).file === this.loaded.file.path) void this.loaded.annotator.goTo(page);
    }
    await super.setState(state, result);
  }

  onPaneMenu(menu: Menu, source: string): void {
    super.onPaneMenu(menu, source);
    const core = this.kind === 'pdf' ? CORE_PDF_VIEW : CORE_IMAGE_VIEW;
    menu.addItem((item) =>
      item
        .setTitle(this.kind === 'pdf' ? "Open in Obsidian's PDF viewer" : "Open in Obsidian's image viewer")
        .setIcon(this.getIcon())
        .setSection('open')
        .onClick(() => {
          if (this.file) void this.leaf.setViewState({ type: core, state: { file: this.file.path } });
        }),
    );
  }

  async onLoadFile(file: TFile): Promise<void> {
    const token = ++this.token;
    this.contentEl.empty();
    this.contentEl.addClass('hwa-view', 'hwa-file-view');
    const status = this.contentEl.createDiv({ cls: 'hwa-status', text: 'Opening…' });
    let cleanup: (() => void)[] = [];
    try {
      const bytes = await this.app.vault.readBinary(file);
      const fileId = await this.plugin.store.resolve(file.path, async () => bytes);
      const doc = await this.plugin.store.acquire(fileId);
      cleanup.push(() => void this.plugin.store.release(fileId));
      const { source, release } = await this.plugin.acquireSource(file, bytes);
      cleanup.push(release);
      if (token !== this.token) {
        for (const fn of cleanup) fn();
        return;
      }
      status.remove();
      const startPage = this.requestedPage ?? doc.lastViewedPage() ?? 1;
      this.requestedPage = null;
      const annotator = new Annotator(this.contentEl, {
        app: this.app,
        doc,
        source: source as PageSource,
        settings: this.plugin.tools,
        startPage,
        layout: 'viewport',
        onPageChange: (page) => doc.setViewedPage(page),
      });
      this.loaded = { file, fileId, doc, releaseSource: release, annotator };
      cleanup = [];
      void this.plugin.showSyncNotice(fileId, this.contentEl);
    } catch (err) {
      for (const fn of cleanup) fn();
      if (token !== this.token) return;
      console.error('[Handwritten Annotation]', err);
      status.setText(err instanceof Error && err.message ? err.message : 'This file could not be opened.');
      status.addClass('is-error');
    }
  }

  async onUnloadFile(): Promise<void> {
    this.token++;
    const l = this.loaded;
    this.loaded = null;
    if (!l) return;
    l.annotator.destroy();
    l.releaseSource();
    await this.plugin.store.release(l.fileId);
  }
}
