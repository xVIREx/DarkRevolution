import * as THREE from 'three';
import { Assets, setSheetFrame } from './assets';
import type { SheetInfo } from './types';

/** World (x right, y down) -> three.js (x right, y up). */
export const toThreeY = (y: number): number => -y;

export function basicMat(opts: THREE.MeshBasicMaterialParameters = {}): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, depthTest: false, ...opts });
}

/** Placeholder: triangle pointing +x (three space). */
export function makeTriangle(size: number, color: THREE.ColorRepresentation): THREE.Mesh {
  const s = new THREE.Shape();
  s.moveTo(size * 0.55, 0);
  s.lineTo(-size * 0.45, size * 0.38);
  s.lineTo(-size * 0.25, 0);
  s.lineTo(-size * 0.45, -size * 0.38);
  s.closePath();
  return new THREE.Mesh(new THREE.ShapeGeometry(s), basicMat({ color, opacity: 0.9 }));
}

export function makeCircle(radius: number, color: THREE.ColorRepresentation, opacity = 0.8): THREE.Mesh {
  return new THREE.Mesh(new THREE.CircleGeometry(radius, 40), basicMat({ color, opacity }));
}

export function makeRing(inner: number, outer: number, color: THREE.ColorRepresentation, opacity = 0.9): THREE.Mesh {
  return new THREE.Mesh(new THREE.RingGeometry(inner, outer, 64), basicMat({ color, opacity }));
}

/**
 * A plane showing one frame of a sprite sheet. Loads lazily; shows `placeholder` until (or if never) loaded.
 */
export class SheetSprite {
  readonly group = new THREE.Group();
  private mesh: THREE.Mesh | null = null;
  private tex: THREE.Texture | null = null;
  private frame = -1;
  private wantFrame = 0;
  loaded = false;
  failed = false;
  disposed = false;

  constructor(
    assets: Assets,
    readonly sheet: SheetInfo | null,
    readonly placeholder: THREE.Object3D | null,
    renderOrder = 5,
  ) {
    if (placeholder) this.group.add(placeholder);
    if (!sheet) {
      this.failed = true;
      return;
    }
    void assets.texture(sheet.url).then((base) => {
      if (this.disposed) return;
      if (!base) {
        this.failed = true;
        return;
      }
      const tex = base.clone();
      tex.needsUpdate = true;
      this.tex = tex;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(sheet.cw, sheet.ch), basicMat({ map: tex }));
      mesh.renderOrder = renderOrder;
      this.mesh = mesh;
      if (this.placeholder) this.group.remove(this.placeholder);
      this.group.add(mesh);
      this.loaded = true;
      this.frame = -1;
      this.setFrame(this.wantFrame);
    });
  }

  setFrame(f: number): void {
    this.wantFrame = f;
    if (!this.tex || !this.sheet || f === this.frame) return;
    this.frame = f;
    setSheetFrame(this.tex, this.sheet, f);
  }

  setOpacity(o: number): void {
    if (this.mesh) (this.mesh.material as THREE.MeshBasicMaterial).opacity = o;
  }

  dispose(): void {
    this.disposed = true;
    if (this.mesh) {
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
    }
    this.tex?.dispose();
    disposeTree(this.placeholder);
  }
}

/** Simple single-image plane (station, planet, laser...) with placeholder fallback. */
export class ImageSprite {
  readonly group = new THREE.Group();
  mesh: THREE.Mesh | null = null;
  width = 0;
  height = 0;
  disposed = false;
  onLoad: ((s: ImageSprite) => void) | null = null;

  constructor(assets: Assets, rel: string | undefined, readonly placeholder: THREE.Object3D | null, renderOrder = 2, scale = 1) {
    if (placeholder) this.group.add(placeholder);
    if (!rel) return;
    void assets.texture(rel).then((tex) => {
      if (this.disposed || !tex) return;
      const img = tex.image as { width: number; height: number };
      this.width = img.width * scale;
      this.height = img.height * scale;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(this.width, this.height), basicMat({ map: tex }));
      mesh.renderOrder = renderOrder;
      this.mesh = mesh;
      if (this.placeholder) this.group.remove(this.placeholder);
      this.group.add(mesh);
      this.onLoad?.(this);
    });
  }

  dispose(): void {
    this.disposed = true;
    if (this.mesh) {
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
    }
    disposeTree(this.placeholder);
  }
}

export function disposeTree(o: THREE.Object3D | null): void {
  if (!o) return;
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else if (mat) {
      const mm = mat as THREE.MeshBasicMaterial;
      // do not dispose shared textures here; label textures are owned by the label
      if (mm.map && (mm.map as THREE.CanvasTexture).isCanvasTexture) mm.map.dispose();
      mat.dispose();
    }
  });
}

/** Text label as a textured plane (world units = screen px at scale 1). */
export function makeLabel(text: string, color: string, fontPx = 12, renderOrder = 8): THREE.Mesh {
  const ratio = 2;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const font = `bold ${fontPx * ratio}px Verdana, Tahoma, sans-serif`;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 8 * ratio;
  const h = Math.ceil(fontPx * ratio * 1.5);
  canvas.width = Math.max(4, w);
  canvas.height = h;
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 3 * ratio;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(text, canvas.width / 2, h / 2);
  ctx.fillStyle = color;
  ctx.fillText(text, canvas.width / 2, h / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(canvas.width / ratio, canvas.height / ratio), basicMat({ map: tex }));
  mesh.renderOrder = renderOrder;
  return mesh;
}
