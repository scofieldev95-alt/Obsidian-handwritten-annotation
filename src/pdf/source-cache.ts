import type { App, TFile } from 'obsidian';
import type { PageSource } from '../surface/annotator.ts';

interface Entry<T> {
  key: string;
  promise: Promise<T>;
  refs: number;
  timer: number;
}

/**
 * Keeps opened PDFs / images shared between everything that shows them (several embeds, the
 * full-screen view) and alive for a short while after the last one closes — the editor rebuilds
 * embeds while you scroll, and re-parsing a big PDF each time would be slow.
 */
export class SourceCache<T extends PageSource & { destroy(): void }> {
  private readonly app: App;
  private readonly open: (bytes: ArrayBuffer, file: TFile) => Promise<T>;
  private readonly entries = new Map<string, Entry<T>>();
  private readonly keepMs: number;

  constructor(app: App, open: (bytes: ArrayBuffer, file: TFile) => Promise<T>, keepMs = 60_000) {
    this.app = app;
    this.open = open;
    this.keepMs = keepMs;
  }

  /** The source for a file, plus a release function. `bytes` reuses an already-read file. */
  async acquire(file: TFile, bytes?: ArrayBuffer): Promise<{ source: T; release: () => void }> {
    const key = `${file.path}\u0000${file.stat.mtime}\u0000${file.stat.size}`;
    let e = this.entries.get(file.path);
    if (e && e.key !== key) {
      // the file changed on disk: drop the old copy once nobody uses it
      this.entries.delete(file.path);
      if (e.refs <= 0) void e.promise.then((s) => s.destroy(), () => {});
      e = undefined;
    }
    if (!e) {
      const entry: Entry<T> = {
        key,
        refs: 0,
        timer: 0,
        promise: (async () => this.open(bytes ?? (await this.app.vault.readBinary(file)), file))(),
      };
      entry.promise.catch(() => {
        if (this.entries.get(file.path) === entry) this.entries.delete(file.path);
      });
      this.entries.set(file.path, entry);
      e = entry;
    }
    const entry = e;
    entry.refs++;
    window.clearTimeout(entry.timer);
    let source: T;
    try {
      source = await entry.promise;
    } catch (err) {
      entry.refs--;
      throw err;
    }
    let released = false;
    return {
      source,
      release: () => {
        if (released) return;
        released = true;
        entry.refs--;
        if (entry.refs > 0) return;
        entry.timer = window.setTimeout(() => {
          if (entry.refs > 0) return;
          if (this.entries.get(file.path) === entry) this.entries.delete(file.path);
          source.destroy();
        }, this.keepMs);
      },
    };
  }

  clear(): void {
    for (const e of this.entries.values()) {
      window.clearTimeout(e.timer);
      void e.promise.then((s) => s.destroy(), () => {});
    }
    this.entries.clear();
  }
}
