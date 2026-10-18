import * as THREE from 'three';
import { Assets, setSheetFrame } from '../assets';
import type { SheetInfo } from '../types';

/** Camera-facing plane showing one frame of a 2D rotation/animation sheet (fallback for missing 3D models). */
export class SheetBillboard {
  readonly group = new THREE.Group();
  mesh: THREE.Mesh | null = null;
  private tex: THREE.Texture | null = null;
  private frame = -1;
  private want = 0;
  loaded = false;
  private disposed = false;

  constructor(assets: Assets, readonly sheet: SheetInfo, scale = 1, opts: { additive?: boolean; renderOrder?: number; opacity?: number } = {}) {
    void assets.texture(sheet.url).then((base) => {
      if (this.disposed || !base) return;
      const tex = base.clone();
      tex.needsUpdate = true;
      this.tex = tex;
      const mat = new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthWrite: false, opacity: opts.opacity ?? 1,
        blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      });
      const m = new THREE.Mesh(PLANE, mat);
      m.scale.set(sheet.cw * scale, sheet.ch * scale, 1);
      m.renderOrder = opts.renderOrder ?? 5;
      this.mesh = m;
      this.group.add(m);
      this.loaded = true;
      this.frame = -1;
      this.setFrame(this.want);
    });
  }

  setFrame(f: number): void {
    this.want = f;
    if (!this.tex || f === this.frame) return;
    this.frame = f;
    setSheetFrame(this.tex, this.sheet, f);
  }

  setOpacity(o: number): void {
    if (this.mesh) (this.mesh.material as THREE.MeshBasicMaterial).opacity = o;
  }

  dispose(): void {
    this.disposed = true;
    this.group.removeFromParent();
    if (this.mesh) (this.mesh.material as THREE.Material).dispose();
    this.tex?.dispose();
  }
}

/** Camera-facing single image (2D station/planet/rocket fallback). */
export class ImageBillboard {
  readonly group = new THREE.Group();
  mesh: THREE.Mesh | null = null;
  w = 0;
  h = 0;
  private disposed = false;
  onLoad: ((b: ImageBillboard) => void) | null = null;

  constructor(assets: Assets, rel: string | undefined, scale = 1, opts: { additive?: boolean; renderOrder?: number; depthTest?: boolean } = {}) {
    if (!rel) return;
    void assets.texture(rel).then((tex) => {
      if (this.disposed || !tex) return;
      const img = tex.image as { width: number; height: number };
      this.w = img.width * scale;
      this.h = img.height * scale;
      const m = new THREE.Mesh(PLANE, new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthWrite: false, depthTest: opts.depthTest ?? true,
        blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      }));
      m.scale.set(this.w, this.h, 1);
      m.renderOrder = opts.renderOrder ?? 2;
      this.mesh = m;
      this.group.add(m);
      this.onLoad?.(this);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.group.removeFromParent();
    if (this.mesh) (this.mesh.material as THREE.Material).dispose();
  }
}

export const PLANE = new THREE.PlaneGeometry(1, 1);

/** soft radial gradient (glow sprites, particles, flares) */
let glowTex: THREE.Texture | null = null;
export function glowTexture(): THREE.Texture {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,255,255,0.65)');
  grd.addColorStop(0.6, 'rgba(255,255,255,0.15)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c);
  glowTex.colorSpace = THREE.SRGBColorSpace;
  return glowTex;
}

/** puffy smoke texture */
let smokeTex: THREE.Texture | null = null;
export function smokeTexture(): THREE.Texture {
  if (smokeTex) return smokeTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  for (let i = 0; i < 14; i++) {
    const x = 32 + (Math.random() - 0.5) * 22;
    const y = 32 + (Math.random() - 0.5) * 22;
    const r = 8 + Math.random() * 12;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, 'rgba(255,255,255,0.35)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
  }
  smokeTex = new THREE.CanvasTexture(c);
  smokeTex.colorSpace = THREE.SRGBColorSpace;
  return smokeTex;
}

/** horizontal soft beam (laser fallback): bright core, soft edges across v */
let beamTex: THREE.Texture | null = null;
export function beamTexture(): THREE.Texture {
  if (beamTex) return beamTex;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 32;
  const g = c.getContext('2d')!;
  const gy = g.createLinearGradient(0, 0, 0, 32);
  gy.addColorStop(0, 'rgba(255,255,255,0)');
  gy.addColorStop(0.35, 'rgba(255,255,255,0.5)');
  gy.addColorStop(0.5, 'rgba(255,255,255,1)');
  gy.addColorStop(0.65, 'rgba(255,255,255,0.5)');
  gy.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gy;
  g.fillRect(0, 0, 64, 32);
  g.globalCompositeOperation = 'destination-in';
  const gx = g.createLinearGradient(0, 0, 64, 0);
  gx.addColorStop(0, 'rgba(0,0,0,0)');
  gx.addColorStop(0.2, 'rgba(0,0,0,1)');
  gx.addColorStop(0.8, 'rgba(0,0,0,1)');
  gx.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gx;
  g.fillRect(0, 0, 64, 32);
  beamTex = new THREE.CanvasTexture(c);
  beamTex.colorSpace = THREE.SRGBColorSpace;
  return beamTex;
}
