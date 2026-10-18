import * as THREE from 'three';
import type { ModelLibrary } from './models';
import { glowTexture } from './sprites3d';

/**
 * Small player for the scene agent's simplified Unity Shuriken emitters (manifest3d.maps.json `fx.*`).
 * Supports bursts + rate, lifetime/speed/size(XYZ)/rotation ranges, sphere/cone shapes, gravity, limitVelocity,
 * velocityOverLife, size/colour/rotation over life, texture-sheet animation, billboard/stretched/vertical render
 * (mesh render falls back to billboards), additive/alpha blend, local/world simulation space.
 */

type Range = number[];
interface Curve { curve?: number[][] }
interface Gradient { gradient?: { color?: number[][]; alpha?: number[][] } }
export interface EmitterDef {
  duration?: number; loop?: boolean; delay?: Range; simSpeed?: number; space?: string; maxParticles?: number;
  lifetime?: Range; speed?: Range; size?: Range; sizeXYZ?: Range[]; rotation?: Range; startColor?: { const?: number[] };
  gravity?: Range; rate?: Range; bursts?: { time: number; count: Range; cycles?: number; interval?: number }[];
  shape?: { type?: string; radius?: number; radiusThickness?: number; angle?: number; arc?: number; scale?: number[]; pos?: number[]; rotDeg?: number[] };
  colorOverLife?: Gradient; sizeOverLife?: Curve; rotationOverLife?: Range;
  velocityOverLife?: { x?: Range; y?: Range; z?: Range; radial?: Range };
  limitVelocity?: { magnitude?: Range; dampen?: number };
  sheet?: { tilesX?: number; tilesY?: number; frameOverTime?: Range | Curve; startFrame?: Range; cycles?: number };
  render?: string; lengthScale?: number; velocityScale?: number; tex?: string; blend?: string; tint?: number[];
}
export interface FxDef { emitters?: { name?: string; pos?: number[]; quat?: number[]; scale?: number[]; emitter: EmitterDef }[]; totalTime?: number; loop?: boolean }

const rnd = (r?: Range, d = 0) => (r && r.length ? r[0] + Math.random() * ((r[1] ?? r[0]) - r[0]) : d);

function evalCurve(c: number[][] | undefined, t: number, d = 1): number {
  if (!c || !c.length) return d;
  if (t <= c[0][0]) return c[0][1];
  for (let i = 1; i < c.length; i++) {
    if (t <= c[i][0]) {
      const a = c[i - 1];
      const b = c[i];
      const k = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
      return a[1] + (b[1] - a[1]) * k;
    }
  }
  return c[c.length - 1][1];
}

