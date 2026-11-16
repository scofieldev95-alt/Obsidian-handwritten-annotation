import type { PageSource } from '../surface/annotator.ts';
import type { PageBackground, RenderView } from '../surface/surface.ts';

/** Image types we annotate. Others (svg, gif, avif…) keep Obsidian's normal embed. */
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'];

/**
 * Images are one page. Page units are scaled so the image is 595 units wide (the width of an A4
 * page), so pens and erasers feel the same on images as on PDFs, whatever the image's resolution.
 */
export const IMAGE_PAGE_WIDTH = 595;

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

export class ImageSource implements PageSource, PageBackground {
  readonly pageCount = 1;
  readonly width = IMAGE_PAGE_WIDTH;
  readonly height: number;
  private bitmap: ImageBitmap | null;

  private constructor(bitmap: ImageBitmap) {
    this.bitmap = bitmap;
    this.height = (IMAGE_PAGE_WIDTH * bitmap.height) / Math.max(1, bitmap.width);
  }

  static async open(bytes: ArrayBuffer, extension: string): Promise<ImageSource> {
    const blob = new Blob([bytes], { type: MIME[extension.toLowerCase()] ?? 'application/octet-stream' });
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(blob);
    } catch {
      throw new Error('This image could not be opened.');
    }
    if (bitmap.width < 1 || bitmap.height < 1) throw new Error('This image is empty.');
    return new ImageSource(bitmap);
  }

  async page(): Promise<PageBackground> {
    return this;
  }

  render(ctx: CanvasRenderingContext2D, view: RenderView): void {
    if (!this.bitmap) return;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.bitmap, view.ox, view.oy, this.width * view.k, this.height * view.k);
    ctx.restore();
  }

  destroy(): void {
    this.bitmap?.close();
    this.bitmap = null;
  }
}
