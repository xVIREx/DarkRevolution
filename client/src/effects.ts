import * as THREE from 'three';
import { Assets, assetUrl } from './assets';
import { World } from './world';
import { EntityManager } from './entities';
import { SheetSprite, basicMat, makeCircle, toThreeY } from './sprites';
import type { EntId } from './types';
import { NPC_SHOT_KEYS } from './npcshots';

interface Fx {
  update(now: number): boolean; // false = finished
  dispose(): void;
}

type Pos = { x: number; y: number };

const LASER_TINT: Record<string, number> = {
  red: 0xff3030, blue: 0x3a9bff, green: 0x40ff60, white: 0xf0f6ff, sab: 0x5ad0ff, rsb: 0xffa030,
};

/** Lasers, rockets, explosions, floating damage numbers. */
export class Effects {
  private fx: Fx[] = [];
  private dmgLayer: HTMLElement;
  private dmgEls: { el: HTMLElement; x: number; y: number; t0: number; dur: number }[] = [];

  constructor(private readonly assets: Assets, private readonly world: World, private readonly ents: EntityManager) {
    this.dmgLayer = document.createElement('div');
    this.dmgLayer.id = 'dmg-layer';
    document.body.appendChild(this.dmgLayer);
  }

  private posGetter(id: EntId, fallback: Pos | null): () => Pos | null {
    let last: Pos | null = fallback;
    return () => {
      const v = this.ents.get(id);
      if (v) last = { x: v.x, y: v.y };
      return last;
    };
  }

  laser(from: EntId, to: EntId, ammo: string, onHit: () => void, now: number, shield = false): void {
    if (this.world.r3d) return this.world.r3d.fx.laser(from, to, ammo, onHit, now, shield);
    const src = this.posGetter(from, null);
    const dst = this.posGetter(to, null);
    const p0 = src();
    if (!p0 || !dst()) {
      onHit();
      return;
    }
    const color = this.assets.laserColorFor(ammo);
    const rel = this.assets.manifest.lasers[color] ?? this.assets.manifest.lasers[ammo] ?? this.assets.manifest.lasers.red;
    const dur = 150;
    const start = { ...p0 };
    // alien projectiles: one shot, original colours
    const single = ammo === 'rsb' || NPC_SHOT_KEYS.has(ammo);
    const tint = NPC_SHOT_KEYS.has(ammo) ? 0xffffff : LASER_TINT[color] ?? 0xff3030;
    for (const side of single ? [0] : [-1, 1]) {
      this.fx.push(new Bolt(this.assets, this.world.effectLayer, rel, tint, start, dst, now, dur, side * 9,
        side === 1 || single ? onHit : null, ammo === 'rsb' ? 1.4 : 1));
    }
  }

  rocket(from: EntId, to: EntId, id: string, onHit: () => void, now: number, shield = false): void {
    if (this.world.r3d) return this.world.r3d.fx.rocket(from, to, id, onHit, now, shield);
    const src = this.posGetter(from, null);
    const dst = this.posGetter(to, null);
    const p0 = src();
    const p1 = dst();
    if (!p0 || !p1) {
      onHit();
      return;
    }
    const d = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const dur = THREE.MathUtils.clamp(d / 1.6, 250, 900);
    const rel = this.assets.manifest.rockets[id] ?? Object.values(this.assets.manifest.rockets)[0];
    this.fx.push(new Rocket(this.assets, this.world.effectLayer, rel, { ...p0 }, dst, now, dur, onHit));
  }

  explosion(x: number, y: number, now: number, big = true): void {
    if (this.world.r3d) return this.world.r3d.fx.explosion(x, y, now, big);
    this.fx.push(new Explosion(this.assets, this.world.effectLayer, x, y, now, big));
  }

  damage(x: number, y: number, text: string, cls: 'hp' | 'sh' | 'miss' | 'heal', now: number, dx = 0): void {
    const el = document.createElement('div');
    el.className = `dmg dmg-${cls}`;
    el.textContent = text;
    this.dmgLayer.appendChild(el);
    this.dmgEls.push({ el, x: x + dx, y, t0: now, dur: 1100 });
    if (this.dmgEls.length > 80) {
      const old = this.dmgEls.shift();
      old?.el.remove();
    }
  }

  /** DarkOrbit-style box collection: the box shrinks and is pulled into the collecting ship. */
  pickup(x: number, y: number, by: EntId, cargo: boolean, now: number): void {
    const img = document.createElement('img');
    img.className = 'pickup-fx';
    img.src = assetUrl((this.assets.manifest.box as Record<string, string>)[cargo ? 'cargo' : 'bonus'] ?? 'boxes/box2.png');
    this.dmgLayer.appendChild(img);
    const target = this.posGetter(by, { x, y });
    this.pickups.push({ el: img, x, y, target, t0: now });
  }