function evalGradient(g: Gradient['gradient'] | undefined, t: number, out: number[]): void {
  out[0] = out[1] = out[2] = out[3] = 1;
  if (!g) return;
  const col = g.color;
  if (col && col.length) {
    let a = col[0];
    let b = col[col.length - 1];
    for (let i = 1; i < col.length; i++) if (t <= col[i][0]) { a = col[i - 1]; b = col[i]; break; }
    const k = t <= a[0] ? 0 : t >= b[0] ? 1 : (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
    out[0] = a[1] + (b[1] - a[1]) * k;
    out[1] = a[2] + (b[2] - a[2]) * k;
    out[2] = a[3] + (b[3] - a[3]) * k;
  }
  if (g.alpha && g.alpha.length) out[3] = evalCurve(g.alpha, t, 1);
}

interface P { p: THREE.Vector3; v: THREE.Vector3; age: number; life: number; sx: number; sy: number; rot: number; rotV: number; frame0: number }

const VERT = `
  attribute vec3 iPos; attribute vec2 iSize; attribute float iRot; attribute vec4 iColor; attribute vec3 iVel; attribute float iFrame;
  uniform float uMode; uniform float uLen; uniform vec2 uTiles;
  varying vec2 vUv; varying vec4 vColor;
  void main() {
    vColor = iColor;
    float f = floor(iFrame + 0.5);
    float tx = mod(f, uTiles.x);
    float ty = floor(f / uTiles.x);
    vec2 uv = position.xy + 0.5;
    vUv = vec2((tx + uv.x) / uTiles.x, 1.0 - (ty + 1.0 - uv.y) / uTiles.y);
    vec4 mv = viewMatrix * vec4(iPos, 1.0);
    vec2 c = position.xy;
    if (uMode > 1.5) {
      // flat (horizontal) quad in world XZ
      float cr = cos(iRot), sr = sin(iRot);
      vec2 r = vec2(c.x * cr - c.y * sr, c.x * sr + c.y * cr) * iSize;
      mv = viewMatrix * vec4(iPos + vec3(r.x, 0.0, r.y), 1.0);
    } else if (uMode > 0.5) {
      // stretched along the view-space velocity
      vec3 vv = (viewMatrix * vec4(iVel, 0.0)).xyz;
      vec2 d = length(vv.xy) > 1e-4 ? normalize(vv.xy) : vec2(1.0, 0.0);
      vec2 n = vec2(-d.y, d.x);
      mv.xy += d * (c.x - 0.5) * iSize.x * uLen + n * c.y * iSize.y;
    } else {
      float cr = cos(iRot), sr = sin(iRot);
      mv.xy += vec2(c.x * cr - c.y * sr, c.x * sr + c.y * cr) * iSize;
    }
    gl_Position = projectionMatrix * mv;
  }`;
const FRAG = `
  uniform sampler2D uMap; uniform float uAdd;
  varying vec2 vUv; varying vec4 vColor;
  void main() {
    vec4 t = texture2D(uMap, vUv) * vColor;
    if (uAdd > 0.5) gl_FragColor = vec4(t.rgb * t.a, 1.0);
    else gl_FragColor = t;
  }`;

class EmitterSim {
  readonly mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private ps: P[] = [];
  private max: number;
  private t = 0;
  private emitAcc = 0;
  private burstsDone: number[];
  private aPos: Float32Array; private aSize: Float32Array; private aRot: Float32Array; private aCol: Float32Array; private aVel: Float32Array; private aFrame: Float32Array;
  private local = new THREE.Matrix4();
  private world = new THREE.Matrix4();
  private tmp = new THREE.Vector3();
  private col = [1, 1, 1, 1];
  private delay: number;
  private scale: number;
  emitting = true;

  constructor(private e: EmitterDef, tr: { pos?: number[]; quat?: number[]; scale?: number[] }, fxScale: number, lib: ModelLibrary, private parent: THREE.Object3D) {
    this.max = Math.min(300, Math.max(1, e.maxParticles ?? 50));
    this.burstsDone = (e.bursts ?? []).map(() => 0);
    this.delay = rnd(e.delay, 0);
    const s = tr.scale ?? [1, 1, 1];
    this.scale = (s[0] ?? 1) * fxScale;
    this.local.compose(
      new THREE.Vector3(...((tr.pos ?? [0, 0, 0]) as [number, number, number])).multiplyScalar(fxScale),
      new THREE.Quaternion(...((tr.quat ?? [0, 0, 0, 1]) as [number, number, number, number])),
      new THREE.Vector3(1, 1, 1),
    );
    const g = new THREE.InstancedBufferGeometry();
    const base = new THREE.PlaneGeometry(1, 1);
    g.index = base.index;
    g.setAttribute('position', base.attributes.position);
    const n = this.max;
    const mk = (arr: Float32Array, k: number) => new THREE.InstancedBufferAttribute(arr, k).setUsage(THREE.DynamicDrawUsage);
    this.aPos = new Float32Array(n * 3); this.aSize = new Float32Array(n * 2); this.aRot = new Float32Array(n);
    this.aCol = new Float32Array(n * 4); this.aVel = new Float32Array(n * 3); this.aFrame = new Float32Array(n);
    g.setAttribute('iPos', mk(this.aPos, 3)); g.setAttribute('iSize', mk(this.aSize, 2)); g.setAttribute('iRot', mk(this.aRot, 1));
    g.setAttribute('iColor', mk(this.aCol, 4)); g.setAttribute('iVel', mk(this.aVel, 3)); g.setAttribute('iFrame', mk(this.aFrame, 1));
    g.instanceCount = 0;
    this.geo = g;
    const add = (e.blend ?? 'add') !== 'alpha';
    const mode = e.render === 'stretched' ? 1 : e.render === 'horizontal' ? 2 : 0;
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: glowTexture() }, uAdd: { value: add ? 1 : 0 }, uMode: { value: mode }, uLen: { value: e.lengthScale ?? 1 },
        uTiles: { value: new THREE.Vector2(e.sheet?.tilesX ?? 1, e.sheet?.tilesY ?? 1) },
      },
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: add ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    if (e.tex) void lib.image(e.tex, true).then((t) => { if (t) mat.uniforms.uMap.value = t; });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 12;
  }

  private spawn(n: number): void {
    const e = this.e;
    const sh = e.shape;
    this.world.multiplyMatrices(this.parent.matrixWorld, this.local);
    for (let i = 0; i < n && this.ps.length < this.max; i++) {
      const dir = new THREE.Vector3();
      const pos = new THREE.Vector3();
      const type = sh?.type;
      if (type === 'cone') {
        const a = THREE.MathUtils.degToRad(sh?.angle ?? 25) * Math.random();
        const ph = Math.random() * Math.PI * 2;
        dir.set(Math.sin(a) * Math.cos(ph), Math.sin(a) * Math.sin(ph), Math.cos(a));
        const r = (sh?.radius ?? 1) * Math.sqrt(Math.random());
        pos.set(Math.cos(ph) * r, Math.sin(ph) * r, 0);
      } else if (type === 'sphere') {
        dir.randomDirection();
        const th = sh?.radiusThickness ?? 1;
        const r = (sh?.radius ?? 1) * (1 - th + th * Math.cbrt(Math.random()));
        pos.copy(dir).multiplyScalar(r);
      } else {
        dir.set(0, 0, 1);
      }
      if (sh?.rotDeg) {
        const eu = new THREE.Euler(...(sh.rotDeg.map((d) => THREE.MathUtils.degToRad(d)) as [number, number, number]));
        dir.applyEuler(eu);
        pos.applyEuler(eu);
      }
      if (sh?.pos) pos.add(new THREE.Vector3(sh.pos[0], sh.pos[1], sh.pos[2]));
      pos.multiplyScalar(this.scale);
      const sp = rnd(e.speed, 0) * this.scale;
      const v = dir.multiplyScalar(sp);
      // simulate in world space (local-space emitters are re-anchored to the parent each frame below)
      const wp = pos.applyMatrix4(this.world);
      v.transformDirection(this.world).multiplyScalar(sp);
      const sx = (e.sizeXYZ ? rnd(e.sizeXYZ[0]) : rnd(e.size, 10)) * this.scale;
      const sy = e.sizeXYZ ? rnd(e.sizeXYZ[1]) * this.scale : sx;
      const tiles = (e.sheet?.tilesX ?? 1) * (e.sheet?.tilesY ?? 1);
      this.ps.push({
        p: wp, v, age: 0, life: Math.max(0.02, rnd(e.lifetime, 1)), sx, sy, rot: rnd(e.rotation, 0), rotV: rnd(e.rotationOverLife, 0),
        frame0: Math.floor(rnd(e.sheet?.startFrame, 0)) % Math.max(1, tiles),
      });
    }
  }

  /** returns false when finished */
  update(dt: number, follow: THREE.Vector3 | null): boolean {
    const e = this.e;
    const sdt = dt * (e.simSpeed ?? 1);
    this.t += sdt;
    const t = this.t - this.delay;
    const dur = e.duration ?? 1;
    if (t >= 0 && this.emitting && (e.loop || t <= dur)) {
      const lt = e.loop ? t % dur : t;
      (e.bursts ?? []).forEach((b, i) => {
        const cycles = b.cycles ?? 1;
        while (this.burstsDone[i] < cycles && lt >= b.time + this.burstsDone[i] * (b.interval ?? 0.01)) {
          this.spawn(Math.round(rnd(b.count, 0)));
          this.burstsDone[i]++;
        }
      });
      if (e.loop && lt < sdt) this.burstsDone = this.burstsDone.map(() => 0);
      this.emitAcc += rnd(e.rate, 0) * sdt;
      const n = Math.floor(this.emitAcc);
      this.emitAcc -= n;
      if (n > 0) this.spawn(n);
    }
    const g = -rnd(e.gravity, 0) * 9.81 * 10;
    const lim = e.limitVelocity;
    const vol = e.velocityOverLife;
    const sheet = e.sheet;
    const tiles = (sheet?.tilesX ?? 1) * (sheet?.tilesY ?? 1);
    let k = 0;
    const keep: P[] = [];
    for (const p of this.ps) {
      p.age += sdt;
      if (p.age >= p.life) continue;
      keep.push(p);
      const a = p.age / p.life;
      p.v.y += g * sdt;
      if (lim?.magnitude) {
        const m = rnd(lim.magnitude, 1) * this.scale;
        const l = p.v.length();
        if (l > m) p.v.multiplyScalar(1 - (lim.dampen ?? 0) * (1 - m / l));
      }
      this.tmp.copy(p.v);
      if (vol) this.tmp.add(new THREE.Vector3(rnd(vol.x), rnd(vol.y), rnd(vol.z)).multiplyScalar(this.scale));
      p.p.addScaledVector(this.tmp, sdt);
      p.rot += p.rotV * sdt;
      const so = evalCurve(e.sizeOverLife?.curve, a, 1);
      evalGradient(e.colorOverLife?.gradient, a, this.col);
      const sc = e.startColor?.const ?? [1, 1, 1, 1];
      const tint = e.tint ?? [1, 1, 1, 1];
      const o = k;
      const px = follow && e.space !== 'world' ? p.p.x + follow.x : p.p.x;
      const py = follow && e.space !== 'world' ? p.p.y + follow.y : p.p.y;
      const pz = follow && e.space !== 'world' ? p.p.z + follow.z : p.p.z;
      this.aPos[o * 3] = px; this.aPos[o * 3 + 1] = py; this.aPos[o * 3 + 2] = pz;
      this.aSize[o * 2] = p.sx * so; this.aSize[o * 2 + 1] = p.sy * so;
      this.aRot[o] = p.rot;
      this.aCol[o * 4] = this.col[0] * sc[0] * tint[0] * 1.5;
      this.aCol[o * 4 + 1] = this.col[1] * sc[1] * tint[1] * 1.5;
      this.aCol[o * 4 + 2] = this.col[2] * sc[2] * tint[2] * 1.5;
      this.aCol[o * 4 + 3] = this.col[3] * sc[3] * tint[3];
      this.aVel[o * 3] = p.v.x; this.aVel[o * 3 + 1] = p.v.y; this.aVel[o * 3 + 2] = p.v.z;
      let fr = 0;
      if (sheet && tiles > 1) {
        const fot = sheet.frameOverTime;
        const f = Array.isArray(fot) ? rnd(fot, 0) : evalCurve((fot as Curve | undefined)?.curve, a, a);
        fr = (p.frame0 + Math.floor(f * (sheet.cycles ?? 1) * tiles)) % tiles;
      }
      this.aFrame[o] = fr;
      k++;
    }
    this.ps = keep;
    this.geo.instanceCount = k;
    for (const n of ['iPos', 'iSize', 'iRot', 'iColor', 'iVel', 'iFrame']) (this.geo.attributes[n] as THREE.BufferAttribute).needsUpdate = true;
    const finished = !e.loop && t > dur && this.ps.length === 0;
    const stopped = !this.emitting && this.ps.length === 0;
    return !(finished || stopped);
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

/** One spawned effect (all emitters of an fx prefab). */
export class ParticleFx {
  readonly anchor = new THREE.Object3D();
  private sims: EmitterSim[] = [];

  /**
   * @param follow  optional getter: the effect origin follows it (local-space emitters move with it)
   */
  constructor(def: FxDef, root: THREE.Object3D, lib: ModelLibrary, pos: THREE.Vector3, scale = 1, private follow: (() => THREE.Vector3 | null) | null = null) {
    this.anchor.position.copy(pos);
    root.add(this.anchor);
    this.anchor.updateMatrixWorld(true);
    for (const em of def.emitters ?? []) {
      if (!em.emitter) continue;
      const s = new EmitterSim(em.emitter, em, scale, lib, this.anchor);
      root.add(s.mesh);
      this.sims.push(s);
    }
  }

  /** stop emitting; live particles fade out */
  stop(): void {
    for (const s of this.sims) s.emitting = false;
  }

  update(dt: number): boolean {
    if (this.follow) {
      const p = this.follow();
      if (p) this.anchor.position.copy(p);
    }
    this.anchor.updateMatrixWorld(true);
    let alive = false;
    for (const s of this.sims) if (s.update(dt, null)) alive = true;
    return alive;
  }

  dispose(): void {
    for (const s of this.sims) s.dispose();
    this.anchor.removeFromParent();
  }
}
