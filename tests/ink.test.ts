import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StrokeBuilder, makeStroke } from '../src/ink/builder.ts';
import { densify, outlineStroke, radiusAt, strokeBounds, type PathSink } from '../src/ink/geometry.ts';
import { eraseFromStroke, lassoSelect, pointInPolygon, strokeTouched, translateStroke } from '../src/ink/hit.ts';
import type { Stroke } from '../src/ink/types.ts';

function line(id: string, x0: number, y0: number, x1: number, y1: number, n = 20, width = 2): Stroke {
  const pts: number[] = [];
  for (let i = 0; i <= n; i++) pts.push(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, 0.5);
  return makeStroke(id, 'pen', '#000000', width, false, pts, i0(id));
}
function i0(id: string): number {
  return id.charCodeAt(0);
}

test('builder smooths jitter but ends where the pen lifted', () => {
  const b = new StrokeBuilder(2, false);
  for (let i = 0; i <= 100; i++) b.add({ x: i, y: 50 + (i % 2 ? 0.4 : -0.4), p: 0.5, t: i * 8 });
  const pts = b.finish();
  const n = pts.length / 3;
  assert.ok(n > 20);
  // jitter of ±0.4 is reduced
  let maxDev = 0;
  for (let i = 5; i < n - 1; i++) maxDev = Math.max(maxDev, Math.abs(pts[3 * i + 1] - 50));
  assert.ok(maxDev < 0.3, `max deviation ${maxDev}`);
  assert.equal(pts[3 * (n - 1)], 100);
});

test('builder without pressure stores constant 0.5', () => {
  const b = new StrokeBuilder(1, false);
  for (let i = 0; i < 10; i++) b.add({ x: i * 5, y: 0, p: 0.9, t: i * 10 });
  const pts = b.finish();
  for (let i = 2; i < pts.length; i += 3) assert.equal(pts[i], 0.5);
});

test('radius follows pressure only for pressure pens', () => {
  const pen = { width: 2, pressure: true, tool: 'pen' as const };
  assert.ok(radiusAt(pen, 1) > radiusAt(pen, 0.2));
  assert.equal(radiusAt({ ...pen, pressure: false }, 1), 1);
  assert.equal(radiusAt({ ...pen, tool: 'highlighter' }, 1), 1);
});

test('densify keeps the endpoints and adds points on long segments', () => {
  const pts = [0, 0, 0.5, 10, 0, 0.5, 20, 10, 0.5];
  const d = densify(pts, 1);
  assert.deepEqual(d.slice(0, 3), [0, 0, 0.5]);
  assert.deepEqual(d.slice(-3), [20, 10, 0.5]);
  assert.ok(d.length / 3 > 20);
});

test('outline emits one closed sub-path per segment', () => {
  const calls: string[] = [];
  const sink: PathSink = {
    moveTo: () => calls.push('M'),
    lineTo: () => calls.push('L'),
    arc: () => calls.push('A'),
    closePath: () => calls.push('Z'),
  };
  outlineStroke(line('a', 0, 0, 1, 0, 1), sink);
  assert.deepEqual(calls, ['M', 'A', 'L', 'A', 'Z']);
});

test('bounds include the width', () => {
  const b = strokeBounds(line('a', 10, 10, 20, 10, 2, 4));
  assert.deepEqual(b, { minX: 8, minY: 8, maxX: 22, maxY: 12 });
});

test('eraser hits a stroke it crosses and misses one far away', () => {
  const s = line('a', 0, 50, 100, 50);
  assert.ok(strokeTouched(s, 50, 0, 50, 100, 2));
  assert.ok(!strokeTouched(s, 50, 0, 50, 40, 2));
});

test('partial erase splits a line into two pieces', () => {
  const s = line('a', 0, 50, 100, 50);
  const pieces = eraseFromStroke(s, 50, 0, 50, 100, 5);
  assert.ok(pieces);
  assert.equal(pieces.length, 2);
  const leftEnd = pieces[0][pieces[0].length - 3];
  const rightStart = pieces[1][0];
  assert.ok(leftEnd < 46 && leftEnd > 40, `left end ${leftEnd}`);
  assert.ok(rightStart > 54 && rightStart < 60, `right start ${rightStart}`);
});

test('partial erase of the whole stroke leaves nothing; untouched returns null', () => {
  const s = line('a', 0, 50, 10, 50);
  assert.deepEqual(eraseFromStroke(s, -5, 50, 15, 50, 4), []);
  assert.equal(eraseFromStroke(s, 0, 0, 10, 0, 4), null);
});

test('lasso selects strokes mostly inside the loop', () => {
  const inside = line('a', 10, 10, 20, 10);
  const outside = line('b', 100, 100, 120, 100);
  const half = line('c', 25, 15, 55, 15);
  const poly = [0, 0, 40, 0, 40, 30, 0, 30];
  assert.ok(pointInPolygon(5, 5, poly));
  assert.deepEqual(lassoSelect([inside, outside, half], poly), ['a']);
});

test('translate copies with a new id', () => {
  const s = line('a', 0, 0, 10, 0, 1);
  const t = translateStroke(s, 5, 3, 'z');
  assert.equal(t.id, 'z');
  assert.deepEqual(t.pts.slice(0, 2), [5, 3]);
  assert.deepEqual(s.pts.slice(0, 2), [0, 0]);
});
