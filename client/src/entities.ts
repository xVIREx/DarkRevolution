import * as THREE from 'three';
import { Assets } from './assets';
import type { EntId, EntSnap } from './types';
import { FACTION_COLORS } from './types';
import { SheetSprite, basicMat, disposeTree, makeLabel, makeRing, makeTriangle, toThreeY } from './sprites';

interface Sample { t: number; x: number; y: number; a: number }

const BAR_W = 64;

/** lite views: no 2D sprites/labels (the 3D renderer draws entities itself) */
let LITE = false;
export function setEntityLite(v: boolean): void {
  LITE = v;
}
const BAR_H = 4;

export class EntityView {
  readonly group = new THREE.Group();
  readonly hud = new THREE.Group(); // counter-scaled (constant screen size)
  sprite: SheetSprite;
  sheetKey: string;
  history: Sample[] = [];
  snap: EntSnap;
  x = 0;
  y = 0;
  a = 0;
  radius = 40;
  halfH = 50;
  private label: THREE.Mesh;
  private labelKey = '';
  private hpFill: THREE.Mesh;
  private shFill: THREE.Mesh;
  private placeholderTri: THREE.Mesh | null = null;
  lastSeen = 0;

  constructor(private readonly assets: Assets, snap: EntSnap, readonly isMe: boolean, myFaction: string | null) {
    this.snap = snap;
    this.sheetKey = snap.s;
    this.sprite = this.makeSprite(snap);
    this.group.add(this.sprite.group);
    this.group.add(this.hud);

    // bars
    const barBg = new THREE.Mesh(new THREE.PlaneGeometry(BAR_W + 2, BAR_H * 2 + 3), basicMat({ color: 0x000000, opacity: 0.65 }));
    barBg.renderOrder = 7;
    this.hpFill = new THREE.Mesh(new THREE.PlaneGeometry(1, BAR_H), basicMat({ color: 0x35e04a }));
    this.shFill = new THREE.Mesh(new THREE.PlaneGeometry(1, BAR_H), basicMat({ color: 0x3aa0ff }));
    this.hpFill.renderOrder = 8;
    this.shFill.renderOrder = 8;
    this.hpFill.position.y = BAR_H / 2 + 0.5;
    this.shFill.position.y = -BAR_H / 2 - 0.5;
    this.hud.add(barBg, this.hpFill, this.shFill);

    this.label = this.buildLabel(snap, myFaction);
    this.hud.add(this.label);
    this.hud.visible = snap.k !== 'b';
  }

  private labelColor(snap: EntSnap, myFaction: string | null): string {
    if (snap.k === 'n') return '#ff4b4b';
    if (this.isMe) return '#ffffff';
    if (snap.f && myFaction && snap.f !== myFaction) return FACTION_COLORS[snap.f] ?? '#ff8080';
    return '#ffffff';
  }

  private buildLabel(snap: EntSnap, myFaction: string | null): THREE.Mesh {
    const color = this.labelColor(snap, myFaction);
    this.labelKey = `${snap.n}|${color}`;
    if (LITE) return new THREE.Mesh();
    const l = makeLabel(snap.n ?? '', color, 12, 8);
    l.position.y = -BAR_H * 2 - 12;
    return l;
  }

  private makeSprite(snap: EntSnap): SheetSprite {
    const sheet = this.assets.sheet(snap.s);
    const color = snap.k === 'n' ? 0xff4040 : this.isMe ? 0xffe04a : new THREE.Color(FACTION_COLORS[snap.f ?? ''] ?? '#9fd0ff');
    const tri = makeTriangle(56, color);
    tri.renderOrder = 5;
    this.placeholderTri = tri;
    const sp = LITE ? new SheetSprite(this.assets, null, null, 5) : new SheetSprite(this.assets, sheet, tri, 5);
    if (sheet) {
      this.radius = Math.max(28, Math.min(sheet.cw, sheet.ch) * 0.33);
      this.halfH = Math.max(30, sheet.ch * 0.36);
    } else {
      this.radius = 36;
      this.halfH = 36;
    }
    return sp;
  }

  setSnap(snap: EntSnap, t: number, myFaction: string | null): void {
    if (snap.s !== this.sheetKey) {
      this.group.remove(this.sprite.group);
      this.sprite.dispose();
      this.sheetKey = snap.s;
      this.sprite = this.makeSprite(snap);
      this.group.add(this.sprite.group);
    }
    const color = this.labelColor(snap, myFaction);
    if (`${snap.n}|${color}` !== this.labelKey) {
      this.hud.remove(this.label);
      disposeTree(this.label);
      this.label = this.buildLabel(snap, myFaction);
      this.hud.add(this.label);
    }
    this.snap = snap;
    const h = this.history;
    // teleport (jump/respawn) -> reset history
    const last = h[h.length - 1];
    if (last && Math.hypot(last.x - snap.x, last.y - snap.y) > 1500) h.length = 0;
    if (last && t <= last.t) h.length = 0;
    h.push({ t, x: snap.x, y: snap.y, a: snap.a });
    if (h.length > 30) h.splice(0, h.length - 30);
  }

