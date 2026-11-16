// Plugin code uses `window.setTimeout` (Obsidian's popout-window rule); in Node, window is the global object.
const g = globalThis as unknown as { window?: unknown };
g.window ??= globalThis;
