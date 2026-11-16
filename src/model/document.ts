import type { Stroke } from '../ink/types.ts';

/** What one device has written for one file. Each device only ever writes its own copy. */
export interface DeviceInk {
  /** Strokes this device wrote that are still alive, by page number (1-based). */
  pages: Record<string, Stroke[]>;
  /** Ids of strokes written by *other* devices that this device erased. */
  deleted: string[];
  /** The page this device last looked at, and when. */
  view?: { page: number; at: number };
}

/** One undoable step on one page. Editing is always "remove these, add those". */
export interface PageOp {
  added: Stroke[];
  removed: Stroke[];
}

interface RemoteInk {
  pages: Map<number, Stroke[]>;
  deleted: Set<string>;
  view?: { page: number; at: number };
}

export type ChangeListener = (page: number | null, local: boolean) => void;

const MAX_HISTORY = 200;

/**
 * All the ink of one PDF or image. Visible ink = every device's strokes, minus every device's
 * erased ids. Because devices never write each other's data, merging is just a union — there is
 * nothing for iCloud to conflict on.
 */
export class InkDocument {
  readonly deviceId: string;
  private readonly own = new Map<number, Stroke[]>();
  private readonly ownIndex = new Map<string, number>();
  private readonly deleted = new Set<string>();
  private readonly remote = new Map<string, RemoteInk>();
  private readonly remoteIndex = new Map<string, number>();
  private readonly cache = new Map<number, Stroke[]>();
  private readonly undoStacks = new Map<number, PageOp[]>();
  private readonly redoStacks = new Map<number, PageOp[]>();
  private readonly listeners = new Set<ChangeListener>();
  private view: { page: number; at: number } | undefined;

  constructor(deviceId: string) {
    this.deviceId = deviceId;
  }

  /** Visible strokes of a page, in paint order. */
  strokes(page: number): readonly Stroke[] {
    let list = this.cache.get(page);
    if (list) return list;
    const gone = new Set(this.deleted);
    for (const r of this.remote.values()) for (const id of r.deleted) gone.add(id);
    list = [];
    for (const s of this.own.get(page) ?? []) if (!gone.has(s.id)) list.push(s);
    for (const r of this.remote.values()) for (const s of r.pages.get(page) ?? []) if (!gone.has(s.id)) list.push(s);
    list.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this.cache.set(page, list);
    return list;
  }

  /** Pages that have any visible ink. */
  inkedPages(): number[] {
    const pages = new Set<number>([...this.own.keys()]);
    for (const r of this.remote.values()) for (const p of r.pages.keys()) pages.add(p);
    return [...pages].filter((p) => this.strokes(p).length > 0).sort((a, b) => a - b);
  }

  /** Remove and add strokes on a page; recorded for undo unless `record` is false. */
  apply(page: number, added: readonly Stroke[], removed: readonly Stroke[], record = true): void {
    if (!added.length && !removed.length) return;
    for (const s of removed) this.removeOne(s.id);
    for (const s of added) this.addOne(page, s);
    if (record) this.record(page, { added: [...added], removed: [...removed] });
    this.changed(page, true);
  }

  /** Record a step whose changes were already applied (e.g. a whole eraser drag). */
  pushHistory(page: number, op: PageOp): void {
    if (!op.added.length && !op.removed.length) return;
    this.record(page, op);
    this.changed(page, true);
  }

  private record(page: number, op: PageOp): void {
    const stack = this.undoStacks.get(page) ?? [];
    stack.push(op);
    if (stack.length > MAX_HISTORY) stack.shift();
    this.undoStacks.set(page, stack);
    this.redoStacks.delete(page);
  }

  canUndo(page: number): boolean {
    return (this.undoStacks.get(page)?.length ?? 0) > 0;
  }

  canRedo(page: number): boolean {
    return (this.redoStacks.get(page)?.length ?? 0) > 0;
  }

