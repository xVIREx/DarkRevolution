import type { Actions, GameState } from '../actions';
import { Assets } from '../assets';
import { el } from './dom';
import { DOWindow, ui } from './ui';
import { IS_TOUCH } from '../touch';

const SIZES = [220, 300, 380, 470];

/** DO "Mini map" window (UIMiniMapNew): map label + coords, +/- size, click/drag to fly. */
export class Minimap {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private label: HTMLElement;
  private img: HTMLImageElement | null = null;
  private imgKey = '';
  private lastDraw = 0;
  private state: GameState | null = null;
  private win: DOWindow;
  private sizeIdx: number;
  private icons: Record<string, HTMLImageElement> = {};

  constructor(_parent: HTMLElement, private readonly assets: Assets, actions: Actions) {
    let si = 1;
    try { si = Number(localStorage.getItem('do.minimap.size') ?? (IS_TOUCH ? '0' : '1')); } catch { /* ignore */ }
    this.sizeIdx = Math.max(0, Math.min(SIZES.length - 1, isFinite(si) ? si : 1));
    this.win = new DOWindow({ id: 'win-minimap', title: 'Mini map', icon: 'minimap', w: SIZES[this.sizeIdx] + 20, anchor: 'br', x: 8, y: IS_TOUCH ? 78 : 8, cls: 'win-minimap' });
    const minus = el('div', 'mm-btn minus', undefined, this.win.header);
    const plus = el('div', 'mm-btn plus', undefined, this.win.header);
    minus.title = 'Smaller';
    plus.title = 'Bigger';
    for (const b of [minus, plus]) b.addEventListener('pointerdown', (e) => e.stopPropagation());
    minus.addEventListener('click', () => this.resize(-1));
    plus.addEventListener('click', () => this.resize(1));
    this.label = el('div', 'mm-label', '', this.win.body);
    const wrap = el('div', 'mm-wrap', undefined, this.win.body);
    this.canvas = el('canvas', undefined, undefined, wrap);
    this.ctx = this.canvas.getContext('2d')!;
    this.applySize();
    for (const n of ['mapIcon_portal', 'mapIcon_station_0', 'mapIcon_finish']) {
      const im = new Image();
      im.src = ui(`map/${n}`);
      this.icons[n] = im;
    }
    const go = (ev: MouseEvent) => {
      const m = this.state?.map;
      if (!m) return;
      const r = this.canvas.getBoundingClientRect();
      const x = ((ev.clientX - r.left) / r.width) * m.w;
      const y = ((ev.clientY - r.top) / r.height) * m.h;
      actions.moveTo(Math.max(0, Math.min(m.w, x)), Math.max(0, Math.min(m.h, y)));
    };
    let down = false;
    this.canvas.addEventListener('mousedown', (e) => { if (e.button === 0) { down = true; go(e); } });
    window.addEventListener('mouseup', () => { down = false; });
    this.canvas.addEventListener('mousemove', (e) => { if (down) go(e); });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private resize(d: number): void {
    this.sizeIdx = Math.max(0, Math.min(SIZES.length - 1, this.sizeIdx + d));
    try { localStorage.setItem('do.minimap.size', String(this.sizeIdx)); } catch { /* ignore */ }
    this.applySize();
    this.win.place();
  }

  private applySize(): void {
    const w = SIZES[this.sizeIdx];
    this.win.root.style.width = `${w + 20}px`;
    this.canvas.style.width = `${w}px`;
    this.canvas.width = w * 2;
    this.lastDraw = 0;
  }

  update(s: GameState, now: number): void {
    this.state = s;
    if (!this.win.visible || now - this.lastDraw < 66) return;
    this.lastDraw = now;
    const m = s.map;
    const c = this.ctx;
    const W = this.canvas.width;
    if (!m) {
      c.fillStyle = '#050a12';
      c.fillRect(0, 0, W, this.canvas.height);
      return;
    }
    const H = Math.round(W * (m.h / m.w));
    if (this.canvas.height !== H) { this.canvas.height = H; this.canvas.style.height = `${H / 2}px`; this.win.place(); }
    const key = String(m.minimap ?? m.id);
    if (key !== this.imgKey) {
      this.imgKey = key;
      this.img = null;
      const rel = this.assets.manifest.minimaps[key] ?? this.assets.manifest.minimaps[String(m.id)];
      if (rel) void this.assets.loadImage(rel).then((img) => { if (this.imgKey === key) this.img = img; });
    }
    const coords = s.me ? `${Math.round(s.me.x / 100)}/${Math.round(s.me.y / 100)}` : '';
    const t = `${m.name} ${coords}`;
    if (this.label.textContent !== t) this.label.textContent = t;

    const sx = W / m.w;
    const sy = H / m.h;
    c.fillStyle = '#02060c';
    c.fillRect(0, 0, W, H);
    if (this.img) {
      c.globalAlpha = 0.6;
      c.drawImage(this.img, 0, 0, W, H);
      c.globalAlpha = 1;
    }
    // ruler ticks like the DO minimap (light blue #99ccff)
    c.fillStyle = 'rgba(153,204,255,0.55)';
    for (let i = 0; i <= 10; i++) c.fillRect(Math.round((W - 2) * i / 10), 0, 2, i % 5 === 0 ? 12 : 6);
    for (let i = 0; i <= 6; i++) c.fillRect(0, Math.round((H - 2) * i / 6), i % 3 === 0 ? 12 : 6, 2);
    const ic = (n: string, x: number, y: number, scale = 2) => {
      const im = this.icons[n];
      if (im?.complete && im.naturalWidth) c.drawImage(im, x - (im.naturalWidth * scale) / 2, y - (im.naturalHeight * scale) / 2, im.naturalWidth * scale, im.naturalHeight * scale);
    };
    for (const st of m.stations ?? []) ic('mapIcon_station_0', st.x * sx, st.y * sy, 2);
    for (const p of m.portals ?? []) ic('mapIcon_portal', p.x * sx, p.y * sy, 2);
    for (const e of s.ents) {
      const k = String(e.snap.id);
      if (k === s.myId) continue;
      // DO colours: NPC red, enemy player red, ally (same company) blue/green
      if (e.snap.k === 'n') c.fillStyle = '#ff2b2b';
      else c.fillStyle = e.snap.f && e.snap.f !== s.faction ? '#ff2bff' : '#2bd0ff';
      const r = k === s.selectedId ? 7 : 5;
      c.fillRect(Math.round(e.x * sx - r / 2), Math.round(e.y * sy - r / 2), r, r);
      if (k === s.selectedId) {
        c.strokeStyle = '#ffd200'; c.lineWidth = 2;
        c.strokeRect(e.x * sx - 7, e.y * sy - 7, 14, 14);
      }
    }
    if (s.me) {
      const x = s.me.x * sx;
      const y = s.me.y * sy;
      c.strokeStyle = 'rgba(255,255,255,0.66)';
      c.lineWidth = 1;
      c.beginPath(); c.moveTo(Math.round(x) + 0.5, 0); c.lineTo(Math.round(x) + 0.5, H); c.moveTo(0, Math.round(y) + 0.5); c.lineTo(W, Math.round(y) + 0.5); c.stroke();
      c.fillStyle = '#ffffff';
      c.beginPath(); c.arc(x, y, 5, 0, Math.PI * 2); c.fill();
    }
  }
}
