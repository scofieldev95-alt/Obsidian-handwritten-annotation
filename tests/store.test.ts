import './setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InkStore, PURGE_AFTER_MS, fingerprint, type StorageAdapter } from '../src/store/store.ts';
import type { Stroke } from '../src/ink/types.ts';

/** An in-memory folder shared by several "devices", like the vault synced by iCloud. */
class MemFs implements StorageAdapter {
  files = new Map<string, { data: string; mtime: number }>();
  dirs = new Set<string>();
  clock = 1;
  async exists(p: string) { return this.files.has(p) || this.dirs.has(p); }
  async read(p: string) {
    const f = this.files.get(p);
    if (!f) throw new Error(`missing ${p}`);
    return f.data;
  }
  async write(p: string, data: string) { this.files.set(p, { data, mtime: this.clock++ }); }
  async list(p: string) {
    const files: string[] = [];
    const folders = new Set<string>();
    for (const k of this.files.keys()) if (k.startsWith(`${p}/`) && !k.slice(p.length + 1).includes('/')) files.push(k);
    for (const d of this.dirs) if (d.startsWith(`${p}/`) && !d.slice(p.length + 1).includes('/')) folders.add(d);
    return { files, folders: [...folders] };
  }
  async mkdir(p: string) {
    const parts = p.split('/');
    for (let i = 1; i <= parts.length; i++) this.dirs.add(parts.slice(0, i).join('/'));
  }
  async rmdir(p: string) {
    for (const k of [...this.files.keys()]) if (k.startsWith(`${p}/`)) this.files.delete(k);
    for (const d of [...this.dirs]) if (d === p || d.startsWith(`${p}/`)) this.dirs.delete(d);
  }
  async stat(p: string) {
    const f = this.files.get(p);
    return f ? { mtime: f.mtime, size: f.data.length } : null;
  }
}

const ROOT = '.obsidian/handwritten-annotation';
const pdfBytes = (text: string) => async () => new TextEncoder().encode(text).buffer;
const st = (id: string, at = 1): Stroke => ({ id, tool: 'pen', color: '#000000', width: 2, pressure: false, pts: [1, 1, 0.5, 9, 9, 0.5], at });
const ids = (list: readonly Stroke[]) => list.map((s) => s.id);
const noErrors = (err: unknown) => { throw err; };

async function device(fs: MemFs, id: string) {
  const s = new InkStore(fs, ROOT, id, noErrors);
  await s.init();
  return s;
}

test('ink is saved per device and merged when another device opens the file', async () => {
  const fs = new MemFs();
  const mac = await device(fs, 'mac00001');
  const id = await mac.resolve('Lecture.pdf', pdfBytes('%PDF lecture'));
  const doc = await mac.acquire(id);
  doc.apply(1, [st('mac1')], []);
  await mac.release(id);
  assert.ok(fs.files.has(`${ROOT}/files/${id}/mac00001.json`));

  const ipad = await device(fs, 'ipad0001');
  assert.equal(await ipad.resolve('Lecture.pdf', pdfBytes('ignored: path is known')), id);
  const doc2 = await ipad.acquire(id);
  assert.deepEqual(ids(doc2.strokes(1)), ['mac1']);
  doc2.apply(1, [st('ipd1', 2)], []);
  await ipad.flush();
  // the iPad never touched the Mac's file
  assert.deepEqual(JSON.parse(fs.files.get(`${ROOT}/files/${id}/mac00001.json`)!.data).pages['1'].map((s: Stroke) => s.id), ['mac1']);
});

test('an open document picks up the other device\'s new ink on poll', async () => {
  const fs = new MemFs();
  const mac = await device(fs, 'mac00001');
  const ipad = await device(fs, 'ipad0001');
  const id = await mac.resolve('A.pdf', pdfBytes('A'));
  const macDoc = await mac.acquire(id);
  const ipadDoc = await ipad.acquire(await ipad.resolve('A.pdf', pdfBytes('A')));
  ipadDoc.apply(2, [st('ipd1')], []);
  await ipad.flush();
  assert.deepEqual(ids(macDoc.strokes(2)), []);
  await mac.poll();
  assert.deepEqual(ids(macDoc.strokes(2)), ['ipd1']);
  // erasing it on the Mac hides it on the iPad after the next sync
  macDoc.apply(2, [], [st('ipd1')]);
  await mac.flush();
  await ipad.poll();
  assert.deepEqual(ids(ipadDoc.strokes(2)), []);
});