  undo(page: number): boolean {
    const op = this.undoStacks.get(page)?.pop();
    if (!op) return false;
    for (const s of op.added) this.removeOne(s.id);
    for (const s of op.removed) this.addOne(page, s);
    const redo = this.redoStacks.get(page) ?? [];
    redo.push(op);
    this.redoStacks.set(page, redo);
    this.changed(page, true);
    return true;
  }

  redo(page: number): boolean {
    const op = this.redoStacks.get(page)?.pop();
    if (!op) return false;
    for (const s of op.removed) this.removeOne(s.id);
    for (const s of op.added) this.addOne(page, s);
    const undo = this.undoStacks.get(page) ?? [];
    undo.push(op);
    this.undoStacks.set(page, undo);
    this.changed(page, true);
    return true;
  }

  /** The page to open on: the most recent "last viewed page" across all devices. */
  lastViewedPage(): number | null {
    let best = this.view;
    for (const r of this.remote.values()) if (r.view && (!best || r.view.at > best.at)) best = r.view;
    return best ? best.page : null;
  }

  setViewedPage(page: number, at = Date.now()): void {
    if (this.view?.page === page) return;
    this.view = { page, at };
    this.changed(null, true);
  }

  /** This device's data, for saving. */
  ownData(): DeviceInk {
    const pages: Record<string, Stroke[]> = {};
    for (const [p, list] of this.own) if (list.length) pages[String(p)] = list;
    return { pages, deleted: [...this.deleted], view: this.view };
  }

  /** Load this device's saved data (on open). Clears history. */
  loadOwn(data: DeviceInk): void {
    this.own.clear();
    this.ownIndex.clear();
    this.deleted.clear();
    for (const [key, list] of Object.entries(data.pages ?? {})) {
      const page = Number(key);
      if (!Number.isInteger(page) || page < 1 || !Array.isArray(list)) continue;
      this.own.set(page, list.slice());
      for (const s of list) this.ownIndex.set(s.id, page);
    }
    for (const id of data.deleted ?? []) this.deleted.add(id);
    this.view = data.view;
    this.undoStacks.clear();
    this.redoStacks.clear();
    this.changed(null, false);
  }

  /** Replace what we know of another device's data (on open, or when iCloud brings an update). */
  setRemote(device: string, data: DeviceInk | null): void {
    if (device === this.deviceId) return;
    if (data) {
      const pages = new Map<number, Stroke[]>();
      for (const [key, list] of Object.entries(data.pages ?? {})) {
        const page = Number(key);
        if (Number.isInteger(page) && page >= 1 && Array.isArray(list)) pages.set(page, list);
      }
      this.remote.set(device, { pages, deleted: new Set(data.deleted ?? []), view: data.view });
    } else {
      this.remote.delete(device);
    }
    this.remoteIndex.clear();
    for (const r of this.remote.values()) for (const [p, list] of r.pages) for (const s of list) this.remoteIndex.set(s.id, p);
    this.changed(null, false);
  }

  remoteDevices(): string[] {
    return [...this.remote.keys()];
  }

  onChange(fn: ChangeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private addOne(page: number, s: Stroke): void {
    if (this.remoteIndex.has(s.id)) {
      // bringing back another device's stroke: just stop hiding it
      this.deleted.delete(s.id);
      return;
    }
    if (this.ownIndex.has(s.id)) return;
    const list = this.own.get(page) ?? [];
    list.push(s);
    this.own.set(page, list);
    this.ownIndex.set(s.id, page);
  }

  private removeOne(id: string): void {
    const ownPage = this.ownIndex.get(id);
    if (ownPage !== undefined) {
      const list = this.own.get(ownPage);
      if (list) {
        const i = list.findIndex((s) => s.id === id);
        if (i >= 0) list.splice(i, 1);
      }
      this.ownIndex.delete(id);
      return;
    }
    // another device's stroke: we can't touch their file, so remember that we erased it
    if (this.remoteIndex.has(id)) this.deleted.add(id);
  }

  private changed(page: number | null, local: boolean): void {
    if (page === null) this.cache.clear();
    else this.cache.delete(page);
    for (const fn of this.listeners) fn(page, local);
  }
}
