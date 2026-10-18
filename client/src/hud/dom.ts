export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  html?: string,
  parent?: HTMLElement,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  if (parent) parent.appendChild(e);
  return e;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function fmt(n: number | undefined | null): string {
  if (n === undefined || n === null || !isFinite(n)) return '∞';
  if (n >= 1e12) return '∞';
  return Math.round(n).toLocaleString('en-US');
}

export function panel(id: string, title: string | null, parent: HTMLElement): { root: HTMLDivElement; title: HTMLDivElement | null; body: HTMLDivElement } {
  const root = el('div', 'panel', undefined, parent);
  root.id = id;
  const t = title !== null ? el('div', 'panel-title', title, root) : null;
  const body = el('div', 'body', undefined, root);
  return { root, title: t, body };
}

export function setBar(bar: HTMLElement, v: number, max: number): void {
  const k = max > 0 ? Math.max(0, Math.min(1, v / max)) : 0;
  const fill = bar.firstElementChild as HTMLElement;
  const label = bar.lastElementChild as HTMLElement;
  const w = `${(k * 100).toFixed(1)}%`;
  if (fill.style.width !== w) fill.style.width = w;
  const txt = `${fmt(v)} / ${fmt(max)}`;
  if (label.textContent !== txt) label.textContent = txt;
}

export function makeBar(cls: 'hp' | 'sh', parent: HTMLElement): HTMLDivElement {
  return el('div', `bar ${cls}`, '<i></i><span></span>', parent);
}

export function isTyping(): boolean {
  const a = document.activeElement;
  return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || (a as HTMLElement).isContentEditable);
}
