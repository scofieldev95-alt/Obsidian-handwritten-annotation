import { FileView, Menu, type TFile, type ViewStateResult, type WorkspaceLeaf } from 'obsidian';
import type HandwrittenAnnotationPlugin from '../main.ts';
import type { InkDocument } from '../model/document.ts';
import { PdfError, PdfSource } from '../pdf/pdf-source.ts';
import { Annotator } from '../surface/annotator.ts';

export const PDF_VIEW = 'hwa-pdf';

/** Obsidian's own PDF view type. */
export const CORE_PDF_VIEW = 'pdf';

interface Loaded {
  file: TFile;
  fileId: string;
  doc: InkDocument;
  source: PdfSource;
  annotator: Annotator;
}

/** A PDF opened on its own: one page at a time, zoomable, with its ink. */
export class PdfInkView extends FileView {
  private readonly plugin: HandwrittenAnnotationPlugin;
  private loaded: Loaded | null = null;
  private token = 0;
  /** Page asked for in the view state (e.g. "open full screen" from an embed). */
  private requestedPage: number | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: HandwrittenAnnotationPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.navigation = true;
  }

  getViewType(): string {
    return PDF_VIEW;
  }

  getIcon(): string {
    return 'file-text';
  }

  canAcceptExtension(extension: string): boolean {
    return extension === 'pdf';
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
    menu.addItem((item) =>
      item
        .setTitle("Open in Obsidian's PDF viewer")
        .setIcon('file-text')
        .setSection('open')
        .onClick(() => {
          if (this.file) void this.leaf.setViewState({ type: CORE_PDF_VIEW, state: { file: this.file.path } });
        }),
    );
  }

  async onLoadFile(file: TFile): Promise<void> {
    const token = ++this.token;
    this.contentEl.empty();
    this.contentEl.addClass('hwa-view', 'hwa-pdf-view');
    const status = this.contentEl.createDiv({ cls: 'hwa-status', text: 'Opening…' });
    try {
      const bytes = await this.app.vault.readBinary(file);
      const fileId = await this.plugin.store.resolve(file.path, async () => bytes);
      const doc = await this.plugin.store.acquire(fileId);
      let source: PdfSource;
      try {
        source = await PdfSource.open(bytes);
      } catch (err) {
        void this.plugin.store.release(fileId);
        throw err;
      }
      if (token !== this.token) {
        source.destroy();
        void this.plugin.store.release(fileId);
        return;
      }
      status.remove();
      const startPage = this.requestedPage ?? doc.lastViewedPage() ?? 1;
      this.requestedPage = null;
      const annotator = new Annotator(this.contentEl, {
        app: this.app,
        doc,
        source,
        settings: this.plugin.tools,
        startPage,
        layout: 'viewport',
        onPageChange: (page) => doc.setViewedPage(page),
      });
      this.loaded = { file, fileId, doc, source, annotator };
      void this.plugin.showSyncNotice(fileId, this.contentEl);
    } catch (err) {
      if (token !== this.token) return;
      console.error('[Handwritten Annotation]', err);
      status.setText(err instanceof PdfError ? err.message : 'This PDF could not be opened.');
      status.addClass('is-error');
    }
  }

  async onUnloadFile(): Promise<void> {
    this.token++;
    const l = this.loaded;
    this.loaded = null;
    if (!l) return;
    l.annotator.destroy();
    l.source.destroy();
    await this.plugin.store.release(l.fileId);
  }
}
