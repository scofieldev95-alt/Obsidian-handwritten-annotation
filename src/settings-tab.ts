import { PluginSettingTab, Setting, type App } from 'obsidian';
import type HandwrittenAnnotationPlugin from './main.ts';

export class AnnotationSettingTab extends PluginSettingTab {
  private readonly plugin: HandwrittenAnnotationPlugin;

  constructor(app: App, plugin: HandwrittenAnnotationPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    const tools = this.plugin.tools;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Draw with a finger')
      .setDesc('On iPad and iPhone. Off: a finger scrolls and only Apple Pencil writes.')
      .addToggle((t) => t.setValue(tools.data.fingerDraw).onChange((v) => tools.update((d) => { d.fingerDraw = v; })));

    new Setting(containerEl).setName('Where you can write').setHeading();

    new Setting(containerEl)
      .setName('PDFs in notes')
      .setDesc('Write on ![[file.pdf]] embeds.')
      .addToggle((t) => t.setValue(tools.data.pdfEmbeds).onChange((v) => tools.update((d) => { d.pdfEmbeds = v; })));

    new Setting(containerEl)
      .setName('Images in notes')
      .setDesc('Write on PNG, JPG and WebP embeds. Other images keep the normal view.')
      .addToggle((t) => t.setValue(tools.data.imageEmbeds).onChange((v) => tools.update((d) => { d.imageEmbeds = v; })));

    new Setting(containerEl)
      .setName('Open PDFs with Handwritten Annotation')
      .setDesc("PDFs opened from the file list show your ink. Off: Obsidian's own PDF viewer (without ink).")
      .addToggle((t) => t.setValue(tools.data.openPdfs).onChange((v) => tools.update((d) => { d.openPdfs = v; })));

    new Setting(containerEl).setName('Storage').setHeading();
    const count = this.plugin.store.annotatedCount();
    new Setting(containerEl)
      .setName('Where the ink is kept')
      .setDesc(
        `Your PDFs and images are never changed. The ink is saved in the hidden folder ` +
          `${this.app.vault.configDir}/handwritten-annotation inside this vault, so it syncs with the vault (iCloud). ` +
          `${count === 1 ? '1 file has' : `${count} files have`} ink. Ink of a deleted file is kept for 10 days in case it comes back.`,
      );
  }
}
