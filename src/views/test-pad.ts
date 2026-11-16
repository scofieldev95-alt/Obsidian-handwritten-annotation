import { ItemView, type WorkspaceLeaf } from 'obsidian';
import type HandwrittenAnnotationPlugin from '../main.ts';
import { Annotator, type PageSource } from '../surface/annotator.ts';
import { ruledA4 } from '../surface/backgrounds.ts';

export const TEST_PAD_VIEW = 'hwa-test-pad';


const blankSource: PageSource = {
  pageCount: 3,
  page: async () => ruledA4,
};

/**
 * Stage 2 test pad: three blank pages to try the ink engine. The ink lives in memory until
 * Obsidian is closed (saving comes with the PDF work).
 */
export class TestPadView extends ItemView {
  private readonly plugin: HandwrittenAnnotationPlugin;
  private annotator: Annotator | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: HandwrittenAnnotationPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return TEST_PAD_VIEW;
  }

  getDisplayText(): string {
    return 'Ink test pad';
  }

  getIcon(): string {
    return 'pen-line';
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass('hwa-view');
    const wrap = this.contentEl.createDiv({ cls: 'hwa-view-page' });
    this.annotator = new Annotator(wrap, {
      app: this.app,
      doc: this.plugin.testPadDoc(),
      source: blankSource,
      settings: this.plugin.tools,
      startPage: 1,
      layout: 'fit',
    });
  }

  async onClose(): Promise<void> {
    this.annotator?.destroy();
    this.annotator = null;
  }
}
