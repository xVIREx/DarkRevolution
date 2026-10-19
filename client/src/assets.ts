import * as THREE from 'three';
import type { LasersData, Manifest, SheetInfo, ShipDef } from './types';
import { DEFAULT_AMMO, DEFAULT_ROCKETS } from './types';

const ASSET_BASE = '/assets/';

const EMPTY_MANIFEST: Manifest = {
  sheets: {},
  rotation: { frame0: 0, dir: 1 },
  backgrounds: {},
  planets: {},
  lasers: {},
  rockets: {},
  stations: {},
  box: {},
  minimaps: {},
};

export function assetUrl(rel: string): string {
  if (/^(https?:)?\/\//.test(rel) || rel.startsWith('/') || rel.startsWith('data:')) return rel;
  return ASSET_BASE + rel.replace(/^\.?\//, '');
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

/** Normalises a (possibly partial) manifest so every field exists. */
function normaliseManifest(m: Partial<Manifest> | null): Manifest {
  const out: Manifest = { ...EMPTY_MANIFEST, ...(m ?? {}) } as Manifest;
  for (const k of ['sheets', 'backgrounds', 'planets', 'lasers', 'rockets', 'stations', 'box', 'minimaps'] as const) {
    if (!out[k] || typeof out[k] !== 'object') (out as unknown as Record<string, unknown>)[k] = {};
  }
  if (!out.rotation || typeof out.rotation.frame0 !== 'number') out.rotation = { frame0: 0, dir: 1 };
  if (out.rotation.dir !== -1) out.rotation.dir = 1;
  return out;
}

/** Derive a ship list from manifest sheet names when /data/ships.json is unavailable. */
function shipsFromManifest(m: Manifest): ShipDef[] {
  const bases = new Map<string, ShipDef>();
  const keys = Object.keys(m.sheets).filter((k) => k.startsWith('ship_')).sort();
  for (const k of keys) {
    if (!k.includes('-')) {
      bases.set(k, {
        id: k, name: prettify(k.slice(5)), hp: 0, speed: 0, lasers: 0, generators: 0, extras: 0, cargo: 0,
        sheet: k, designs: [],
      });
    }
  }
  for (const k of keys) {
    const dash = k.indexOf('-');
    if (dash < 0) continue;
    const base = k.slice(0, dash);
    let b = bases.get(base);
    if (!b) {
      b = { id: base, name: prettify(base.slice(5)), hp: 0, speed: 0, lasers: 0, generators: 0, extras: 0, cargo: 0, sheet: k, designs: [] };
      bases.set(base, b);
    }
    b.designs.push({ id: k, name: `${b.name} ${prettify(k.slice(dash + 1))}`, sheet: k });
  }
  return [...bases.values()];
}

function prettify(s: string): string {
  return s.split(/[-_]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

export class Assets {
  manifest: Manifest = EMPTY_MANIFEST;
  ships: ShipDef[] = [];
  lasers: LasersData = { ammo: DEFAULT_AMMO, laserDamage: 175, rockets: DEFAULT_ROCKETS };
  manifestOk = false;
  shipsOk = false;

  private images = new Map<string, Promise<HTMLImageElement | null>>();
  private textures = new Map<string, Promise<THREE.Texture | null>>();
  private loadedTextures = new Map<string, THREE.Texture | null>();

  async init(): Promise<void> {
    const [m, ships, lasers] = await Promise.all([
      fetchJson<Partial<Manifest>>(ASSET_BASE + 'manifest.json'),
      fetchJson<ShipDef[]>('/data/ships.json'),
      fetchJson<LasersData>('/data/lasers.json'),
    ]);
    this.manifestOk = !!m;
    this.manifest = normaliseManifest(m);
    // season loot boxes are sent as entities with sheet ids box_cargo / box_bonus (single frame)
    const box = this.manifest.box ?? {};
    const addBox = (k: string, url: string | undefined, cw: number, ch: number) => {
      if (url && !this.manifest.sheets[k]) this.manifest.sheets[k] = { url, frames: 1, cols: 1, cw, ch };
    };
    addBox('box_cargo', box.cargo, 128, 128);
    addBox('box_bonus', box.bonus, 96, 70);
    if (Array.isArray(ships) && ships.length) {
      this.ships = ships.map((s) => ({ ...s, designs: Array.isArray(s.designs) ? s.designs : [] }));
      this.shipsOk = true;
    } else {
      this.ships = shipsFromManifest(this.manifest);
    }
    if (lasers && Array.isArray(lasers.ammo)) {
      this.lasers = {
        ammo: lasers.ammo.length ? lasers.ammo : DEFAULT_AMMO,
        laserDamage: lasers.laserDamage ?? 175,
        rockets: Array.isArray(lasers.rockets) && lasers.rockets.length ? lasers.rockets : DEFAULT_ROCKETS,
      };
    }
  }

  sheet(key: string | undefined | null): SheetInfo | null {
    if (!key) return null;
    const s = this.manifest.sheets[key];
    if (!s || !s.url || !(s.frames > 0) || !(s.cols > 0)) return null;
    return s;
  }

  /** frame index for a world angle (radians, atan2 with +y down). */
  frameFor(angle: number, frames: number): number {
    const { frame0, dir } = this.manifest.rotation;
    const f = Math.round((((angle - frame0) * dir) / (Math.PI * 2)) * frames);
    return ((f % frames) + frames) % frames;
  }

  loadImage(rel: string): Promise<HTMLImageElement | null> {
    const url = assetUrl(rel);
    let p = this.images.get(url);
    if (!p) {
      p = new Promise((resolve) => {
        const img = new Image();
        img.decoding = 'async';
        img.onload = () => resolve(img);
        img.onerror = () => {
          console.warn('missing asset', url);
          resolve(null);
        };
        img.src = url;
      });
      this.images.set(url, p);
    }
    return p;
  }

  /** Shared texture for an asset URL (null if missing). Clone it if you need per-object UV offsets. */
  texture(rel: string | undefined | null): Promise<THREE.Texture | null> {
    if (!rel) return Promise.resolve(null);
    const url = assetUrl(rel);
    let p = this.textures.get(url);
    if (!p) {
      p = this.loadImage(rel).then((img) => {
        if (!img) {
          this.loadedTextures.set(url, null);
          return null;
        }
        const t = new THREE.Texture(img);
        t.colorSpace = THREE.SRGBColorSpace;
        t.minFilter = THREE.LinearFilter;
        t.magFilter = THREE.LinearFilter;
        t.generateMipmaps = false;
        t.needsUpdate = true;
        this.loadedTextures.set(url, t);
        return t;
      });
      this.textures.set(url, p);
    }
    return p;
  }

  /** Synchronous lookup: undefined = not loaded yet, null = missing. */
  textureNow(rel: string): THREE.Texture | null | undefined {
    const url = assetUrl(rel);
    if (!this.loadedTextures.has(url)) {
      void this.texture(rel);
      return undefined;
    }
    return this.loadedTextures.get(url);
  }

  laserColorFor(ammo: string): string {
    const a = this.lasers.ammo.find((x) => x.id === ammo);
    return a?.color ?? ammo;
  }
}

/** Configure a (cloned) sheet texture to show a frame. */
export function setSheetFrame(tex: THREE.Texture, sheet: SheetInfo, frame: number): void {
  const img = tex.image as { width?: number; height?: number } | undefined;
  const rows = Math.ceil(sheet.frames / sheet.cols);
  const iw = img?.width || sheet.cols * sheet.cw;
  const ih = img?.height || rows * sheet.ch;
  const col = frame % sheet.cols;
  const row = Math.floor(frame / sheet.cols);
  tex.repeat.set(sheet.cw / iw, sheet.ch / ih);
  // flipY = true: v=0 is the bottom of the image
  tex.offset.set((col * sheet.cw) / iw, 1 - ((row + 1) * sheet.ch) / ih);
}

/** Draw a sheet frame into a 2D canvas (used for hangar thumbnails). */
export function drawSheetFrame(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  sheet: SheetInfo,
  frame: number,
  w: number,
  h: number,
): void {
  const col = frame % sheet.cols;
  const row = Math.floor(frame / sheet.cols);
  const s = Math.min(w / sheet.cw, h / sheet.ch);
  const dw = sheet.cw * s;
  const dh = sheet.ch * s;
  ctx.drawImage(img, col * sheet.cw, row * sheet.ch, sheet.cw, sheet.ch, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

const bboxCache = new Map<string, [number, number, number, number] | null>();
let bboxCtx: CanvasRenderingContext2D | null = null;

/** Visible-pixel bounds of one sheet frame (x, y, w, h in frame px), cached; null if empty/unreadable. */
function frameBBox(img: HTMLImageElement, sheet: SheetInfo, frame: number): [number, number, number, number] | null {
  const key = `${img.src}#${frame}`;
  if (bboxCache.has(key)) return bboxCache.get(key)!;
  let r: [number, number, number, number] | null = null;
  try {
    bboxCtx ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    const c = bboxCtx!;
    c.canvas.width = sheet.cw;
    c.canvas.height = sheet.ch;
    c.clearRect(0, 0, sheet.cw, sheet.ch);
    c.drawImage(img, (frame % sheet.cols) * sheet.cw, Math.floor(frame / sheet.cols) * sheet.ch, sheet.cw, sheet.ch, 0, 0, sheet.cw, sheet.ch);
    const d = c.getImageData(0, 0, sheet.cw, sheet.ch).data;
    let x0 = sheet.cw, y0 = sheet.ch, x1 = -1, y1 = -1;
    for (let y = 0; y < sheet.ch; y++) {
      for (let x = 0; x < sheet.cw; x++) {
        if (d[(y * sheet.cw + x) * 4 + 3] > 24) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 >= x0) r = [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
  } catch { /* tainted / not decoded: fall back to the full frame */ }
  bboxCache.set(key, r);
  return r;
}

/** Like drawSheetFrame, but crops the frame's transparent padding so the ship is centred and fills
 * the box (sheets pad their frames differently, which made hangar thumbnails look off-centre). */
export function drawSheetFrameFit(ctx: CanvasRenderingContext2D, img: HTMLImageElement, sheet: SheetInfo, frame: number, w: number, h: number): void {
  const b = frameBBox(img, sheet, frame);
  if (!b) {
    drawSheetFrame(ctx, img, sheet, frame, w, h);
    return;
  }
  const [bx, by, bw, bh] = b;
  const s = Math.min(w / bw, h / bh);
  const dw = bw * s;
  const dh = bh * s;
  ctx.drawImage(img, (frame % sheet.cols) * sheet.cw + bx, Math.floor(frame / sheet.cols) * sheet.ch + by, bw, bh, (w - dw) / 2, (h - dh) / 2, dw, dh);
}
