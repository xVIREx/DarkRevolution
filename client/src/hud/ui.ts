// Modern-DarkOrbit window framework: sprite helpers, draggable/minimizable windows and the
// top menu bars (feature icons) that open/close them. Sprites live in public/assets/ui/
// (extracted from the Unity client by tools/ui_build.py).
import { el } from './dom';
import { IS_TOUCH, TOUCH_CLOSED_WINDOWS } from '../touch';

export const UI_BASE = '/assets/ui/';
/** url of an extracted UI sprite, e.g. ui('win/minimize_button') */
export const ui = (name: string): string => `${UI_BASE}${name}.png`;
export const iconUrl = (id: string): string => `${UI_BASE}items/${id}.png`;

let zTop = 20;
const ALL = new Map<string, DOWindow>();
const listeners: (() => void)[] = [];

export type Anchor = 'tl' | 'tr' | 'bl' | 'br' | 'tc' | 'bc';

export interface WinOpts {
  id: string;
  title: string;
  /** FeatureMenu icon base name (assets/ui/menu/<icon>_normal.png) */
  icon: string;
  w: number;
  h?: number;
  anchor?: Anchor;
  x: number;
  y: number;
  open?: boolean;
  resizable?: boolean;
  minW?: number;
  minH?: number;
  /** extra class on the root */
  cls?: string;
  parent?: HTMLElement;
}

interface Saved { x: number; y: number; open: boolean; w?: number; h?: number; anchor: Anchor }

function load(id: string): Partial<Saved> {
  try { return JSON.parse(localStorage.getItem(`do.win.${id}`) || '{}'); } catch { return {}; }
}

/** A DarkOrbit-style window: header with feature icon + title + minimize, framed body. */
export class DOWindow {
  readonly root: HTMLDivElement;
  readonly header: HTMLDivElement;
  readonly body: HTMLDivElement;
  readonly titleEl: HTMLSpanElement;
  private anchor: Anchor;
  private x: number;
  private y: number;
  onToggle?: (open: boolean) => void;

  constructor(readonly opts: WinOpts) {
    const s = load(opts.id);
    this.anchor = s.anchor ?? opts.anchor ?? 'tl';
    this.x = s.x ?? opts.x;
    this.y = s.y ?? opts.y;
    this.root = el('div', `dowin ${opts.cls ?? ''}`, undefined, opts.parent ?? document.getElementById('hud') ?? document.body);
    this.root.id = opts.id;
    this.root.style.width = `${s.w ?? opts.w}px`;
    if (opts.h || s.h) this.root.style.height = `${s.h ?? opts.h}px`;
    this.header = el('div', 'dowin-head', undefined, this.root);
    const ic = el('img', 'dowin-icon', undefined, this.header);
    ic.src = ui(`menu/${opts.icon}_normal`);
    ic.draggable = false;
    this.titleEl = el('span', 'dowin-title', opts.title, this.header);
    const min = el('div', 'dowin-min', undefined, this.header);
    min.title = 'Minimize';
    min.addEventListener('click', (e) => { e.stopPropagation(); this.close(); });
    min.addEventListener('mousedown', (e) => e.stopPropagation());
    this.body = el('div', 'dowin-body', undefined, this.root);
    el('div', 'dowin-bg', undefined, this.body);
    if (opts.resizable) {
      const r = el('div', 'dowin-resize', undefined, this.root);
      r.addEventListener('pointerdown', (e) => this.startResize(e));
    }
    this.root.addEventListener('pointerdown', () => this.front(), true);
    this.header.addEventListener('pointerdown', (e) => this.startDrag(e));
    ALL.set(opts.id, this);
    const defOpen = IS_TOUCH && TOUCH_CLOSED_WINDOWS.has(opts.id) ? false : opts.open ?? true;
    this.setOpen(s.open ?? defOpen, false);
    this.place();
    window.addEventListener('resize', () => this.place());
  }

  get visible(): boolean { return !this.root.classList.contains('closed'); }

  front(): void { this.root.style.zIndex = String(++zTop); }

  open(): void { this.setOpen(true); }
  close(): void { this.setOpen(false); }
  toggle(): void { this.setOpen(!this.visible); }

  setOpen(o: boolean, save = true): void {
    this.root.classList.toggle('closed', !o);
    if (o) { this.front(); requestAnimationFrame(() => this.place()); }
    if (save) this.save();
    this.onToggle?.(o);
    for (const l of listeners) l();
  }

  setTitle(t: string): void {
    if (this.titleEl.textContent !== t) this.titleEl.textContent = t;
  }

  /** Re-apply the anchored position, clamped to the viewport. */
  place(): void {
    const W = window.innerWidth, H = window.innerHeight;
    const w = this.root.offsetWidth || this.opts.w, h = this.root.offsetHeight || 60;
    let left: number, top: number;
    const a = this.anchor;
    if (a === 'tl' || a === 'bl') left = this.x;
    else if (a === 'tr' || a === 'br') left = W - w - this.x;
    else left = W / 2 - w / 2 + this.x;
    if (a[0] === 't') top = this.y; else top = H - h - this.y;
    left = Math.max(-w + 60, Math.min(W - 60, left));
    top = Math.max(0, Math.min(H - 24, top));
    this.root.style.left = `${Math.round(left)}px`;
    this.root.style.top = `${Math.round(top)}px`;
  }

