import { loadPdfJs } from 'obsidian';
import type { PageSource } from '../surface/annotator.ts';
import type { PageBackground, RenderView } from '../surface/surface.ts';

// The parts of PDF.js (shipped with Obsidian) that we use.
interface PdfViewport {
  width: number;
  height: number;
}
interface PdfRenderTask {
  promise: Promise<void>;
  cancel(): void;
}
interface PdfPage {
  getViewport(o: { scale: number }): PdfViewport;
  render(o: {
    canvasContext: CanvasRenderingContext2D;
    viewport: PdfViewport;
    transform?: number[];
    intent?: string;
  }): PdfRenderTask;
  cleanup(): void;
}
interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  destroy(): Promise<void>;
}
interface PdfLoadingTask {
  promise: Promise<PdfDocument>;
  destroy(): Promise<void>;
}
interface PdfJsLib {
  getDocument(src: { data: Uint8Array; isEvalSupported?: boolean }): PdfLoadingTask;
}

export class PdfError extends Error {}

/**
 * The pages of one PDF, rendered with Obsidian's own PDF.js. Pages are loaded on demand; the
 * PDF stays open while anything shows it.
 */
export class PdfSource implements PageSource {
  readonly pageCount: number;
  private readonly pdf: PdfDocument;
  private readonly pages = new Map<number, Promise<PageBackground>>();
  private destroyed = false;

  private constructor(pdf: PdfDocument) {
    this.pdf = pdf;
    this.pageCount = pdf.numPages;
  }

  static async open(bytes: ArrayBuffer): Promise<PdfSource> {
    const lib = (await loadPdfJs()) as PdfJsLib | undefined;
    if (!lib || typeof lib.getDocument !== 'function') throw new PdfError('PDF support is not available in this version of Obsidian.');
    // PDF.js takes ownership of the buffer it is given, so hand it a copy
    const task = lib.getDocument({ data: new Uint8Array(bytes.slice(0)), isEvalSupported: false });
    let pdf: PdfDocument;
    try {
      pdf = await task.promise;
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === 'PasswordException') throw new PdfError('This PDF is password-protected.');
      throw new PdfError('This PDF could not be opened (it may be damaged).');
    }
    if (pdf.numPages < 1) throw new PdfError('This PDF has no pages.');
    return new PdfSource(pdf);
  }

  page(n: number): Promise<PageBackground> {
    let p = this.pages.get(n);
    if (!p) {
      p = this.pdf.getPage(n).then((page) => new PdfPageBackground(page));
      this.pages.set(n, p);
      p.catch(() => this.pages.delete(n));
    }
    return p;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.pages.clear();
    void this.pdf.destroy().catch(() => {});
  }
}

class PdfPageBackground implements PageBackground {
  readonly width: number;
  readonly height: number;
  private readonly page: PdfPage;

  constructor(page: PdfPage) {
    this.page = page;
    // scale 1 = PDF points; includes the page's /Rotate
    const vp = page.getViewport({ scale: 1 });
    this.width = vp.width;
    this.height = vp.height;
  }

  async render(ctx: CanvasRenderingContext2D, view: RenderView, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const task = this.page.render({
      canvasContext: ctx,
      viewport: this.page.getViewport({ scale: view.k }),
      transform: [1, 0, 0, 1, view.ox, view.oy],
      intent: 'display',
    });
    const cancel = () => task.cancel();
    signal.addEventListener('abort', cancel, { once: true });
    try {
      await task.promise;
    } catch (err) {
      if (signal.aborted) return;
      throw err;
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }
}
