// Everything that uses Obsidian APIs which are not part of the official plugin API lives here, so
// it is easy to review and to adapt when Obsidian changes. Each function fails safe: if the
// internal API is missing, it returns false and the plugin falls back to public behaviour.

import type { App } from 'obsidian';

interface ViewRegistry {
  typeByExtension: Record<string, string>;
  registerExtensions(exts: string[], type: string): void;
  unregisterExtensions(exts: string[]): void;
}

function viewRegistry(app: App): ViewRegistry | null {
  const reg = (app as unknown as { viewRegistry?: ViewRegistry }).viewRegistry;
  if (!reg || typeof reg.registerExtensions !== 'function' || typeof reg.unregisterExtensions !== 'function' || !reg.typeByExtension) {
    return null;
  }
  return reg;
}

/**
 * Make our view the one that opens files with this extension (instead of Obsidian's). Returns a
 * function that gives the extension back, or null if this Obsidian version doesn't allow it.
 */
export function takeOverExtension(app: App, ext: string, viewType: string): (() => void) | null {
  const reg = viewRegistry(app);
  if (!reg) return null;
  const previous = reg.typeByExtension[ext];
  try {
    if (previous !== undefined) reg.unregisterExtensions([ext]);
    reg.registerExtensions([ext], viewType);
  } catch (err) {
    console.error('[Handwritten Annotation] could not open PDFs with the annotation view', err);
    try {
      if (previous !== undefined && reg.typeByExtension[ext] === undefined) reg.registerExtensions([ext], previous);
    } catch {
      // leave Obsidian as it is
    }
    return null;
  }
  return () => {
    try {
      if (reg.typeByExtension[ext] === viewType) reg.unregisterExtensions([ext]);
      if (previous !== undefined && reg.typeByExtension[ext] === undefined) reg.registerExtensions([ext], previous);
    } catch (err) {
      console.error('[Handwritten Annotation] could not restore the PDF viewer', err);
    }
  };
}

/** Creates an embed: Obsidian passes its context, the file and the link's subpath (`#page=4`). */
export type EmbedCreator = (ctx: unknown, file: unknown, subpath: string) => unknown;

interface EmbedRegistry {
  embedByExtension: Record<string, EmbedCreator | undefined>;
  registerExtension(ext: string, creator: EmbedCreator): void;
  unregisterExtension(ext: string): void;
}

function embedRegistry(app: App): EmbedRegistry | null {
  const reg = (app as unknown as { embedRegistry?: EmbedRegistry }).embedRegistry;
  if (!reg || typeof reg.registerExtension !== 'function' || typeof reg.unregisterExtension !== 'function' || !reg.embedByExtension) {
    return null;
  }
  return reg;
}

/**
 * Show `![[file.ext]]` embeds with our creator instead of Obsidian's. Returns a function that
 * restores Obsidian's, or null if this Obsidian version doesn't allow it.
 */
export function takeOverEmbed(app: App, ext: string, creator: EmbedCreator): (() => void) | null {
  const reg = embedRegistry(app);
  if (!reg) return null;
  const previous = reg.embedByExtension[ext];
  try {
    if (previous) reg.unregisterExtension(ext);
    reg.registerExtension(ext, creator);
  } catch (err) {
    console.error(`[Handwritten Annotation] could not take over .${ext} embeds`, err);
    try {
      if (previous && !reg.embedByExtension[ext]) reg.registerExtension(ext, previous);
    } catch {
      // leave Obsidian as it is
    }
    return null;
  }
  return () => {
    try {
      if (reg.embedByExtension[ext] === creator) reg.unregisterExtension(ext);
      if (previous && !reg.embedByExtension[ext]) reg.registerExtension(ext, previous);
    } catch (err) {
      console.error(`[Handwritten Annotation] could not restore .${ext} embeds`, err);
    }
  };
}

/** Re-render open notes so embeds already on screen switch to (or away from) our version. */
export function rerenderMarkdownViews(app: App): void {
  app.workspace.iterateAllLeaves((leaf) => {
    const view = leaf.view as unknown as {
      getViewType(): string;
      previewMode?: { rerender?(full?: boolean): void };
      editor?: { cm?: { dispatch(spec: object): void } };
    };
    if (view.getViewType() !== 'markdown') return;
    try {
      view.previewMode?.rerender?.(true);
    } catch {
      // not critical
    }
  });
}
