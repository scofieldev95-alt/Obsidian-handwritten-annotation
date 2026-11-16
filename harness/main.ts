// Browser harness: the annotator on three blank pages, outside Obsidian.
import './obsidian-stub.ts';
import { InkDocument } from '../src/model/document.ts';
import { DEFAULT_SETTINGS, SettingsStore } from '../src/settings.ts';
import { Annotator } from '../src/surface/annotator.ts';
import type { PageBackground } from '../src/surface/surface.ts';

const page: PageBackground = {
  width: 595,
  height: 842,
  draw(ctx) {
    ctx.strokeStyle = '#dfe5ee';
    ctx.lineWidth = 0.5;
    for (let y = 72; y < 806; y += 24) {
      ctx.beginPath();
      ctx.moveTo(36, y);
      ctx.lineTo(559, y);
      ctx.stroke();
    }
  },
};

const doc = new InkDocument('harness1');
const settings = new SettingsStore(structuredClone(DEFAULT_SETTINGS), () => {});
const annotator = new Annotator(document.getElementById('app')!, {
  app: {} as never,
  doc,
  source: { pageCount: 3, page: async () => page },
  settings,
  startPage: 1,
});

Object.assign(window, { doc, settings, annotator });
