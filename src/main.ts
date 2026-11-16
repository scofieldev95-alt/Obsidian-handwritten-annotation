import { Notice, Platform, Plugin, TFile, TFolder, debounce, normalizePath } from 'obsidian';
import { randomId } from './model/ids.ts';
import { InkEmbed, pageFromSubpath, type EmbedContext } from './embed/ink-embed.ts';
import { rerenderMarkdownViews, takeOverEmbed, takeOverExtension } from './obsidian-internals.ts';
import { PdfSource } from './pdf/pdf-source.ts';
import { SourceCache } from './pdf/source-cache.ts';
import { SettingsStore, sanitizeSettings, type PluginSettings } from './settings.ts';
import { AnnotationSettingTab } from './settings-tab.ts';
import type { Tool } from './ink/types.ts';
import { InkStore } from './store/store.ts';
import { IMAGE_EXTENSIONS, ImageSource } from './image/image-source.ts';
import type { PageSource } from './surface/annotator.ts';
import { CORE_IMAGE_VIEW, CORE_PDF_VIEW, IMAGE_VIEW, InkFileView, PDF_VIEW } from './views/ink-file-view.ts';

const DEVICE_KEY = 'handwritten-annotation:device-id';
/** How often open files check for ink from other devices. */
const POLL_MS = 4000;
/** Extensions whose ink we track. */
const ANNOTATABLE = new Set(['pdf', ...IMAGE_EXTENSIONS]);

export default class HandwrittenAnnotationPlugin extends Plugin {
  tools!: SettingsStore;
  store!: InkStore;
  /** This device's id. Kept in local storage, which is per device and never synced. */
  deviceId!: string;
  pdfCache!: SourceCache<PdfSource>;
  imageCache!: SourceCache<ImageSource>;
  /** Active takeovers (our view / our embeds instead of Obsidian's), by key, with their undo. */
  private takeovers = new Map<string, () => void>();

  async onload(): Promise<void> {
    this.deviceId = loadDeviceId();
    const save = debounce((data: unknown) => void this.saveData(data), 500, true);
    this.tools = new SettingsStore(sanitizeSettings(await this.loadData()), (d) => save(d));

    // Hidden folder in the vault's config folder: synced by iCloud with the vault, never shown in
    // the file list, and kept if the plugin is uninstalled and reinstalled.
    const root = normalizePath(`${this.app.vault.configDir}/handwritten-annotation`);
    this.store = new InkStore(this.app.vault.adapter, root, this.deviceId, (err) => console.error('[Handwritten Annotation]', err), 30_000);
    await this.store.init();
    this.pdfCache = new SourceCache(this.app, (bytes) => PdfSource.open(bytes));
    this.imageCache = new SourceCache(this.app, (bytes, file) => ImageSource.open(bytes, file.extension), 20_000);

    this.registerView(PDF_VIEW, (leaf) => new InkFileView(leaf, this, 'pdf'));
    this.registerView(IMAGE_VIEW, (leaf) => new InkFileView(leaf, this, 'image'));

    const tools: { id: Tool; name: string }[] = [
      { id: 'pen', name: 'Pen' },
      { id: 'highlighter', name: 'Highlighter' },
      { id: 'eraser', name: 'Eraser' },
      { id: 'lasso', name: 'Lasso' },
    ];
    for (const t of tools) {
      this.addCommand({ id: `tool-${t.id}`, name: `Use the ${t.name.toLowerCase()}`, callback: () => this.tools.update((d) => { d.tool = t.id; }) });
    }
    this.addCommand({
      id: 'toggle-eraser-mode',
      name: 'Switch eraser between whole stroke and partial',
      callback: () => this.tools.update((d) => { d.eraser.mode = d.eraser.mode === 'stroke' ? 'partial' : 'stroke'; }),
    });
    this.addCommand({
      id: 'open-in-core-viewer',
      name: "Open this file in Obsidian's own viewer",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(InkFileView);
        if (!view?.file) return false;
        const type = view.getViewType() === PDF_VIEW ? CORE_PDF_VIEW : CORE_IMAGE_VIEW;
        if (!checking) void view.leaf.setViewState({ type, state: { file: view.file.path } });
        return true;
      },
    });

    this.addSettingTab(new AnnotationSettingTab(this.app, this));

    // PDFs open in our view, and ![[file.pdf]] / ![[image.png]] in notes become writable
    if (!this.applyTakeovers(this.tools.data, false)) {
      new Notice('Handwritten Annotation: this version of Obsidian does not let the plugin take over PDFs and images. Writing on them is limited.');
    }
    this.register(this.tools.on((s) => this.applyTakeovers(s, true)));

    this.app.workspace.onLayoutReady(() => {
      rerenderMarkdownViews(this.app);
      void this.cleanUp();
    });