  update(rt: number, zoom: number, frames: (a: number, n: number) => number, now: number): void {
    const h = this.history;
    if (h.length === 0) return;
    let s: { x: number; y: number; a: number };
    if (rt <= h[0].t) s = h[0];
    else if (rt >= h[h.length - 1].t) s = h[h.length - 1];
    else {
      let i = h.length - 2;
      while (i > 0 && h[i].t > rt) i--;
      const p = h[i];
      const q = h[i + 1];
      const k = (rt - p.t) / Math.max(1, q.t - p.t);
      s = { x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k, a: lerpAngle(p.a, q.a, k) };
    }
    this.x = s.x;
    this.y = s.y;
    this.a = s.a;
    this.group.position.set(s.x, toThreeY(s.y), 0);

    const sheet = this.sprite.sheet;
    if (sheet && this.sprite.loaded) this.sprite.setFrame(frames(s.a, sheet.frames));
    else if (this.placeholderTri) this.placeholderTri.rotation.z = -s.a;

    // HUD under the ship, constant on-screen size
    const inv = 1 / zoom;
    this.hud.scale.setScalar(inv);
    this.hud.position.y = -this.halfH - 8 * inv;

    const hpk = this.snap.mhp > 0 ? clamp01(this.snap.hp / this.snap.mhp) : 0;
    const shk = this.snap.msh > 0 ? clamp01(this.snap.sh / this.snap.msh) : 0;
    setBar(this.hpFill, hpk);
    setBar(this.shFill, shk);
    this.shFill.visible = this.snap.msh > 0;

    // god-mode / spawn flicker not needed; subtle hover bob for players
    void now;
  }

  dispose(): void {
    this.sprite.dispose();
    disposeTree(this.hud);
  }
}

function setBar(m: THREE.Mesh, k: number): void {
  const w = Math.max(0.001, BAR_W * k);
  m.scale.x = w;
  m.position.x = -BAR_W / 2 + w / 2;
  m.visible = k > 0;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerpAngle(a: number, b: number, k: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

/**
 * Keeps one view per entity of the current map snapshot; interpolates positions ~100 ms behind
 * the newest snapshot using the server tick as the time base.
 */
export class EntityManager {
  readonly views = new Map<string, EntityView>();
  myId: string | null = null;
  myFaction: string | null = null;
  selectedId: string | null = null;
  attacking = false;
  latestTick = 0;

  private clockOffset: number | null = null; // localMs - serverMs
  readonly delay = 100;
  private ring: THREE.Mesh;
  private ringInner: THREE.Mesh;

  constructor(private readonly assets: Assets, private readonly layer: THREE.Group) {
    this.ring = makeRing(1, 1.06, 0xff3b3b, 0.95);
    this.ringInner = makeRing(1.1, 1.13, 0xff3b3b, 0.4);
    this.ring.renderOrder = 4;
    this.ringInner.renderOrder = 4;
    this.ring.visible = false;
    this.ringInner.visible = false;
    layer.add(this.ring, this.ringInner);
  }

  static key(id: EntId | null | undefined): string | null {
    return id === null || id === undefined ? null : String(id);
  }

  applyState(tick: number, ents: EntSnap[], now: number): void {
    const serverMs = tick * 50;
    const est = now - serverMs;
    if (this.clockOffset === null || est < this.clockOffset || Math.abs(est - this.clockOffset) > 2000) this.clockOffset = est;
    else this.clockOffset += (est - this.clockOffset) * 0.02; // slow drift towards later arrivals
    this.latestTick = tick;

    const seen = new Set<string>();
    for (const e of ents) {
      const k = String(e.id);
      seen.add(k);
      let v = this.views.get(k);
      if (!v) {
        v = new EntityView(this.assets, e, k === this.myId, this.myFaction);
        this.views.set(k, v);
        this.layer.add(v.group);
      }
      v.setSnap(e, serverMs, this.myFaction);
      v.lastSeen = now;
    }
    for (const [k, v] of this.views) {
      if (!seen.has(k)) this.remove(k, v);
    }
  }

  remove(k: string, v = this.views.get(k)): void {
    if (!v) return;
    this.layer.remove(v.group);
    v.dispose();
    this.views.delete(k);
    if (this.selectedId === k) this.selectedId = null;
  }

  clear(): void {
    for (const [k, v] of this.views) this.remove(k, v);
    this.clockOffset = null;
  }

  renderTime(now: number): number {
    if (this.clockOffset === null) return 0;
    return now - this.clockOffset - this.delay;
  }

  update(now: number, zoom: number): void {
    const rt = this.renderTime(now);
    const frames = (a: number, n: number) => this.assets.frameFor(a, n);
    for (const v of this.views.values()) v.update(rt, zoom, frames, now);

    const sel = this.selectedId ? this.views.get(this.selectedId) : undefined;
    if (sel) {
      const r = sel.radius * 1.15;
      const pulse = 1 + Math.sin(now / 180) * 0.03;
      const color = this.attacking ? 0xff3b3b : 0xffcf4a;
      for (const m of [this.ring, this.ringInner]) {
        m.visible = true;
        m.position.set(sel.x, toThreeY(sel.y), 0);
        m.scale.setScalar(r * pulse);
        (m.material as THREE.MeshBasicMaterial).color.setHex(color);
      }
      this.ringInner.rotation.z = now / 900;
    } else {
      this.ring.visible = false;
      this.ringInner.visible = false;
    }
  }

  get(id: EntId | null | undefined): EntityView | undefined {
    const k = EntityManager.key(id);
    return k ? this.views.get(k) : undefined;
  }

  me(): EntityView | undefined {
    return this.myId ? this.views.get(this.myId) : undefined;
  }

  /** Entity under a world point (closest within its radius), excluding self. */
  pick(x: number, y: number, zoom: number, slackPx = 12): EntityView | null {
    let best: EntityView | null = null;
    let bestD = Infinity;
    const slack = slackPx / zoom;
    for (const [k, v] of this.views) {
      if (k === this.myId || v.snap.k === 'b') continue; // boxes: clicking flies there (collect by flying over)
      const d = Math.hypot(v.x - x, v.y - y);
      if (d < v.radius + slack && d < bestD) {
        best = v;
        bestD = d;
      }
    }
    return best;
  }
}
