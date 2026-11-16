import { PluginSettingTab, Setting, type App, type SettingDefinitionItem } from 'obsidian';
import type HandwrittenAnnotationPlugin from './main.ts';
import type { PluginSettings } from './settings.ts';

type ToggleKey = 'fingerDraw' | 'pdfEmbeds' | 'imageEmbeds' | 'openPdfs';

const TOGGLES: Record<ToggleKey, { name: string; desc: string }> = {
  fingerDraw: {
    name: 'Draw with a finger',
    desc: 'On iPad and iPhone. Off: a finger scrolls and only Apple Pencil writes.',
  },
  pdfEmbeds: {
    name: 'PDFs in notes',
    desc: 'Write on ![[file.pdf]] embeds.',
  },
  imageEmbeds: {
    name: 'Images in notes',
    desc: 'Write on PNG, JPG and WebP embeds. Other images keep the normal view.',
  },
  openPdfs: {
    name: 'Open PDFs with handwritten annotation',
    desc: "PDFs opened from the file list show your ink. Off: Obsidian's own PDF viewer (without ink).",
  },
};

export class AnnotationSettingTab extends PluginSettingTab {
  private readonly plugin: HandwrittenAnnotationPlugin;

  constructor(app: App, plugin: HandwrittenAnnotationPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /** Obsidian 1.13+: declarative settings, which also show up in the settings search. */
  getSettingDefinitions(): SettingDefinitionItem[] {
    const toggle = (key: ToggleKey) => ({ ...TOGGLES[key], control: { type: 'toggle' as const, key } });
    return [
      toggle('fingerDraw'),
      { type: 'group', heading: 'Where you can write', items: [toggle('pdfEmbeds'), toggle('imageEmbeds'), toggle('openPdfs')] },
      { type: 'group', heading: 'Storage', items: [{ name: 'Where the ink is kept', desc: this.storageText() }] },
    ];
  }

  getControlValue(key: string): unknown {
    return this.plugin.tools.data[key as keyof PluginSettings];
  }

  setControlValue(key: string, value: unknown): void {
    if (!(key in TOGGLES) || typeof value !== 'boolean') return;
    this.plugin.tools.update((d) => { d[key as ToggleKey] = value; });
  }

  /** Obsidian before 1.13. */
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const add = (key: ToggleKey) =>
      new Setting(containerEl)
        .setName(TOGGLES[key].name)
        .setDesc(TOGGLES[key].desc)
        .addToggle((t) => t.setValue(this.plugin.tools.data[key]).onChange((v) => this.setControlValue(key, v)));
    add('fingerDraw');
    new Setting(containerEl).setName('Where you can write').setHeading();
    add('pdfEmbeds');
    add('imageEmbeds');
    add('openPdfs');
    new Setting(containerEl).setName('Storage').setHeading();
    new Setting(containerEl).setName('Where the ink is kept').setDesc(this.storageText());
  }

  private storageText(): string {
    const count = this.plugin.store.annotatedCount();
    return (
      `Your PDFs and images are never changed. The ink is saved in the hidden folder ` +
      `${this.app.vault.configDir}/handwritten-annotation inside this vault, so it syncs with the vault. ` +
      `${count === 1 ? '1 file has' : `${count} files have`} ink. Ink of a deleted file is kept for 10 days in case it comes back.`
    );
  }
}