    // the ink follows its file
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (file instanceof TFolder) void this.store.renamedFolder(oldPath, file.path);
      else if (file instanceof TFile && ANNOTATABLE.has(file.extension.toLowerCase())) void this.store.renamed(oldPath, file.path);
    }));
    this.registerEvent(this.app.vault.on('delete', (file) => {
      if (file instanceof TFolder) void this.store.deletedFolder(file.path);
      else if (file instanceof TFile && ANNOTATABLE.has(file.extension.toLowerCase())) void this.store.deleted(file.path);
    }));

    // other devices' ink arrives through iCloud: check regularly while something is open
    this.registerInterval(window.setInterval(() => {
      if (this.store.openFileIds().length) void this.store.poll();
    }, POLL_MS));
    // save immediately when Obsidian goes to the background or closes (iPad, iPhone)
    this.registerDomEvent(activeDocument, 'visibilitychange', () => {
      if (activeDocument.visibilityState === 'hidden') void this.store.flush();
      else void this.store.poll();
    });
    this.registerDomEvent(window, 'pagehide', () => void this.store.flush());
    this.registerDomEvent(window, 'focus', () => void this.store.poll());
  }

  onunload(): void {
    for (const restore of this.takeovers.values()) restore();
    this.takeovers.clear();
    rerenderMarkdownViews(this.app);
    // save what's pending; the caches only close files once nothing uses them
    void this.store?.flush().finally(() => {
      this.pdfCache?.clear();
      this.imageCache?.clear();
    });
  }

  /**
   * Startup housekeeping: notice files deleted outside Obsidian (Mac only — on iPhone/iPad a file
   * iCloud hasn't downloaded yet can look missing), then remove ink of files deleted 10+ days ago.
   */
  async cleanUp(): Promise<void> {
    const exists = (path: string) => this.app.vault.getAbstractFileByPath(path) instanceof TFile;
    try {
      if (Platform.isDesktopApp) await this.store.reconcile(exists);
      await this.store.purge(Date.now(), exists);
    } catch (err) {
      console.error('[Handwritten Annotation]', err);
    }
  }

  /** The pages of a PDF or image, shared through the caches. */
  acquireSource(file: TFile, bytes?: ArrayBuffer): Promise<{ source: PageSource; release: () => void }> {
    return file.extension.toLowerCase() === 'pdf' ? this.pdfCache.acquire(file, bytes) : this.imageCache.acquire(file, bytes);
  }

  /** Open a PDF or image full screen (in a new tab) at a page. */
  async openFull(file: TFile, page: number): Promise<void> {
    const type = file.extension.toLowerCase() === 'pdf' ? PDF_VIEW : IMAGE_VIEW;
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type, active: true, state: { file: file.path, page } });
  }

  /**
   * Take over (or give back) the PDF view and the PDF / image embeds to match the settings.
   * Returns false if Obsidian refused one of them.
   */
  private applyTakeovers(s: PluginSettings, rerender: boolean): boolean {
    const want = new Map<string, () => (() => void) | null>();
    if (s.openPdfs) want.set('view:pdf', () => takeOverExtension(this.app, 'pdf', PDF_VIEW));
    if (s.pdfEmbeds) {
      want.set('embed:pdf', () => takeOverEmbed(this.app, 'pdf', (ctx, file, subpath) =>
        !(file instanceof TFile) ? null : new InkEmbed(this, ctx as EmbedContext, file, subpath, {
          acquire: (f) => this.pdfCache.acquire(f),
          openFull: (f, page) => void this.openFull(f, page),
          pageFromSubpath,
        })));
    }
    if (s.imageEmbeds) {
      for (const ext of IMAGE_EXTENSIONS) {
        want.set(`embed:${ext}`, () => takeOverEmbed(this.app, ext, (ctx, file, subpath) =>
          !(file instanceof TFile) ? null : new InkEmbed(this, ctx as EmbedContext, file, subpath, {
            acquire: (f) => this.imageCache.acquire(f),
            openFull: (f) => void this.openFull(f, 1),
          })));
      }
    }
    let changed = false;
    let ok = true;
    for (const [key, restore] of this.takeovers) {
      if (want.has(key)) continue;
      restore();
      this.takeovers.delete(key);
      changed = true;
    }
    for (const [key, take] of want) {
      if (this.takeovers.has(key)) continue;
      const restore = take();
      if (restore) {
        this.takeovers.set(key, restore);
        changed = true;
      } else {
        ok = false;
      }
    }
    if (changed && rerender) rerenderMarkdownViews(this.app);
    return ok;
  }

  /** If another device's ink for this file hasn't arrived yet, say so instead of showing a page that looks empty. */
  async showSyncNotice(fileId: string, container: HTMLElement): Promise<void> {
    const waiting = await this.store.waitingFor(fileId);
    if (!waiting.length) return;
    const el = container.createDiv({ cls: 'hwa-sync-notice', text: 'Waiting for iCloud to bring ink from your other device…' });
    const check = async () => {
      await this.store.poll();
      if (!(await this.store.waitingFor(fileId)).length || !el.isConnected) {
        el.remove();
        window.clearInterval(timer);
      }
    };
    const timer = window.setInterval(() => void check(), POLL_MS);
    this.registerInterval(timer);
  }

}

function loadDeviceId(): string {
  try {
    const saved = window.localStorage.getItem(DEVICE_KEY);
    if (saved && /^[0-9a-z]{8,16}$/.test(saved)) return saved;
    const id = randomId(10);
    window.localStorage.setItem(DEVICE_KEY, id);
    return id;
  } catch {
    return randomId(10);
  }
}