  private pickups: { el: HTMLImageElement; x: number; y: number; target: () => Pos | null; t0: number }[] = [];

  update(now: number): void {
    this.pickups = this.pickups.filter((p) => {
      const k = Math.min(1, (now - p.t0) / 380);
      if (k >= 1) {
        p.el.remove();
        return false;
      }
      const t = p.target() ?? { x: p.x, y: p.y };
      const e = k * k; // accelerate into the ship
      const wx = p.x + (t.x - p.x) * e;
      const wy = p.y + (t.y - p.y) * e;
      const s = this.world.worldToScreen(wx, wy);
      // same size as the box drawn in the world (3D: 55 units, 2D: the ~80 px sprite), shrinking into the ship
      const size = Math.abs(this.world.worldToScreen(wx + (this.world.r3d ? 55 : 80), wy).x - s.x);
      p.el.style.width = p.el.style.height = `${size.toFixed(1)}px`;
      p.el.style.transform = `translate(${s.x}px, ${s.y}px) translate(-50%, -50%) scale(${(1 - k) ** 1.5}) rotate(${e * 120}deg)`;
      p.el.style.filter = `brightness(${1 + k * 2.5})`;
      p.el.style.opacity = String(k < 0.75 ? 1 : 1 - (k - 0.75) / 0.25);
      return true;
    });
    this.fx = this.fx.filter((f) => {
      const alive = f.update(now);
      if (!alive) f.dispose();
      return alive;
    });
    this.dmgEls = this.dmgEls.filter((d) => {
      const k = (now - d.t0) / d.dur;
      if (k >= 1) {
        d.el.remove();
        return false;
      }
      const s = this.world.worldToScreen(d.x, d.y);
      const rise = 20 + k * 50;
      d.el.style.transform = `translate(${s.x}px, ${s.y - rise}px) translate(-50%, -100%) scale(${k < 0.1 ? 0.7 + k * 3 : 1})`;
      d.el.style.opacity = String(k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3);
      return true;
    });
  }

  clear(): void {
    for (const p of this.pickups) p.el.remove();
    this.pickups = [];
    for (const f of this.fx) f.dispose();
    this.fx = [];
    for (const d of this.dmgEls) d.el.remove();
    this.dmgEls = [];
  }
}

/** Shared helper: textured plane or tinted fallback quad. */
function makeQuad(assets: Assets, rel: string | undefined, tint: number, fallbackW: number, fallbackH: number) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), basicMat({ color: tint, blending: THREE.AdditiveBlending }));
  mesh.renderOrder = 10;
  mesh.scale.set(fallbackW, fallbackH, 1);
  const info = { mesh, w: fallbackW, h: fallbackH, vertical: false, textured: false };
  if (rel) {
    const t = assets.textureNow(rel);
    const apply = (tex: THREE.Texture) => {
      const img = tex.image as { width: number; height: number };
      const mat = mesh.material as THREE.MeshBasicMaterial;
      mat.map = tex;
      mat.color.setHex(0xffffff);
      mat.blending = THREE.NormalBlending;
      mat.needsUpdate = true;
      info.vertical = img.height > img.width;
      info.textured = true;
      const long = Math.max(img.width, img.height);
      const short = Math.min(img.width, img.height);
      info.w = long;
      info.h = short;
    };
    if (t) apply(t);
    else if (t === undefined) void assets.texture(rel).then((tex) => tex && apply(tex));
  }
  return info;
}

class Bolt implements Fx {
  private q: ReturnType<typeof makeQuad>;
  private hit = false;
  constructor(
    assets: Assets,
    private layer: THREE.Group,
    rel: string | undefined,
    tint: number,
    private from: Pos,
    private to: () => Pos | null,
    private t0: number,
    private dur: number,
    private side: number,
    private onHit: (() => void) | null,
    private scale: number,
  ) {
    this.q = makeQuad(assets, rel, tint, 70, 4);
    layer.add(this.q.mesh);
    this.update(t0);
  }

  update(now: number): boolean {
    const k = (now - this.t0) / this.dur;
    const to = this.to();
    if (k >= 1 || !to) {
      if (!this.hit) {
        this.hit = true;
        this.onHit?.();
      }
      return false;
    }
    const dx = to.x - this.from.x;
    const dy = to.y - this.from.y;
    const d = Math.hypot(dx, dy) || 1;
    const nx = -dy / d;
    const ny = dx / d;
    const off = this.side * (1 - k); // converge on target
    const len = Math.min(this.q.w * this.scale, d * 0.6, 160 * this.scale);
    const along = Math.max(len / 2, k * d);
    const x = this.from.x + (dx / d) * along + nx * off;
    const y = this.from.y + (dy / d) * along + ny * off;
    const m = this.q.mesh;
    m.position.set(x, toThreeY(y), 0);
    const ang = Math.atan2(-dy, dx); // three space
    m.rotation.z = ang + (this.q.vertical ? Math.PI / 2 : this.q.textured ? Math.PI : 0);
    if (this.q.vertical) m.scale.set(this.q.h * this.scale, len, 1);
    else m.scale.set(len, this.q.h * this.scale, 1);
    return true;
  }