test('two devices opening the same new file independently get the same id', async () => {
  const fs1 = new MemFs();
  const fs2 = new MemFs();
  const a = await device(fs1, 'mac00001');
  const b = await device(fs2, 'ipad0001');
  assert.equal(await a.resolve('X.pdf', pdfBytes('same bytes')), await b.resolve('Folder/X.pdf', pdfBytes('same bytes')));
});

test('rename inside Obsidian moves the ink with the file', async () => {
  const fs = new MemFs();
  const mac = await device(fs, 'mac00001');
  const id = await mac.resolve('Old.pdf', pdfBytes('content'));
  await mac.renamed('Old.pdf', 'Sub/New.pdf');
  assert.equal(mac.idForPath('Old.pdf'), null);
  assert.equal(mac.idForPath('Sub/New.pdf'), id);
  // another device sees the rename
  const ipad = await device(fs, 'ipad0001');
  assert.equal(ipad.idForPath('Sub/New.pdf'), id);
});

test('a file renamed outside Obsidian is found again by its content', async () => {
  const fs = new MemFs();
  const mac = await device(fs, 'mac00001');
  const id = await mac.resolve('Book.pdf', pdfBytes('book bytes'));
  const doc = await mac.acquire(id);
  doc.apply(1, [st('mac1')], []);
  await mac.release(id);
  assert.equal(await mac.resolve('Renamed in Finder.pdf', pdfBytes('book bytes')), id);
  assert.equal(mac.idForPath('Renamed in Finder.pdf'), id);
});

test('deleted files keep their ink for 10 days, then it is purged', async () => {
  const fs = new MemFs();
  const mac = await device(fs, 'mac00001');
  const id = await mac.resolve('Gone.pdf', pdfBytes('gone'));
  const doc = await mac.acquire(id);
  doc.apply(1, [st('mac1')], []);
  await mac.release(id);
  const t0 = 1_000_000;
  await mac.deleted('Gone.pdf', t0);
  assert.equal(mac.idForPath('Gone.pdf'), null);
  assert.deepEqual(await mac.purge(t0 + PURGE_AFTER_MS - 1), []);
  // restored within 10 days: the ink comes back
  assert.equal(await mac.resolve('Gone.pdf', pdfBytes('gone')), id);
  const back = await mac.acquire(id);
  assert.deepEqual(ids(back.strokes(1)), ['mac1']);
  await mac.release(id);
  await mac.deleted('Gone.pdf', t0);
  assert.deepEqual(await mac.purge(t0 + PURGE_AFTER_MS), [id]);
  assert.equal(fs.files.has(`${ROOT}/files/${id}/mac00001.json`), false);
});

test('waitingFor reports ink another device saved that has not synced here yet', async () => {
  const fs = new MemFs();
  const ipad = await device(fs, 'ipad0001');
  const id = await ipad.resolve('W.pdf', pdfBytes('w'));
  const doc = await ipad.acquire(id);
  doc.apply(1, [st('ipd1')], []);
  await ipad.release(id);
  // simulate iCloud having synced the registry but not the ink file yet
  fs.files.delete(`${ROOT}/files/${id}/ipad0001.json`);
  const mac = await device(fs, 'mac00001');
  assert.deepEqual(await mac.waitingFor(id), ['ipad0001']);
});

test('a damaged ink file is kept aside, not overwritten', async () => {
  const fs = new MemFs();
  const mac = await device(fs, 'mac00001');
  const id = await mac.resolve('D.pdf', pdfBytes('d'));
  await fs.mkdir(`${ROOT}/files/${id}`);
  await fs.write(`${ROOT}/files/${id}/mac00001.json`, '{"pages": {"1": [ broken');
  const errors: unknown[] = [];
  const s = new InkStore(fs, ROOT, 'mac00001', (e) => errors.push(e));
  await s.init();
  await s.acquire(id);
  assert.equal(errors.length, 1);
  assert.ok([...fs.files.keys()].some((k) => k.includes('mac00001.json.unreadable-')));
});

