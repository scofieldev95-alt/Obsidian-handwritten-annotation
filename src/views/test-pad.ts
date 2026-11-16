import { ItemView, type WorkspaceLeaf } from 'obsidian';
import type HandwrittenAnnotationPlugin from '../main.ts';
import { Annotator, type PageSource } from '../surface/annotator.ts';
import type { PageBackground } from '../surface/surface.ts';

export const TEST_PAD_VIEW = 'hwa-test-pad';

/** Blank A4 paper with faint lines. */
const blankPage: PageBackground = {
  width: 595,
  height: 842,
  draw(ctx) {
    ctx.strokeStyle = '#dfe5ee';
    ctx.lineWidth = 0.5;
    for (let y = 72; y < 842 - 36; y += 24) {
      ctx.beginPath();
      ctx.moveTo(36, y);
      ctx.lineTo(595 - 36, y);
      ctx.stroke();
    }
  },
};

const blankSource: PageSource = {
  pageCount: 3,
  page: async () => blankPage,
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
    });
  }

  async onClose(): Promise<void> {
    this.annotator?.destroy();
    this.annotator = null;
  }
}
