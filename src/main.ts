import { Plugin, debounce } from 'obsidian';
import { InkDocument } from './model/document.ts';
import { randomId } from './model/ids.ts';
import { SettingsStore, sanitizeSettings } from './settings.ts';
import { TEST_PAD_VIEW, TestPadView } from './views/test-pad.ts';

const DEVICE_KEY = 'handwritten-annotation:device-id';

export default class HandwrittenAnnotationPlugin extends Plugin {
  tools!: SettingsStore;
  /** This device's id. Kept in local storage, which is per device and never synced. */
  deviceId!: string;
  private padDoc: InkDocument | null = null;

  async onload(): Promise<void> {
    this.deviceId = loadDeviceId();
    const save = debounce((data: unknown) => void this.saveData(data), 500, true);
    this.tools = new SettingsStore(sanitizeSettings(await this.loadData()), (d) => save(d));

    this.registerView(TEST_PAD_VIEW, (leaf) => new TestPadView(leaf, this));
    this.addCommand({
      id: 'open-test-pad',
      name: 'Open ink test pad',
      callback: () => void this.openTestPad(),
    });
  }

  /** In-memory ink for the test pad (kept while Obsidian runs). */
  testPadDoc(): InkDocument {
    this.padDoc ??= new InkDocument(this.deviceId);
    return this.padDoc;
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
