import { Notice, Plugin, TFile, debounce, normalizePath } from 'obsidian';
import { InkDocument } from './model/document.ts';
import { randomId } from './model/ids.ts';
import { takeOverExtension } from './obsidian-internals.ts';
import { SettingsStore, sanitizeSettings } from './settings.ts';
import { InkStore } from './store/store.ts';
import { CORE_PDF_VIEW, PDF_VIEW, PdfInkView } from './views/pdf-view.ts';
import { TEST_PAD_VIEW, TestPadView } from './views/test-pad.ts';

const DEVICE_KEY = 'handwritten-annotation:device-id';
/** How often open files check for ink from other devices. */
const POLL_MS = 4000;
/** Extensions whose ink we track. */
const ANNOTATABLE = new Set(['pdf', 'png', 'jpg', 'jpeg', 'webp']);

export default class HandwrittenAnnotationPlugin extends Plugin {
  tools!: SettingsStore;
  store!: InkStore;
  /** This device's id. Kept in local storage, which is per device and never synced. */
  deviceId!: string;
  private padDoc: InkDocument | null = null;
  private restorePdf: (() => void) | null = null;

  async onload(): Promise<void> {
    this.deviceId = loadDeviceId();
    const save = debounce((data: unknown) => void this.saveData(data), 500, true);
    this.tools = new SettingsStore(sanitizeSettings(await this.loadData()), (d) => save(d));

    // Hidden folder in the vault's config folder: synced by iCloud with the vault, never shown in
    // the file list, and kept if the plugin is uninstalled and reinstalled.
    const root = normalizePath(`${this.app.vault.configDir}/handwritten-annotation`);
    this.store = new InkStore(this.app.vault.adapter, root, this.deviceId, (err) => console.error('[Handwritten Annotation]', err));
    await this.store.init();

    this.registerView(TEST_PAD_VIEW, (leaf) => new TestPadView(leaf, this));
    this.registerView(PDF_VIEW, (leaf) => new PdfInkView(leaf, this));

    this.addCommand({
      id: 'open-test-pad',
      name: 'Open ink test pad',
      callback: () => void this.openTestPad(),
    });
    this.addCommand({
      id: 'open-in-core-pdf-viewer',
      name: "Open this PDF in Obsidian's PDF viewer",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(PdfInkView);
        if (!view?.file) return false;
        if (!checking) void view.leaf.setViewState({ type: CORE_PDF_VIEW, state: { file: view.file.path } });
        return true;
      },
    });

    this.app.workspace.onLayoutReady(() => {
      this.restorePdf = takeOverExtension(this.app, 'pdf', PDF_VIEW);
      if (!this.restorePdf) new Notice('Handwritten Annotation: PDFs will open in the normal viewer on this version of Obsidian.');
      void this.store.purge().catch((err) => console.error('[Handwritten Annotation]', err));
    });

    // the ink follows its file
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (file instanceof TFile && ANNOTATABLE.has(file.extension.toLowerCase())) void this.store.renamed(oldPath, file.path);
    }));
    this.registerEvent(this.app.vault.on('delete', (file) => {
      if (file instanceof TFile && ANNOTATABLE.has(file.extension.toLowerCase())) void this.store.deleted(file.path);
    }));

    // other devices' ink arrives through iCloud: check regularly while something is open
    this.registerInterval(window.setInterval(() => {
      if (this.store.openFileIds().length) void this.store.poll();
    }, POLL_MS));
    // save immediately when Obsidian goes to the background or closes (iPad, iPhone)
    this.registerDomEvent(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') void this.store.flush();
      else void this.store.poll();
    });
    this.registerDomEvent(window, 'pagehide', () => void this.store.flush());
    this.registerDomEvent(window, 'focus', () => void this.store.poll());
  }

  async onunload(): Promise<void> {
    this.restorePdf?.();
    this.restorePdf = null;
    await this.store?.flush();
  }

  /** In-memory ink for the test pad (kept while Obsidian runs). */
  testPadDoc(): InkDocument {
    this.padDoc ??= new InkDocument(this.deviceId);
    return this.padDoc;
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

  private async openTestPad(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(TEST_PAD_VIEW)[0];
    const leaf = existing ?? this.app.workspace.getLeaf('tab');
    if (!existing) await leaf.setViewState({ type: TEST_PAD_VIEW, active: true });
    await this.app.workspace.revealLeaf(leaf);
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
