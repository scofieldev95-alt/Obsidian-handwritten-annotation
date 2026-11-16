// Browser harness: the annotator on three blank pages, outside Obsidian.
import './obsidian-stub.ts';
import { InkDocument } from '../src/model/document.ts';
import { DEFAULT_SETTINGS, SettingsStore } from '../src/settings.ts';
import { Annotator } from '../src/surface/annotator.ts';
import { ruledA4 } from '../src/surface/backgrounds.ts';
import { PdfSource } from '../src/pdf/pdf-source.ts';
import { ImageSource } from '../src/image/image-source.ts';


const doc = new InkDocument('harness1');
const settings = new SettingsStore(structuredClone(DEFAULT_SETTINGS), () => {});
const params = new URLSearchParams(location.search);
const pdfUrl = params.get('pdf');
const imgUrl = params.get('img');
const source = pdfUrl
  ? await PdfSource.open(await (await fetch(pdfUrl)).arrayBuffer())
  : imgUrl
    ? await ImageSource.open(await (await fetch(imgUrl)).arrayBuffer(), imgUrl.split('.').pop()!)
    : { pageCount: 3, page: async () => ruledA4 };
const annotator = new Annotator(document.getElementById('app')!, {
  app: {} as never,
  doc,
  source,
  settings,
  startPage: 1,
  layout: (new URLSearchParams(location.search).get('layout') as 'fit' | 'viewport') ?? 'fit',
});

Object.assign(window, { doc, settings, annotator });
