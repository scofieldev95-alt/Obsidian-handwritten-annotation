import { InkDocument } from '../model/document.ts';
import { validDeviceInk } from './validate.ts';

/** The file operations we need (Obsidian's DataAdapter has exactly these). */
export interface StorageAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  mkdir(path: string): Promise<void>;
  rmdir(path: string, recursive: boolean): Promise<void>;
  stat(path: string): Promise<{ mtime: number; size: number } | null>;
}

/** What a device knows about one annotated file. */
export interface RegistryEntry {
  /** Vault path of the PDF or image. */
  path: string;
  /** When this entry last changed (ms). The newest entry across devices wins. */
  updated: number;
  /** Set when the file was deleted (ms); the ink is purged 10 days later. */
  deleted?: number;
  /** This device has saved ink for the file. */
  ink?: boolean;
}

interface RegistryFile {
  v: 1;
  device: string;
  files: Record<string, RegistryEntry>;
}

interface OpenDoc {
  doc: InkDocument;
  refs: number;
  /** mtime of each other device's file when we last read it. */
  seen: Map<string, number>;
  saveTimer: ReturnType<typeof setTimeout> | null;
  dirty: boolean;
  off: () => void;
}

export const PURGE_AFTER_MS = 10 * 24 * 60 * 60 * 1000;
const SAVE_DELAY_MS = 300;
const FILE_ID = /^[0-9a-f]{20}$/;
const DEVICE_FILE = /^([0-9a-z]{4,16})\.json$/;

/**
 * Hidden ink storage inside the vault's config folder, synced by iCloud with the rest of it:
 *
 *   <root>/registry/<device>.json        which vault file each file id belongs to
 *   <root>/files/<fileId>/<device>.json  the ink each device wrote for that file
 *
 * A device only ever writes files named after itself, so two devices never change the same file
 * and iCloud has nothing to conflict on. Reading merges every device's files.
 */
export class InkStore {
  private readonly adapter: StorageAdapter;
  private readonly root: string;
  readonly deviceId: string;
  /** Every device's registry, including ours. */
  private registries = new Map<string, Record<string, RegistryEntry>>();
  private registryMtimes = new Map<string, number>();
  private readonly docs = new Map<string, OpenDoc>();
  private readonly opening = new Map<string, Promise<InkDocument>>();
  private registryWrite: Promise<void> = Promise.resolve();
  private readonly onError: (err: unknown) => void;

  constructor(adapter: StorageAdapter, root: string, deviceId: string, onError: (err: unknown) => void = console.error) {
    this.adapter = adapter;
    this.root = root.replace(/\/+$/, '');
    this.deviceId = deviceId;
    this.onError = onError;
  }

  async init(): Promise<void> {
    await this.ensureDir(`${this.root}/registry`);
    await this.ensureDir(`${this.root}/files`);
    await this.loadRegistries();
  }

  // ---- registry ----

  /** The newest entry for each file id across devices. */
  merged(): Map<string, RegistryEntry> {
    const out = new Map<string, RegistryEntry>();
    for (const files of this.registries.values()) {
      for (const [id, e] of Object.entries(files)) {
        const cur = out.get(id);
        if (!cur || e.updated > cur.updated) out.set(id, e);
      }
    }
    return out;
  }

  /** File id for a vault path, if the file is known (and not deleted). */
  idForPath(path: string): string | null {
    for (const [id, e] of this.merged()) if (e.path === path && !e.deleted) return id;
    return null;
  }

  /**
   * File id for a file being opened. Known path → its id. Otherwise the id comes from the file's
   * content fingerprint, so a file renamed outside Obsidian (or restored after deletion) finds its
   * ink again, and two devices opening the same new file pick the same id.
   */
  async resolve(path: string, bytes: () => Promise<ArrayBuffer>): Promise<string> {
    const known = this.idForPath(path);
    if (known) return known;
    const id = (await fingerprint(await bytes())).slice(0, 20);
    const cur = this.merged().get(id);
    if (!cur || cur.path !== path || cur.deleted) {
      this.setOwnEntry(id, { path, updated: Date.now(), ink: this.ownEntry(id)?.ink });
      await this.saveRegistry();
    }
    return id;
  }

  /** A file was renamed or moved inside Obsidian: its ink follows. */
  async renamed(oldPath: string, newPath: string): Promise<boolean> {
    const id = this.idForPath(oldPath);
    if (!id) return false;
    this.setOwnEntry(id, { ...this.merged().get(id)!, path: newPath, updated: Date.now(), deleted: undefined, ink: this.ownEntry(id)?.ink });
    await this.saveRegistry();
    return true;
  }

  /** A file was deleted: keep its ink for 10 days in case it comes back. */
  async deleted(path: string, now = Date.now()): Promise<boolean> {
    const id = this.idForPath(path);
    if (!id) return false;
    this.setOwnEntry(id, { ...this.merged().get(id)!, deleted: now, updated: now, ink: this.ownEntry(id)?.ink });
    await this.saveRegistry();
    return true;
  }