test('fingerprint is stable and content-sensitive', async () => {
  const a = await fingerprint(await pdfBytes('hello')());
  assert.equal(a, await fingerprint(await pdfBytes('hello')()));
  assert.notEqual(a, await fingerprint(await pdfBytes('hellp')()));
  assert.equal(a.length, 64);
});

test('renaming a folder moves the ink of every file inside', async () => {
  const fs = new MemFs();
  const mac = await device(fs, 'mac00001');
  const a = await mac.resolve('Course/Week 1/A.pdf', pdfBytes('a'));
  const b = await mac.resolve('Course/B.png', pdfBytes('b'));
  const c = await mac.resolve('Coursework/C.pdf', pdfBytes('c'));
  assert.equal(await mac.renamedFolder('Course', 'Archive/Course'), 2);
  assert.equal(mac.idForPath('Archive/Course/Week 1/A.pdf'), a);
  assert.equal(mac.idForPath('Archive/Course/B.png'), b);
  // a folder whose name merely starts the same is untouched
  assert.equal(mac.idForPath('Coursework/C.pdf'), c);
});

test('deleting a folder starts the countdown for every file inside', async () => {
  const fs = new MemFs();
  const mac = await device(fs, 'mac00001');
  await mac.resolve('Old/A.pdf', pdfBytes('a'));
  await mac.resolve('Keep/B.pdf', pdfBytes('b'));
  assert.equal(await mac.deletedFolder('Old', 5), 1);
  assert.equal(mac.idForPath('Old/A.pdf'), null);
  assert.ok(mac.idForPath('Keep/B.pdf'));
});

test('reconcile marks files missing from the vault as deleted', async () => {
  const fs = new MemFs();
  const mac = await device(fs, 'mac00001');
  const gone = await mac.resolve('Gone.pdf', pdfBytes('g'));
  await mac.resolve('Here.pdf', pdfBytes('h'));
  assert.deepEqual(await mac.reconcile((p) => p === 'Here.pdf', 10), [gone]);
  assert.deepEqual(await mac.reconcile((p) => p === 'Here.pdf', 20), []);
});

test('purge never removes ink of a file that is back at its path', async () => {
  const fs = new MemFs();
  const mac = await device(fs, 'mac00001');
  const id = await mac.resolve('Back.pdf', pdfBytes('back'));
  const doc = await mac.acquire(id);
  doc.apply(1, [st('mac1')], []);
  await mac.release(id);
  await mac.deleted('Back.pdf', 1);
  assert.deepEqual(await mac.purge(PURGE_AFTER_MS * 2, (p) => p === 'Back.pdf'), []);
  assert.ok(fs.files.has(`${ROOT}/files/${id}/mac00001.json`));
});

test('purge of a file another device deleted happens once', async () => {
  const fs = new MemFs();
  const ipad = await device(fs, 'ipad0001');
  const id = await ipad.resolve('X.pdf', pdfBytes('x'));
  const doc = await ipad.acquire(id);
  doc.apply(1, [st('ipd1')], []);
  await ipad.release(id);
  await ipad.deleted('X.pdf', 1);
  const mac = await device(fs, 'mac00001');
  assert.deepEqual(await mac.purge(PURGE_AFTER_MS + 1), [id]);
  assert.deepEqual(await mac.purge(PURGE_AFTER_MS + 1), []);
});

test('a document reopened soon after closing keeps its undo history', async () => {
  const fs = new MemFs();
  const mac = new InkStore(fs, ROOT, 'mac00001', noErrors, 50);
  await mac.init();
  const id = await mac.resolve('U.pdf', pdfBytes('u'));
  const doc = await mac.acquire(id);
  doc.apply(1, [st('mac1')], []);
  await mac.release(id);
  // the embed is rebuilt (editor re-render) before the keep-alive ends
  const again = await mac.acquire(id);
  assert.equal(again, doc);
  assert.equal(again.canUndo(1), true);
  await mac.release(id);
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(mac.openFileIds(), []);
  // saved before it was forgotten
  assert.ok(fs.files.has(`${ROOT}/files/${id}/mac00001.json`));
});
