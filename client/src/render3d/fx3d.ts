import * as THREE from 'three';
import { Assets } from '../assets';
import type { EntId, SheetInfo } from '../types';
import type { Ent3D, Entities3D } from './entities3d';
import type { RocketDef, SheetLike } from './manifest3d';
import { Manifest3DLoader } from './manifest3d';
import { ModelLibrary, instantiate, type ModelTemplate } from './models';
import { PLANE, SheetBillboard, beamTexture, glowTexture, smokeTexture } from './sprites3d';
import { Ribbon, trailMaterial } from './trail';
import { ParticleFx, type FxDef } from './particles';

interface Fx { update(now: number, dt: number): boolean; dispose(): void }

export const LASER_COLORS: Record<string, string> = {
  red: '#ff3020', blue: '#3a8cff', green: '#38ff58', white: '#e8f2ff', sab: '#4ad8ff', rsb: '#ffa020',
};


/** Lasers, rockets, explosions, shield hits and impact sparks in 3D. */
export class Fx3D {
  readonly root = new THREE.Group();
  private fx: Fx[] = [];
  private lights: { l: THREE.PointLight; until: number; t0: number; peak: number }[] = [];
  private laserMats = new Map<string, { mat: THREE.MeshBasicMaterial; vertical: boolean; width: number; length: number }>();
  private shieldGeo = new THREE.IcosahedronGeometry(1, 3);
  private sparkMat = new THREE.SpriteMaterial({ map: glowTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
  private particleMat: THREE.ShaderMaterial;
  camera: THREE.Camera | null = null;

  constructor(
    scene: THREE.Scene,
    private readonly assets: Assets,
    private readonly lib: ModelLibrary,
    private readonly man: Manifest3DLoader,
    private readonly ents3d: Entities3D,
  ) {
    scene.add(this.root);
    // fixed pool -> no shader recompiles when explosions light up the scene
    for (let i = 0; i < 4; i++) {
      const l = new THREE.PointLight(0xffaa55, 0, 900, 1.2);
      l.position.set(0, -1e5, 0);
      scene.add(l);
      this.lights.push({ l, until: 0, t0: 0, peak: 0 });
    }
    this.particleMat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: glowTexture() }, uScale: { value: 800 } },
      vertexShader: `
        attribute vec3 aColor; attribute float aSize; attribute float aAlpha;
        uniform float uScale;
        varying vec3 vC; varying float vA;
        void main() {
          vC = aColor; vA = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * uScale / -mv.z;
        }`,
      fragmentShader: `
        uniform sampler2D uMap; varying vec3 vC; varying float vA;
        void main() { vec4 t = texture2D(uMap, gl_PointCoord); gl_FragColor = vec4(vC * t.a * vA, 1.0); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
  }

  rocketsDef(): Record<string, unknown> | null {
    return (this.man.data.rockets as unknown as Record<string, unknown>) ?? null;
  }

  /** scene agent particle prefab by name (fx.explosion, fx.impactHullLaser, …) */
  fxDef(name: string): FxDef | null {
    const d = this.man.data.fx[name] as FxDef | undefined;
    return d && Array.isArray(d.emitters) && d.emitters.length ? d : null;
  }

  /** spawn a particle prefab; returns the handle (null if the manifest has no such fx) */
  particles(name: string, pos: THREE.Vector3, scale = 1, follow: (() => THREE.Vector3 | null) | null = null): ParticleFx | null {
    const d = this.fxDef(name);
    if (!d) return null;
    const p = new ParticleFx(d, this.root, this.lib, pos, scale, follow);
    this.fx.push(new ParticleWrap(p));
    return p;
  }

  setPixelScale(s: number): void {
    this.particleMat.uniforms.uScale.value = s;
  }

  flash(pos: THREE.Vector3, color: THREE.ColorRepresentation, peak: number, ms: number, now: number): void {
    let slot = this.lights.find((s) => s.until < now);
    if (!slot) slot = this.lights.reduce((a, b) => (a.until < b.until ? a : b));
    slot.l.position.copy(pos).setY(pos.y + 80);
    slot.l.color.set(color);
    slot.t0 = now;
    slot.until = now + ms;
    slot.peak = peak;
  }

  private posOf(id: EntId): () => THREE.Vector3 | null {
    let last: THREE.Vector3 | null = null;
    return () => {
      const e = this.ents3d.get(id);
      if (e) last = (last ?? new THREE.Vector3()).copy(e.root.position);
      return last;
    };
  }

  private laserLook(color: string, ammo: string) {
    const key = `${color}|${ammo}`;
    let l = this.laserMats.get(key);
    if (l) return l;
    const def = this.man.data.lasers[color] ?? this.man.data.lasers[ammo];
    const rel3d = typeof def === 'string' ? def : def?.tex;
    const rel2d = this.assets.manifest.lasers[color] ?? this.assets.manifest.lasers[ammo];
    const hex = (typeof def === 'object' && def?.color) || LASER_COLORS[color] || '#ff3020';
    const mat = new THREE.MeshBasicMaterial({
      map: beamTexture(), color: new THREE.Color(hex).multiplyScalar(2.6), transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    const sz = typeof def === 'object' ? def?.size : undefined;
    const look = {
      mat, vertical: false, width: sz?.[1] ?? ((typeof def === 'object' && def?.width) || (ammo === 'rsb' ? 16 : 11)),
      length: sz?.[0] ?? ((typeof def === 'object' && def?.length) || (ammo === 'rsb' ? 190 : 150)),
      // scene agent lasers: flat quads on the plane (facing +Y), u=0 = head, 1 px = 1 unit
      flat: !!sz,
    };
    const apply = (tex: THREE.Texture | null, is3d: boolean) => {
      if (!tex) return false;
      const img = tex.image as { width: number; height: number };
      look.vertical = img.height > img.width;
      mat.map = tex;
      // 2D laser sprites are already coloured; 3D beam textures are tinted
      // 2D-style sprites (also the scene agent's flat lasers) are already coloured; beam textures get tinted
      mat.color.set(is3d && !look.flat ? hex : '#ffffff').multiplyScalar(is3d && !look.flat ? 2.6 : 2.0);
      mat.needsUpdate = true;
      return true;
    };
    if (rel3d) void this.lib.image(rel3d, true).then((t) => { if (!apply(t, true) && rel2d) void this.assets.texture(rel2d).then((t2) => apply(t2, false)); });
    else if (rel2d) void this.assets.texture(rel2d).then((t) => apply(t, false));
    this.laserMats.set(key, look);
    return look;
  }

  laser(from: EntId, to: EntId, ammo: string, onHit: () => void, now: number, shield = false): void {
    const src = this.ents3d.get(from);
    const dst = this.posOf(to);
    if (!src || !dst()) {
      onHit();
      return;
    }
    const color = this.assets.laserColorFor(ammo);
    const look = this.laserLook(color, ammo);
    const origins = src.laserOrigins();
    const rsb = ammo === 'rsb';
    // DO fires from alternating laser points; use two at a time
    const shots = rsb ? [origins[src.laserIdx++ % origins.length]] : [origins[src.laserIdx++ % origins.length], origins[src.laserIdx++ % origins.length]];
    shots.forEach((o, i) => {
      this.fx.push(new Bolt(this.root, look, o.clone(), dst, now + i * 25, 1, i === shots.length - 1 ? () => {
        onHit();
        const p = dst();
        if (p) this.impact(p, to, color, now, shield);
      } : null));
    });
    // drones fire small lasers together with their owner
    for (const d of src.dronePositions()) {
      this.fx.push(new Bolt(this.root, look, d, dst, now + Math.random() * 120, 0.55, null));
    }
  }

  private impact(p: THREE.Vector3, to: EntId, color: string, now: number, shield: boolean): void {
    const e = this.ents3d.get(to);
    if (shield && e) this.fx.push(new ShieldHit(e, this.shieldGeo, now));
    const hp = p.clone().add(new THREE.Vector3((Math.random() - 0.5) * 30, 10, (Math.random() - 0.5) * 30));
    if (this.particles(shield ? 'impactShield' : 'impactHullLaser', hp) || this.particles('impactHullLaser', hp)) return;
    const s = new THREE.Sprite(this.sparkMat.clone());
    (s.material as THREE.SpriteMaterial).color.set(LASER_COLORS[color] ?? '#ffffff').multiplyScalar(2);
    s.position.copy(p).add(new THREE.Vector3((Math.random() - 0.5) * 30, 10, (Math.random() - 0.5) * 30));
    this.root.add(s);
    this.fx.push(new Spark(s, now, 180, 60));
  }

  rocket(from: EntId, to: EntId, id: string, onHit: () => void, now: number, shield = false): void {
    const src = this.ents3d.get(from);
    const dst = this.posOf(to);
    const p1 = dst();
    if (!src || !p1) {
      onHit();
      return;
    }
    const p0 = src.root.position.clone();
    const d = p0.distanceTo(p1);
    const def = this.man.data.rockets[id] as RocketDef | undefined;
    const speed = def?.speed ?? 1.4; // units per ms
    const dur = THREE.MathUtils.clamp(d / speed, 320, 1100);
    const r = new Rocket3D(this, this.root, this.lib, this.assets, def ?? null, this.assets.manifest.rockets[id] ?? Object.values(this.assets.manifest.rockets)[0], p0, dst, now, dur, src.heading, () => {
      onHit();
      const p = dst();
      if (p) {
        if (!this.particles('impactHullRocket', p.clone().setY(10))) this.explosionAt(p, performance.now(), false, 0.55);
        else this.flash(p, 0xffb060, 3, 300, performance.now());
        const e = this.ents3d.get(to);
        if (shield && e) this.fx.push(new ShieldHit(e, this.shieldGeo, performance.now()));
      }
    });
    this.fx.push(r);
  }

  /** smoke puff (used by rockets) */
  smoke(p: THREE.Vector3, now: number): void {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: smokeTexture(), color: 0x8a8f99, transparent: true, depthWrite: false, opacity: 0.5 }));
    s.position.copy(p);
    s.material.rotation = Math.random() * 6.28;
    this.root.add(s);
    this.fx.push(new Spark(s, now, 650, 26, 2.4, 0.5));
  }

  explosion(x: number, y: number, now: number, big: boolean): void {
    this.explosionAt(new THREE.Vector3(x, 0, y), now, big, big ? 1.25 : 0.8);
  }

  explosionAt(p: THREE.Vector3, now: number, big: boolean, scale: number): void {
    // scene agent's Unity explosion prefabs (fireball, sparks, streaks, sheet fireball) when available
    if (this.particles(big ? 'explosionLarge' : 'explosion', p.clone().setY(10), scale >= 1 ? 1 : 0.8)) {
      this.flash(p, big ? 0xffa040 : 0xffc070, big ? 9 : 4, big ? 650 : 350, now);
      return;
    }
    const fxSheet = this.man.data.fx.explosion;
    const m2 = this.assets.manifest as typeof this.assets.manifest & { explosionSmall?: SheetInfo };
    let sheet: SheetInfo | null = null;
    if (fxSheet && typeof fxSheet === 'object' && (fxSheet as SheetLike).url) sheet = { ...(fxSheet as SheetLike), url: `/assets3d/${(fxSheet as SheetLike).url.replace(/^\/?(assets3d\/)?/, '')}` };
    else if (!big && m2.explosionSmall?.url) sheet = m2.explosionSmall;
    else if (m2.explosion?.url) sheet = m2.explosion;
    this.fx.push(new Explosion3D(this, this.root, this.assets, sheet, p.clone(), now, scale, big, this.particleMat));
    this.flash(p, big ? 0xffa040 : 0xffc070, big ? 9 : 4, big ? 650 : 350, now);
  }

  update(now: number, dt: number): void {
    // fx may spawn new fx while updating (impacts, smoke): swap the list first so nothing gets lost
    const list = this.fx;
    this.fx = [];
    const keep: Fx[] = [];
    for (const f of list) {
      let alive = false;
      try { alive = f.update(now, dt); } catch (e) { console.error('[render3d] fx error', e); }
      if (alive) keep.push(f);
      else f.dispose();
    }
    this.fx = keep.concat(this.fx);
    for (const s of this.lights) {
      if (s.until < now) { s.l.intensity = 0; continue; }
      const k = (now - s.t0) / Math.max(1, s.until - s.t0);
      s.l.intensity = s.peak * Math.PI * 250 * (k < 0.1 ? k / 0.1 : 1 - (k - 0.1) / 0.9);
    }
    if (this.camera) {
      const cam = this.camera;
      for (const f of this.fx) if (f instanceof Bolt) f.orient(cam);
    }
  }

  clear(): void {
    for (const f of this.fx) f.dispose();
    this.fx = [];
    for (const s of this.lights) { s.until = 0; s.l.intensity = 0; }
  }
}

// -------------------------------------------------------------------------------------------

/** Cylindrically billboarded additive bolt travelling to the target. */
class Bolt implements Fx {
  private mesh: THREE.Mesh;
  private hit = false;
  private dur = 0;
  private head = new THREE.Vector3();
  private dir = new THREE.Vector3(1, 0, 0);
  private len = 0;
  private started = false;

  constructor(
    root: THREE.Group,
    private readonly look: { mat: THREE.MeshBasicMaterial; vertical: boolean; width: number; length: number; flat?: boolean },
    private readonly from: THREE.Vector3,
    private readonly to: () => THREE.Vector3 | null,
    private readonly t0: number,
    private readonly scale: number,
    private readonly onHit: (() => void) | null,
  ) {
    this.mesh = new THREE.Mesh(PLANE, look.mat);
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 9;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    root.add(this.mesh);
    const p = to();
    const d = p ? p.distanceTo(from) : 300;
    this.dur = THREE.MathUtils.clamp(d / 2.2, 90, 300); // Unity client: ~0.3 s from laser point to target
  }

  update(now: number): boolean {
    if (now < this.t0) return true;
    const k = (now - this.t0) / this.dur;
    const to = this.to();
    if (k >= 1 || !to) {
      if (!this.hit) {
        this.hit = true;
        this.onHit?.();
      }
      return false;
    }
    const tgt = to.clone().setY(8);
    this.dir.subVectors(tgt, this.from);
    const d = this.dir.length() || 1;
    this.dir.divideScalar(d);
    this.len = Math.min(this.look.length * this.scale, d * 0.7);
    const along = Math.max(this.len / 2, k * d);
    this.head.copy(this.from).addScaledVector(this.dir, Math.min(along, d - this.len / 2));
    this.started = true;
    return true;
  }

  orient(cam: THREE.Camera): void {
    if (!this.started) return;
    this.mesh.visible = true;
    const x = this.dir;
    const m0 = this.mesh.matrix;
    if (this.look.flat) {
      // lies on the plane; local +x points backwards so texture u=0 (the head) leads
      const bx = x.clone().setY(0).normalize().negate();
      const bz = new THREE.Vector3(0, 1, 0);
      const by = new THREE.Vector3().crossVectors(bz, bx);
      m0.makeBasis(bx.multiplyScalar(this.len), by.multiplyScalar(this.look.width * this.scale), bz);
      m0.setPosition(this.head);
      this.mesh.matrixWorldNeedsUpdate = true;
      return;
    }
    const view = new THREE.Vector3().subVectors(cam.position, this.head).normalize();
    const y = new THREE.Vector3().crossVectors(view, x).normalize();
    const z = new THREE.Vector3().crossVectors(x, y);
    const m = this.mesh.matrix;
    const w = this.look.width * this.scale;
    if (this.look.vertical) {
      // texture long axis is v: map plane-y to the beam direction
      m.makeBasis(y.multiplyScalar(w), x.clone().multiplyScalar(this.len), z);
    } else m.makeBasis(x.clone().multiplyScalar(this.len), y.multiplyScalar(w), z);
    m.setPosition(this.head);
    this.mesh.matrixWorldNeedsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
  }
}

class ParticleWrap implements Fx {
  constructor(readonly p: ParticleFx) {}
  update(_now: number, dt: number): boolean {
    return this.p.update(Math.min(0.05, dt));
  }
  dispose(): void {
    this.p.dispose();
  }
}

class Spark implements Fx {
  constructor(private s: THREE.Sprite, private t0: number, private dur: number, private size: number, private grow = 1.6, private alpha = 1) {
    s.scale.setScalar(size);
    s.renderOrder = 10;
  }
  update(now: number): boolean {
    const k = (now - this.t0) / this.dur;
    if (k >= 1) return false;
    this.s.scale.setScalar(this.size * (1 + k * this.grow));
    (this.s.material as THREE.SpriteMaterial).opacity = this.alpha * (1 - k);
    this.s.position.y += 0.3;
    return true;
  }
  dispose(): void {
    this.s.removeFromParent();
    (this.s.material as THREE.Material).dispose();
  }
}

/** Fresnel bubble flash around the target when the shield absorbs damage. */
class ShieldHit implements Fx {
  private mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  constructor(private e: Ent3D, geo: THREE.BufferGeometry, private t0: number) {
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uA: { value: 1 }, uColor: { value: new THREE.Color('#4fb4ff').multiplyScalar(1.6) }, uT: { value: 0 } },
      vertexShader: `
        varying vec3 vN; varying vec3 vV; varying vec3 vP;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); vP = position;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform float uA; uniform vec3 uColor; uniform float uT;
        varying vec3 vN; varying vec3 vV; varying vec3 vP;
        void main() {
          float f = pow(1.0 - abs(dot(vN, vV)), 2.2);
          float hex = 0.6 + 0.4 * step(0.5, fract(sin(dot(floor(vP.xz * 7.0), vec2(12.9, 78.2))) * 43758.5));
          gl_FragColor = vec4(uColor * (f * 1.4 + 0.08) * hex * uA, 1.0);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    const r = Math.max(40, e.radius * 1.15);
    this.mesh.scale.set(r, r * 0.55, r);
    this.mesh.renderOrder = 8;
    e.root.add(this.mesh);
  }
  update(now: number): boolean {
    const k = (now - this.t0) / 380;
    if (k >= 1 || this.e.disposed) return false;
    this.mat.uniforms.uA.value = k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85;
    return true;
  }
  dispose(): void {
    this.mesh.removeFromParent();
    this.mat.dispose();
  }
}