  /** Remove ink of files deleted more than 10 days ago. Returns the purged ids. */
  async purge(now = Date.now()): Promise<string[]> {
    const purged: string[] = [];
    for (const [id, e] of this.merged()) {
      if (!e.deleted || now - e.deleted < PURGE_AFTER_MS || this.docs.has(id)) continue;
      try {
        if (await this.adapter.exists(this.fileDir(id))) await this.adapter.rmdir(this.fileDir(id), true);
      } catch (err) {
        this.onError(err);
        continue;
      }
      purged.push(id);
      const own = this.registries.get(this.deviceId);
      if (own) delete own[id];
    }
    if (purged.length) await this.saveRegistry();
    return purged;
  }

  /** Devices that have saved ink for this file which hasn't reached this device yet (iCloud still syncing). */
  async waitingFor(fileId: string): Promise<string[]> {
    const waiting: string[] = [];
    for (const [device, files] of this.registries) {
      if (device === this.deviceId || !files[fileId]?.ink) continue;
      if (!(await this.adapter.exists(this.deviceFile(fileId, device)))) waiting.push(device);
    }
    return waiting;
  }

  // ---- documents ----

  /** Open the ink of a file (shared while open; call release when done). */
  async acquire(fileId: string): Promise<InkDocument> {
    if (!FILE_ID.test(fileId)) throw new Error(`bad file id ${fileId}`);
    const open = this.docs.get(fileId);
    if (open) {
      open.refs++;
      return open.doc;
    }
    let p = this.opening.get(fileId);
    if (!p) {
      p = this.load(fileId).finally(() => this.opening.delete(fileId));
      this.opening.set(fileId, p);
    }
    const doc = await p;
    this.docs.get(fileId)!.refs++;
    return doc;
  }

  /** Done with a document: saves pending changes; forgets it when nothing uses it. */
  async release(fileId: string): Promise<void> {
    const open = this.docs.get(fileId);
    if (!open) return;
    open.refs--;
    if (open.refs > 0) return;
    await this.saveNow(fileId);
    if (open.refs <= 0) {
      open.off();
      this.docs.delete(fileId);
    }
  }

  /** Save everything pending now (app going to background, plugin unloading). */
  async flush(): Promise<void> {
    await Promise.all([...this.docs.keys()].map((id) => this.saveNow(id)));
    await this.registryWrite;
  }

  /** Pick up ink other devices wrote since we last looked. */
  async poll(): Promise<void> {
    await this.loadRegistries();
    for (const [id, open] of this.docs) {
      try {
        await this.readRemotes(id, open);
      } catch (err) {
        this.onError(err);
      }
    }
  }

  openFileIds(): string[] {
    return [...this.docs.keys()];
  }

  private async load(fileId: string): Promise<InkDocument> {
    const doc = new InkDocument(this.deviceId);
    const own = this.deviceFile(fileId, this.deviceId);
    if (await this.adapter.exists(own)) {
      try {
        doc.loadOwn(validDeviceInk(JSON.parse(await this.adapter.read(own))));
      } catch (err) {
        // never overwrite a file we couldn't read: keep a copy before it gets replaced
        this.onError(err);
        try {
          await this.adapter.write(`${own}.unreadable-${Date.now()}`, await this.adapter.read(own));
        } catch {
          // nothing more we can do
        }
      }
    }
    const open: OpenDoc = { doc, refs: 0, seen: new Map(), saveTimer: null, dirty: false, off: () => {} };
    open.off = doc.onChange((_page, local) => {
      if (local) this.scheduleSave(fileId, open);
    });
    this.docs.set(fileId, open);
    await this.readRemotes(fileId, open);
    return doc;
  }

  private async readRemotes(fileId: string, open: OpenDoc): Promise<void> {
    const dir = this.fileDir(fileId);
    if (!(await this.adapter.exists(dir))) return;
    const listing = await this.adapter.list(dir);
    const present = new Set<string>();
    for (const path of listing.files) {
      const m = DEVICE_FILE.exec(basename(path));
      if (!m || m[1] === this.deviceId) continue;
      const device = m[1];
      present.add(device);
      const st = await this.adapter.stat(path);
      const mtime = st?.mtime ?? 0;
      if (open.seen.get(device) === mtime) continue;
      try {
        open.doc.setRemote(device, validDeviceInk(JSON.parse(await this.adapter.read(path))));
        open.seen.set(device, mtime);
      } catch (err) {
        // half-synced file: try again next time
        this.onError(err);
      }
    }
    for (const device of open.doc.remoteDevices()) {
      if (!present.has(device)) {
        open.doc.setRemote(device, null);
        open.seen.delete(device);
      }
    }
  }

