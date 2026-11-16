import type { PageBackground } from './surface.ts';

/** A page drawn with canvas commands in page units (blank paper, test pages). */
export function vectorPage(width: number, height: number, draw: (ctx: CanvasRenderingContext2D) => void): PageBackground {
  return {
    width,
    height,
    render(ctx, view) {
      ctx.save();
      ctx.setTransform(view.k, 0, 0, view.k, view.ox, view.oy);
      draw(ctx);
      ctx.restore();
    },
  };
}

/** A4 with faint ruled lines. */
export const ruledA4 = vectorPage(595, 842, (ctx) => {
  ctx.strokeStyle = '#dfe5ee';
  ctx.lineWidth = 0.5;
  for (let y = 72; y < 842 - 36; y += 24) {
    ctx.beginPath();
    ctx.moveTo(36, y);
    ctx.lineTo(595 - 36, y);
    ctx.stroke();
  }
});