  private save(): void {
    const s: Saved = { x: this.x, y: this.y, open: this.visible, anchor: this.anchor };
    if (this.opts.resizable) { s.w = this.root.offsetWidth; s.h = this.root.offsetHeight; }
    try { localStorage.setItem(`do.win.${this.opts.id}`, JSON.stringify(s)); } catch { /* ignore */ }
  }

  private startDrag(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    const r = this.root.getBoundingClientRect();
    const ox = e.clientX - r.left, oy = e.clientY - r.top;
    const move = (ev: PointerEvent) => {
      const W = window.innerWidth, H = window.innerHeight;
      const left = ev.clientX - ox, top = ev.clientY - oy;
      const w = this.root.offsetWidth, h = this.root.offsetHeight;
      // re-anchor to the nearest corner so the window sticks there on resize
      const cx = left + w / 2, cy = top + h / 2;
      const hor = cx < W / 3 ? 'l' : cx > (W * 2) / 3 ? 'r' : 'c';
      const ver = cy < H / 2 ? 't' : 'b';
      this.anchor = (ver + hor) as Anchor;
      if (hor === 'c') this.anchor = (ver === 't' ? 'tc' : 'bc');
      this.x = hor === 'l' ? left : hor === 'r' ? W - w - left : left + w / 2 - W / 2;
      this.y = ver === 't' ? top : H - h - top;
      this.place();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.save();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  private startResize(e: PointerEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const sx = e.clientX, sy = e.clientY, w0 = this.root.offsetWidth, h0 = this.root.offsetHeight;
    const move = (ev: PointerEvent) => {
      this.root.style.width = `${Math.max(this.opts.minW ?? 160, w0 + ev.clientX - sx)}px`;
      this.root.style.height = `${Math.max(this.opts.minH ?? 80, h0 + ev.clientY - sy)}px`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      // keep the top-left fixed: re-derive anchor offsets from the current rect
      const r = this.root.getBoundingClientRect();
      const W = window.innerWidth, H = window.innerHeight;
      if (this.anchor[1] === 'r') this.x = W - r.right;
      if (this.anchor[0] === 'b') this.y = H - r.bottom;
      this.save();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
}

export function getWindow(id: string): DOWindow | undefined {
  return ALL.get(id);
}

/** Reset every window to its default position (settings → "Reset windows"). */
export function resetWindows(): void {
  for (const id of ALL.keys()) try { localStorage.removeItem(`do.win.${id}`); } catch { /* ignore */ }
  location.reload();
}

export interface MenuItem {
  icon: string;
  title: string;
  /** window id to toggle, or a custom click handler */
  win?: string;
  onClick?: () => void;
  isOpen?: () => boolean;
}

/** Row of 38x38 feature buttons (DO top-left / top-right menus). */
export class MenuBar {
  readonly root: HTMLDivElement;
  private btns: { b: HTMLDivElement; img: HTMLImageElement; it: MenuItem; hover: boolean }[] = [];

  constructor(parent: HTMLElement, id: string, items: MenuItem[]) {
    this.root = el('div', 'domenu', undefined, parent);
    this.root.id = id;
    for (const it of items) this.add(it);
    listeners.push(() => this.sync());
  }

  add(it: MenuItem): void {
    const b = el('div', 'domenu-btn', undefined, this.root);
    b.title = it.title;
    const img = el('img', undefined, undefined, b);
    img.draggable = false;
    const rec = { b, img, it, hover: false };
    b.addEventListener('mouseenter', () => { rec.hover = true; this.paint(rec); });
    b.addEventListener('mouseleave', () => { rec.hover = false; this.paint(rec); });
    b.addEventListener('click', () => {
      if (it.onClick) it.onClick();
      else if (it.win) getWindow(it.win)?.toggle();
      this.sync();
    });
    this.btns.push(rec);
    this.paint(rec);
  }

  private isOpen(it: MenuItem): boolean {
    if (it.isOpen) return it.isOpen();
    return it.win ? !!getWindow(it.win)?.visible : false;
  }

  private paint(r: { b: HTMLDivElement; img: HTMLImageElement; it: MenuItem; hover: boolean }): void {
    const open = this.isOpen(r.it);
    const st = open ? 'select' : r.hover ? 'hover' : 'normal';
    const src = ui(`menu/${r.it.icon}_${st}`);
    if (!r.img.src.endsWith(src)) r.img.src = src;
    r.b.classList.toggle('open', open);
  }

  sync(): void {
    for (const r of this.btns) this.paint(r);
  }
}

/** Notify menu bars that some open-state changed outside a DOWindow (e.g. hangar). */
export function syncMenus(): void {
  for (const l of listeners) l();
}

/** Small DO-style text button (blue scale9 / green). */
export function button(text: string, parent: HTMLElement, kind: 'blue' | 'green' | 'red' = 'blue', onClick?: () => void): HTMLButtonElement {
  const b = el('button', `dobtn ${kind}`, text, parent);
  b.type = 'button';
  b.tabIndex = -1;
  if (onClick) b.addEventListener('click', onClick);
  return b;
}