  private scheduleSave(fileId: string, open: OpenDoc): void {
    open.dirty = true;
    if (open.saveTimer) clearTimeout(open.saveTimer);
    open.saveTimer = setTimeout(() => void this.saveNow(fileId), SAVE_DELAY_MS);
  }

  private async saveNow(fileId: string): Promise<void> {
    const open = this.docs.get(fileId);
    if (!open) return;
    if (open.saveTimer) {
      clearTimeout(open.saveTimer);
      open.saveTimer = null;
    }
    if (!open.dirty) return;
    open.dirty = false;
    const data = open.doc.ownData();
    const hasInk = Object.keys(data.pages).length > 0 || data.deleted.length > 0;
    try {
      await this.ensureDir(this.fileDir(fileId));
      await this.adapter.write(this.deviceFile(fileId, this.deviceId), JSON.stringify({ v: 1, device: this.deviceId, updated: Date.now(), ...data }));
    } catch (err) {
      open.dirty = true;
      this.onError(err);
      return;
    }
    const entry = this.ownEntry(fileId) ?? this.merged().get(fileId);
    if (entry && entry.ink !== hasInk) {
      this.setOwnEntry(fileId, { ...entry, ink: hasInk });
      await this.saveRegistry();
    }
  }

  // ---- files ----

  private fileDir(fileId: string): string {
    return `${this.root}/files/${fileId}`;
  }

  private deviceFile(fileId: string, device: string): string {
    return `${this.fileDir(fileId)}/${device}.json`;
  }

  private ownEntry(id: string): RegistryEntry | undefined {
    return this.registries.get(this.deviceId)?.[id];
  }

  private setOwnEntry(id: string, e: RegistryEntry): void {
    let own = this.registries.get(this.deviceId);
    if (!own) {
      own = {};
      this.registries.set(this.deviceId, own);
    }
    const clean: RegistryEntry = { path: e.path, updated: e.updated };
    if (e.deleted) clean.deleted = e.deleted;
    if (e.ink) clean.ink = true;
    own[id] = clean;
  }

  private async loadRegistries(): Promise<void> {
    const dir = `${this.root}/registry`;
    if (!(await this.adapter.exists(dir))) return;
    const { files } = await this.adapter.list(dir);
    for (const path of files) {
      const m = DEVICE_FILE.exec(basename(path));
      if (!m) continue;
      const device = m[1];
      const st = await this.adapter.stat(path);
      const mtime = st?.mtime ?? 0;
      // our own registry lives in memory once loaded; only read it from disk the first time
      if (device === this.deviceId && this.registries.has(device)) continue;
      if (this.registryMtimes.get(device) === mtime) continue;
      try {
        const raw = JSON.parse(await this.adapter.read(path)) as Partial<RegistryFile>;
        this.registries.set(device, validRegistry(raw.files));
        this.registryMtimes.set(device, mtime);
      } catch (err) {
        this.onError(err);
      }
    }
  }

  private saveRegistry(): Promise<void> {
    // writes are chained so they never overlap
    this.registryWrite = this.registryWrite.then(async () => {
      const files = this.registries.get(this.deviceId) ?? {};
      const body: RegistryFile = { v: 1, device: this.deviceId, files };
      try {
        await this.adapter.write(`${this.root}/registry/${this.deviceId}.json`, JSON.stringify(body));
      } catch (err) {
        this.onError(err);
      }
    });
    return this.registryWrite;
  }

  private async ensureDir(path: string): Promise<void> {
    if (!(await this.adapter.exists(path))) await this.adapter.mkdir(path);
  }
}

function validRegistry(raw: unknown): Record<string, RegistryEntry> {
  const out: Record<string, RegistryEntry> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, e] of Object.entries(raw as Record<string, unknown>)) {
    if (!FILE_ID.test(id) || !e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    if (typeof r.path !== 'string' || !r.path || typeof r.updated !== 'number') continue;
    const entry: RegistryEntry = { path: r.path, updated: r.updated };
    if (typeof r.deleted === 'number') entry.deleted = r.deleted;
    if (r.ink === true) entry.ink = true;
    out[id] = entry;
  }
  return out;
}

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

const SAMPLE = 256 * 1024;

/**
 * Content fingerprint: SHA-256 of the size plus the first and last 256 KB. Fast even for large
 * PDFs, and stable when the file is renamed or moved.
 */
export async function fingerprint(bytes: ArrayBuffer): Promise<string> {
  const size = bytes.byteLength;
  const head = new Uint8Array(bytes, 0, Math.min(SAMPLE, size));
  const tailStart = Math.max(head.length, size - SAMPLE);
  const tail = new Uint8Array(bytes, tailStart, size - tailStart);
  const buf = new Uint8Array(8 + head.length + tail.length);
  new DataView(buf.buffer).setFloat64(0, size);
  buf.set(head, 8);
  buf.set(tail, 8 + head.length);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