/** Sheet billboard + additive particle burst + shock ring + light flash. */
class Explosion3D implements Fx {
  private bb: SheetBillboard | null = null;
  private pts: THREE.Points;
  private vel: Float32Array;
  private ring: THREE.Mesh;
  private flash: THREE.Sprite;
  private dur: number;
  private n: number;

  constructor(private fx: Fx3D, root: THREE.Group, assets: Assets, sheet: SheetInfo | null, p: THREE.Vector3, private t0: number, private scale: number, big: boolean, mat: THREE.ShaderMaterial) {
    if (sheet) {
      this.bb = new SheetBillboard(assets, sheet, scale, { renderOrder: 11, additive: false });
      this.bb.group.position.copy(p).setY(p.y + 20);
      root.add(this.bb.group);
    }
    this.dur = sheet ? (sheet.frames / (sheet.fps ?? 30)) * 1000 : 800;
    // particles
    const n = (this.n = big ? 70 : 28);
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const alpha = new Float32Array(n);
    this.vel = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos.set([p.x, p.y + 10, p.z], i * 3);
      const dir = new THREE.Vector3().randomDirection();
      dir.y = Math.abs(dir.y) * 0.6;
      const sp = (0.15 + Math.random() * 0.45) * scale * (big ? 1.2 : 0.8);
      this.vel.set([dir.x * sp, dir.y * sp, dir.z * sp], i * 3);
      const c = new THREE.Color().setHSL(0.06 + Math.random() * 0.06, 1, 0.55 + Math.random() * 0.3).multiplyScalar(2.2);
      col.set([c.r, c.g, c.b], i * 3);
      size[i] = (8 + Math.random() * 18) * scale;
      alpha[i] = 1;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
    this.pts = new THREE.Points(geo, mat);
    this.pts.frustumCulled = false;
    this.pts.renderOrder = 12;
    root.add(this.pts);
    // shock ring on the plane
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 48), new THREE.MeshBasicMaterial({
      color: new THREE.Color('#ffb060').multiplyScalar(1.5), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }));
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.copy(p).setY(-2);
    root.add(this.ring);
    // white core flash
    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: new THREE.Color('#ffe3b0').multiplyScalar(3), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    this.flash.position.copy(p).setY(p.y + 30);
    root.add(this.flash);
  }

  update(now: number, dt: number): boolean {
    const t = now - this.t0;
    if (t < 0) return true;
    const k = t / this.dur;
    if (k >= 1.2) return false;
    if (this.bb) {
      if (this.fx.camera) this.bb.group.quaternion.copy(this.fx.camera.quaternion);
      const sh = this.bb.sheet;
      this.bb.group.visible = k < 1;
      this.bb.setFrame(Math.min(sh.frames - 1, Math.floor(Math.min(0.999, k) * sh.frames)));
    }
    const pos = this.pts.geometry.attributes.position as THREE.BufferAttribute;
    const al = this.pts.geometry.attributes.aAlpha as THREE.BufferAttribute;
    const ms = dt * 1000;
    for (let i = 0; i < this.n; i++) {
      const o = i * 3;
      pos.array[o] += this.vel[o] * ms;
      pos.array[o + 1] += this.vel[o + 1] * ms;
      pos.array[o + 2] += this.vel[o + 2] * ms;
      this.vel[o] *= 0.985; this.vel[o + 1] *= 0.985; this.vel[o + 2] *= 0.985;
      al.array[i] = Math.max(0, 1 - k * (0.8 + (i % 5) * 0.1));
    }
    pos.needsUpdate = true;
    al.needsUpdate = true;
    const rk = Math.min(1, t / 450);
    const rs = (40 + rk * 260) * this.scale;
    this.ring.scale.set(rs, rs, 1);
    (this.ring.material as THREE.MeshBasicMaterial).opacity = (1 - rk) * 0.8;
    const fk = Math.min(1, t / 220);
    this.flash.scale.setScalar((60 + fk * 220) * this.scale);
    this.flash.material.opacity = 1 - fk;
    return true;
  }

  dispose(): void {
    this.bb?.dispose();
    this.pts.removeFromParent();
    this.pts.geometry.dispose();
    this.ring.removeFromParent();
    this.ring.geometry.dispose();
    (this.ring.material as THREE.Material).dispose();
    this.flash.removeFromParent();
    this.flash.material.dispose();
  }
}

