import * as THREE from 'three';
import { disposeTree, makeLabel } from '../sprites';
import type { FlareView } from './scene3d';
import { glowTexture, PLANE } from './sprites3d';

const BAR_W = 64;
const BAR_H = 4;

function flatMat(color: THREE.ColorRepresentation, opacity = 1, additive = false, map: THREE.Texture | null = null): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color, opacity, transparent: true, depthTest: false, depthWrite: false, map,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
}

/** additive flare element with a soft radial mask (atlas cells do not fade to black at their edges) */
function flareMat(color: THREE.Color, map: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uMap: { value: map }, uColor: { value: color }, uA: { value: 1 } },
    vertexShader: 'varying vec2 vUv; varying vec2 vL; void main(){ vUv = uv; vL = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform sampler2D uMap; uniform vec3 uColor; uniform float uA; varying vec2 vUv; varying vec2 vL; void main(){ float m = smoothstep(0.5, 0.3, length(vL)); vec3 c = texture2D(uMap, vUv).rgb * uColor * m * uA; gl_FragColor = vec4(c, 1.0); }',
    transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}

const BAR_BG = flatMat(0x000000, 0.65);
const HP_MAT = flatMat(0x35e04a);
const SH_MAT = flatMat(0x3aa0ff);

/** Name + HP/shield bars in screen space (pixels), drawn after post-processing. */
export class OverlayItem {
  readonly group = new THREE.Group();
  private label: THREE.Mesh | null = null;
  private labelKey = '';
  private hp: THREE.Mesh;
  private sh: THREE.Mesh;
  private bars = new THREE.Group();

  constructor() {
    const bg = new THREE.Mesh(PLANE, BAR_BG);
    bg.scale.set(BAR_W + 2, BAR_H * 2 + 3, 1);
    this.hp = new THREE.Mesh(PLANE, HP_MAT);
    this.sh = new THREE.Mesh(PLANE, SH_MAT);
    this.hp.scale.y = BAR_H;
    this.sh.scale.y = BAR_H;
    this.hp.position.y = BAR_H / 2 + 0.5;
    this.sh.position.y = -BAR_H / 2 - 0.5;
    this.bars.add(bg, this.hp, this.sh);
    this.group.add(this.bars);
  }

  setLabel(text: string, color: string): void {
    const k = `${text}|${color}`;
    if (k === this.labelKey) return;
    this.labelKey = k;
    if (this.label) {
      this.group.remove(this.label);
      disposeTree(this.label);
    }
    this.label = makeLabel(text, color, 12, 8);
    this.label.position.y = -BAR_H * 2 - 12;
    this.group.add(this.label);
  }

  set(sx: number, sy: number, hpk: number, shk: number, hasShield: boolean): void {
    this.group.visible = true;
    this.group.position.set(Math.round(sx), Math.round(-sy), 0);
    setBar(this.hp, hpk);
    setBar(this.sh, shk);
    this.sh.visible = hasShield && shk > 0;
  }

  dispose(): void {
    this.group.removeFromParent();
    if (this.label) disposeTree(this.label);
  }
}

function setBar(m: THREE.Mesh, k: number): void {
  const w = Math.max(0.001, BAR_W * k);
  m.scale.x = w;
  m.position.x = -BAR_W / 2 + w / 2;
  m.visible = k > 0;
}

let ringTex: THREE.Texture | null = null;
function flareRingTexture(): THREE.Texture {
  if (ringTex) return ringTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(64, 64, 30, 64, 64, 62);
  grd.addColorStop(0, 'rgba(255,255,255,0)');
  grd.addColorStop(0.75, 'rgba(255,255,255,0.35)');
  grd.addColorStop(0.9, 'rgba(255,255,255,0.12)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    g.lineTo(64 + Math.cos(a) * 62, 64 + Math.sin(a) * 62);
  }
  g.fill();
  ringTex = new THREE.CanvasTexture(c);
  ringTex.colorSpace = THREE.SRGBColorSpace;
  return ringTex;
}

interface FlareEls { view: FlareView; els: { m: THREE.Mesh; d: number; size: number; base: number; rel: boolean }[] }

/** uv rect (u0, v0, u1, v1; v up) of image i in a Unity flare texture layout */
function flareRect(i: number, layout: number): [number, number, number, number] {
  if (layout === 1) {
    if (i === 0) return [0, 0.5, 1, 1];
    if (i <= 2) return [(i - 1) * 0.5, 0.25, i * 0.5, 0.5];
    const k = i - 3;
    const col = k % 4;
    const row = Math.floor(k / 4);
    return [col * 0.25, 0.25 - (row + 1) * 0.125, (col + 1) * 0.25, 0.25 - row * 0.125];
  }
  return [0, 0, 1, 1];
}

/** Screen-space overlay scene: entity labels/bars and lens flares. */
export class Overlay {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(0, 1, 0, -1, -10, 10);
  readonly items = new THREE.Group();
  private flares: FlareEls[] = [];
  private flareRoot = new THREE.Group();
  private tmp = new THREE.Vector3();

