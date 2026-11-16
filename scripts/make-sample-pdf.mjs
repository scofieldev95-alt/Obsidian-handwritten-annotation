// Writes a small multi-page PDF (A4 pages plus one landscape page) for testing.
import { writeFileSync } from 'node:fs';

const out = process.argv[2] ?? 'dev-vault/Sample lecture.pdf';
const pages = [
  { w: 595, h: 842, title: 'Page 1 - Introduction' },
  { w: 595, h: 842, title: 'Page 2 - Eigenvalues' },
  { w: 842, h: 595, title: 'Page 3 - Landscape slide' },
  { w: 595, h: 842, title: 'Page 4 - Exercises' },
];

const objs = [];
const add = (s) => { objs.push(s); return objs.length; };
const catalog = add(null);
const pagesObj = add(null);
const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
const kids = [];
for (const p of pages) {
  let body = `BT /F1 24 Tf 56 ${p.h - 80} Td (${p.title}) Tj ET\n`;
  body += `BT /F1 12 Tf 56 ${p.h - 120} Td (Write on this page with the pen, highlighter and eraser.) Tj ET\n`;
  for (let i = 0; i < 12; i++) {
    const y = p.h - 170 - i * 40;
    if (y < 60) break;
    body += `BT /F1 11 Tf 56 ${y} Td (Line ${i + 1}: The quick brown fox jumps over the lazy dog. 0123456789) Tj ET\n`;
  }
  body += `0.2 0.4 0.8 RG 2 w 56 50 m ${p.w - 56} 50 l S\n`;
  const content = add(`<< /Length ${body.length} >>\nstream\n${body}endstream`);
  kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${p.w} ${p.h}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
}
objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

let pdf = '%PDF-1.4\n';
const offsets = [];
objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
const xref = pdf.length;
pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
pdf += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
writeFileSync(out, pdf, 'latin1');
console.log(`wrote ${out}`);