  dispose(): void {
    this.layer.remove(this.q.mesh);
    this.q.mesh.geometry.dispose();
    (this.q.mesh.material as THREE.Material).dispose();
  }
}

class Rocket implements Fx {
  private q: ReturnType<typeof makeQuad>;
  private trail: THREE.Mesh;
  private hit = false;
  constructor(
    assets: Assets,
    private layer: THREE.Group,
    rel: string | undefined,
    private from: Pos,
    private to: () => Pos | null,
    private t0: number,
    private dur: number,
    private onHit: () => void,
  ) {
    this.q = makeQuad(assets, rel, 0xffd080, 26, 8);
    this.trail = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), basicMat({ color: 0xff9a40, opacity: 0.45, blending: THREE.AdditiveBlending }));
    this.trail.renderOrder = 9;
    layer.add(this.trail, this.q.mesh);
    this.update(t0);
  }

  update(now: number): boolean {
    const k = (now - this.t0) / this.dur;
    const to = this.to();
    if (k >= 1 || !to) {
      if (!this.hit) {
        this.hit = true;
        this.onHit();
      }
      return false;
    }
    const e = k * k * (3 - 2 * k) * 0.5 + k * 0.5;
    const dx = to.x - this.from.x;
    const dy = to.y - this.from.y;
    const x = this.from.x + dx * e;
    const y = this.from.y + dy * e;
    const ang = Math.atan2(-dy, dx);
    const m = this.q.mesh;
    m.position.set(x, toThreeY(y), 0);
    m.rotation.z = ang + (this.q.vertical ? Math.PI / 2 : this.q.textured ? Math.PI : 0);
    if (this.q.vertical) m.scale.set(this.q.h, this.q.w, 1);
    else m.scale.set(this.q.w, this.q.h, 1);
    const tl = Math.min(80, Math.hypot(dx, dy) * e);
    this.trail.position.set(x - (Math.cos(ang) * tl) / 2, toThreeY(y) - (Math.sin(ang) * tl) / 2, 0);
    this.trail.rotation.z = ang;
    this.trail.scale.set(tl, 3, 1);
    return true;
  }

  dispose(): void {
    this.layer.remove(this.q.mesh, this.trail);
    this.q.mesh.geometry.dispose();
    (this.q.mesh.material as THREE.Material).dispose();
    this.trail.geometry.dispose();
    (this.trail.material as THREE.Material).dispose();
  }
}

class Explosion implements Fx {
  private sprite: SheetSprite;
  private flash: THREE.Mesh;
  private dur: number;
  constructor(assets: Assets, private layer: THREE.Group, x: number, y: number, private t0: number, big: boolean) {
    const man = assets.manifest as typeof assets.manifest & { explosionSmall?: typeof assets.manifest.explosion };
    const pick = !big && man.explosionSmall?.url ? man.explosionSmall : man.explosion;
    const sheet = pick && pick.url ? pick : null;
    const ph = new THREE.Group();
    ph.add(makeCircle(60, 0xffa030, 0.8), makeCircle(35, 0xfff0a0, 0.9));
    this.sprite = new SheetSprite(assets, sheet, ph, 11);
    this.sprite.group.position.set(x, toThreeY(y), 0);
    this.flash = makeCircle(90, 0xffe0a0, 0.35);
    this.flash.renderOrder = 10;
    (this.flash.material as THREE.MeshBasicMaterial).blending = THREE.AdditiveBlending;
    this.flash.position.copy(this.sprite.group.position);
    this.dur = sheet ? (sheet.frames / (sheet.fps ?? 30)) * 1000 : 700;
    layer.add(this.flash, this.sprite.group);
  }

  update(now: number): boolean {
    const k = (now - this.t0) / this.dur;
    if (k >= 1) return false;
    const sh = this.sprite.sheet;
    if (sh && this.sprite.loaded) {
      this.sprite.setFrame(Math.min(sh.frames - 1, Math.floor(k * sh.frames)));
    } else {
      this.sprite.group.scale.setScalar(0.4 + k * 1.4);
      this.sprite.placeholder?.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
        if (m) m.opacity = 0.9 * (1 - k);
      });
    }
    this.flash.scale.setScalar(0.5 + k * 1.8);
    (this.flash.material as THREE.MeshBasicMaterial).opacity = 0.4 * (1 - k);
    return true;
  }

  dispose(): void {
    this.layer.remove(this.flash, this.sprite.group);
    this.sprite.dispose();
    this.flash.geometry.dispose();
    (this.flash.material as THREE.Material).dispose();
  }
}
