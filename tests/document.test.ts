import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InkDocument } from '../src/model/document.ts';
import type { Stroke } from '../src/ink/types.ts';

function st(id: string, at: number): Stroke {
  return { id, tool: 'pen', color: '#000000', width: 2, pressure: false, pts: [0, 0, 0.5, 10, 10, 0.5], at };
}
const ids = (list: readonly Stroke[]) => list.map((s) => s.id);

test('add, undo, redo on a page', () => {
  const d = new InkDocument('mac1');
  d.apply(1, [st('a', 1)], []);
  d.apply(1, [st('b', 2)], []);
  assert.deepEqual(ids(d.strokes(1)), ['a', 'b']);
  d.undo(1);
  assert.deepEqual(ids(d.strokes(1)), ['a']);
  d.redo(1);
  assert.deepEqual(ids(d.strokes(1)), ['a', 'b']);
  assert.deepEqual(ids(d.strokes(2)), []);
});

test('history is per page', () => {
  const d = new InkDocument('mac1');
  d.apply(1, [st('a', 1)], []);
  d.apply(2, [st('b', 2)], []);
  assert.equal(d.undo(1), true);
  assert.deepEqual(ids(d.strokes(2)), ['b']);
  assert.equal(d.canUndo(1), false);
});

test('ink from other devices merges, and erasing it is remembered locally', () => {
  const d = new InkDocument('mac1');
  d.apply(1, [st('mine', 2)], []);
  d.setRemote('ipad', { pages: { '1': [st('theirs', 1)] }, deleted: [] });
  assert.deepEqual(ids(d.strokes(1)), ['theirs', 'mine']);
  d.apply(1, [], [st('theirs', 1)]);
  assert.deepEqual(ids(d.strokes(1)), ['mine']);
  assert.deepEqual(d.ownData().deleted, ['theirs']);
  // their file still has it; we only hide it
  d.undo(1);
  assert.deepEqual(ids(d.strokes(1)), ['theirs', 'mine']);
  assert.deepEqual(d.ownData().deleted, []);
});

test('another device erasing my stroke hides it here too', () => {
  const d = new InkDocument('mac1');
  d.apply(1, [st('mine', 1)], []);
  d.setRemote('ipad', { pages: {}, deleted: ['mine'] });
  assert.deepEqual(ids(d.strokes(1)), []);
});

test('erasing my own stroke removes it from my data (no tombstone needed)', () => {
  const d = new InkDocument('mac1');
  d.apply(1, [st('a', 1)], []);
  d.apply(1, [], [st('a', 1)]);
  assert.deepEqual(d.ownData(), { pages: {}, deleted: [], view: undefined });
});

test('saved data round-trips', () => {
  const d = new InkDocument('mac1');
  d.apply(3, [st('a', 1)], []);
  d.setViewedPage(3, 100);
  const e = new InkDocument('mac1');
  e.loadOwn(JSON.parse(JSON.stringify(d.ownData())));
  assert.deepEqual(ids(e.strokes(3)), ['a']);
  assert.equal(e.lastViewedPage(), 3);
});

test('last viewed page: the most recent device wins', () => {
  const d = new InkDocument('mac1');
  d.setViewedPage(2, 100);
  d.setRemote('ipad', { pages: {}, deleted: [], view: { page: 7, at: 200 } });
  assert.equal(d.lastViewedPage(), 7);
  d.setViewedPage(4, 300);
  assert.equal(d.lastViewedPage(), 4);
});

test('change listener reports local vs remote changes', () => {
  const d = new InkDocument('mac1');
  const seen: string[] = [];
  d.onChange((page, local) => seen.push(`${page}:${local}`));
  d.apply(1, [st('a', 1)], []);
  d.setRemote('ipad', { pages: {}, deleted: [] });
  assert.deepEqual(seen, ['1:true', 'null:false']);
});
