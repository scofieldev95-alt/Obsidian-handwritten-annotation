// Minimal stand-in for the `obsidian` module so the editor can run in a plain browser page
// (harness/index.html). Only what the surface and toolbar use.

type Attrs = { cls?: string; text?: string; type?: string; attr?: Record<string, string> };

declare global {
  interface HTMLElement {
    createEl<K extends keyof HTMLElementTagNameMap>(tag: K, o?: Attrs): HTMLElementTagNameMap[K];
    createDiv(o?: Attrs): HTMLDivElement;
    createSpan(o?: Attrs): HTMLSpanElement;
    empty(): void;
    addClass(c: string): void;
  }
}

const proto = HTMLElement.prototype as any;
proto.createEl = function (tag: string, o: Attrs = {}) {
  const el = document.createElement(tag);
  if (o.cls) el.className = o.cls;
  if (o.text) el.textContent = o.text;
  if (o.type) (el as HTMLInputElement).type = o.type;
  for (const [k, v] of Object.entries(o.attr ?? {})) el.setAttribute(k, v);
  this.appendChild(el);
  return el;
};
proto.createDiv = function (o?: Attrs) { return this.createEl('div', o); };
proto.createSpan = function (o?: Attrs) { return this.createEl('span', o); };
proto.empty = function () { while (this.firstChild) this.removeChild(this.firstChild); };
proto.addClass = function (c: string) { this.classList.add(c); };

export function setIcon(el: HTMLElement, icon: string): void {
  el.textContent = ({
    'pen-line': '✒', highlighter: '🖍', eraser: '⌫', lasso: '◌', 'undo-2': '↶', 'redo-2': '↷',
    'trash-2': '🗑', 'chevron-left': '‹', 'chevron-right': '›', 'maximize-2': '⤢',
  } as Record<string, string>)[icon] ?? '?';
}

export const Platform = { isPhone: false, isMacOS: navigator.platform.includes('Mac') };

export class App {}

export class Modal {
  app: unknown;
  contentEl = document.createElement('div');
  constructor(app: unknown) { this.app = app; }
  setTitle(_: string) {}
  open() { const v = prompt('Page'); if (v) (this as any).done?.(Number(v)); }
  close() {}
}

export class Setting {
  constructor(_: HTMLElement) {}
  setName() { return this; }
  addText() { return this; }
  addButton() { return this; }
}