/** Rocket: 3D model (or 2D sprite quad) on an eased, slightly arcing path with ribbon trail + smoke. */
class Rocket3D implements Fx {
  private obj = new THREE.Group();
  private trail: Ribbon;
  private hit = false;
  private lastSmoke = 0;
  private side: number;
  private prev = new THREE.Vector3();
  private sprite: THREE.Mesh | null = null;
  private sprite2: THREE.Mesh | null = null;
  private smokeFx: ParticleFx | null = null;
  private glow: THREE.Sprite;

  constructor(
    private fx: Fx3D,
    root: THREE.Group,
    lib: ModelLibrary,
    assets: Assets,
    def: RocketDef | null,
    rel2d: string | undefined,
    private from: THREE.Vector3,
    private to: () => THREE.Vector3 | null,
    private t0: number,
    private dur: number,
    heading: number,
    private onHit: () => void,
  ) {
    this.side = Math.random() < 0.5 ? -1 : 1;
    this.obj.rotation.y = -heading;
    root.add(this.obj);
    // scene agent: rockets are two crossed sprites (flat + vertical, u=0 = nose) with a TrailRenderer
    const rk = (fx.rocketsDef() ?? {}) as Record<string, unknown>;
    const tr = (typeof def?.trail === 'string' ? rk.trail : def?.trail) as { width?: number; time?: number; color?: string; tex?: string } | undefined;
    const trailColor = tr?.color ?? '#ff4d00';
    const mat = trailMaterial(trailColor, 1.6, null);
    this.trail = new Ribbon(mat, 32, tr?.width ?? 10, tr?.time ? tr.time * 1000 : 500, 3);
    if (tr?.tex) void lib.image(tr.tex, true).then((t) => { if (t) this.trail.mesh.material = trailMaterial(trailColor, 1.6, t); });
    root.add(this.trail.mesh);
    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: new THREE.Color('#ffa060').multiplyScalar(2.2), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    this.glow.scale.setScalar(18);
    this.obj.add(this.glow);
    const size = Array.isArray(def?.size) ? (def!.size as unknown as number[]) : null;
    const spriteTex = (def as { tex?: unknown } | null)?.tex;
    if (typeof spriteTex === 'string' && size) {
      void lib.image(spriteTex, true).then((t) => {
        if (!t || this.hit) return;
        const mk = () => new THREE.Mesh(PLANE, new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
        // pivot = tail: shift the quad forward by half its length; local -x flip puts u=0 (nose) in front
        const flat = mk();
        flat.rotation.set(-Math.PI / 2, 0, Math.PI);
        const vert = mk();
        vert.rotation.set(0, 0, Math.PI);
        for (const m of [flat, vert]) {
          m.scale.set(size[0], size[1], 1);
          m.position.x = 0;
          this.obj.add(m);
        }
        this.sprite = flat;
        this.sprite2 = vert;
      });
    } else {
      const useSprite = () => {
        if (!rel2d) return;
        void assets.texture(rel2d).then((t) => {
          if (!t || this.hit) return;
          const img = t.image as { width: number; height: number };
          const m = new THREE.Mesh(PLANE, new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
          const vertical = img.height > img.width;
          const L = Math.max(img.width, img.height);
          const W = Math.min(img.width, img.height);
          m.rotation.x = -Math.PI / 2;
          if (vertical) m.rotation.z = Math.PI / 2;
          m.scale.set(vertical ? W : L, vertical ? L : W, 1);
          this.sprite = m;
          this.obj.add(m);
        });
      };
      if (def?.glb) {
        const key = `rocket:${def.glb}|${def.tex?.diffuse ?? ''}`;
        void lib.template(key, def, typeof def.size === 'number' ? def.size : 34, '+x').then((t: ModelTemplate | null) => {
          if (this.hit) return;
          if (t) this.obj.add(instantiate(t));
          else useSprite();
        });
      } else useSprite();
    }
    this.smokeFx = fx.particles('rocketTrailSmoke', from.clone(), 1, () => this.obj.position);
    this.prev.copy(from);
    this.update(t0);
  }

  private hitAt = 0;

  update(now: number): boolean {
    const k = (now - this.t0) / this.dur;
    const to = this.to();
    if (this.hit || k >= 1 || !to) {
      if (!this.hit) {
        this.hit = true;
        this.hitAt = now;
        this.onHit();
        this.obj.visible = false;
        this.smokeFx?.stop();
      }
      // let the trail collapse and fade
      const cam = this.fx.camera;
      if (cam) this.trail.update(this.prev, now, cam.position);
      return now - this.hitAt < 450;
    }
    // ease-in (launch) then accelerate; lateral arc + slight lift
    const e = k * k * (3 - 2 * k) * 0.35 + k * k * 0.65;
    const dx = to.x - this.from.x;
    const dz = to.z - this.from.z;
    const d = Math.hypot(dx, dz) || 1;
    const nx = -dz / d;
    const nz = dx / d;
    const arc = Math.sin(Math.PI * e) * Math.min(120, d * 0.18) * this.side;
    const lift = Math.sin(Math.PI * e) * Math.min(60, d * 0.08) + 10;
    const x = this.from.x + dx * e + nx * arc;
    const z = this.from.z + dz * e + nz * arc;
    const p = new THREE.Vector3(x, lift, z);
    const dir = p.clone().sub(this.prev);
    if (dir.lengthSq() > 0.01) {
      const yaw = Math.atan2(dir.z, dir.x);
      this.obj.rotation.set(0, -yaw, Math.atan2(dir.y, Math.hypot(dir.x, dir.z)));
    }
    this.obj.position.copy(p);
    this.prev.copy(p);
    const cam = this.fx.camera;
    if (cam) this.trail.update(p, now, cam.position);
    if (!this.smokeFx && now - this.lastSmoke > 40) {
      this.lastSmoke = now;
      this.fx.smoke(p.clone().add(new THREE.Vector3((Math.random() - 0.5) * 6, 0, (Math.random() - 0.5) * 6)), now);
    }
    return true;
  }

  dispose(): void {
    this.obj.removeFromParent();
    if (this.sprite) (this.sprite.material as THREE.Material).dispose();
    if (this.sprite2) (this.sprite2.material as THREE.Material).dispose();
    this.smokeFx?.stop();
    this.glow.material.dispose();
    this.trail.dispose();
  }
}