  constructor() {
    this.scene.add(this.flareRoot, this.items);
  }

  resize(w: number, h: number): void {
    this.camera.left = 0;
    this.camera.right = w;
    this.camera.top = 0;
    this.camera.bottom = -h;
    this.camera.updateProjectionMatrix();
  }

  setFlares(list: FlareView[], loadTex?: (rel: string) => Promise<THREE.Texture | null>): void {
    for (const f of this.flares) for (const e of f.els) { e.m.removeFromParent(); (e.m.material as THREE.Material).dispose(); e.m.geometry !== PLANE && e.m.geometry.dispose(); }
    this.flares = [];
    for (const v of list) {
      const fl = v.flare;
      if (fl?.texture && fl.elements?.length && loadTex) {
        // Unity Flare asset (layout 1 = 1 large, 2 medium, 8 small)
        const entry: FlareEls = { view: v, els: [] };
        this.flares.push(entry);
        const lc = fl.color ? new THREE.Color(fl.color[0], fl.color[1], fl.color[2]) : new THREE.Color(1, 1, 1);
        const br = fl.brightness ?? 1;
        void loadTex(fl.texture).then((tex) => {
          if (!tex || !this.flares.includes(entry)) return;
          for (const el of fl.elements ?? []) {
            const geo = new THREE.PlaneGeometry(1, 1);
            const [u0, v0, u1, v1] = flareRect(el.image ?? 0, fl.layout ?? 1);
            const uv = geo.attributes.uv as THREE.BufferAttribute;
            // PlaneGeometry uv order: (0,1) (1,1) (0,0) (1,0)
            uv.setXY(0, u0, v1); uv.setXY(1, u1, v1); uv.setXY(2, u0, v0); uv.setXY(3, u1, v0);
            const c = el.color ? new THREE.Color(el.color[0], el.color[1], el.color[2]) : new THREE.Color(1, 1, 1);
            if (el.useLightColor) c.multiply(lc);
            c.multiplyScalar(br * 1.6);
            const m = new THREE.Mesh(geo, flareMat(c, tex));
            m.renderOrder = -5;
            this.flareRoot.add(m);
            entry.els.push({ m, d: (el.pos ?? 0) / 2, size: (el.size ?? 10) * 0.0065, base: 1, rel: true });
          }
        });
        continue;
      }
      const glow = glowTexture();
      const ring = flareRingTexture();
      const c = v.color;
      const defs: { d: number; size: number; tex: THREE.Texture; col: THREE.Color; a: number }[] = [
        { d: 0, size: 420, tex: glow, col: c, a: 0.9 },
        { d: 0, size: 120, tex: glow, col: new THREE.Color(1, 1, 1), a: 1 },
        { d: 0.35, size: 50, tex: ring, col: new THREE.Color('#9fd8ff'), a: 0.5 },
        { d: 0.55, size: 26, tex: glow, col: new THREE.Color('#ffd27a'), a: 0.5 },
        { d: 0.8, size: 110, tex: ring, col: new THREE.Color('#7fb4ff'), a: 0.35 },
        { d: 1.1, size: 60, tex: ring, col: new THREE.Color('#c9a0ff'), a: 0.3 },
        { d: 1.4, size: 160, tex: ring, col: new THREE.Color('#8fffd8'), a: 0.18 },
      ];
      const els = defs.map((d) => {
        const m = new THREE.Mesh(PLANE, flatMat(d.col, d.a, true, d.tex));
        m.renderOrder = -5;
        this.flareRoot.add(m);
        return { m, d: d.d, size: d.size * v.size, base: d.a, rel: false };
      });
      this.flares.push({ view: v, els });
    }
  }

  updateFlares(camera: THREE.Camera, w: number, h: number): void {
    for (const f of this.flares) {
      const p = this.tmp.copy(f.view.pos).project(camera);
      const behind = p.z > 1 || p.z < -1;
      const edge = Math.max(Math.abs(p.x), Math.abs(p.y));
      const vis = behind ? 0 : 1 - THREE.MathUtils.smoothstep(edge, 0.85, 1.25);
      const sx = (p.x * 0.5 + 0.5) * w;
      const sy = (1 - (p.y * 0.5 + 0.5)) * h;
      const cx = w / 2;
      const cy = h / 2;
      for (const e of f.els) {
        e.m.visible = vis > 0.01;
        if (!e.m.visible) continue;
        const x = sx + (cx - sx) * e.d * 2;
        const y = sy + (cy - sy) * e.d * 2;
        e.m.position.set(x, -y, 0);
        const sz = e.rel ? e.size * h : e.size;
        e.m.scale.set(sz, sz, 1);
        const mm = e.m.material as THREE.MeshBasicMaterial | THREE.ShaderMaterial;
        if ((mm as THREE.ShaderMaterial).isShaderMaterial) (mm as THREE.ShaderMaterial).uniforms.uA.value = e.base * vis;
        else (mm as THREE.MeshBasicMaterial).opacity = e.base * vis;
      }
    }
  }
}
