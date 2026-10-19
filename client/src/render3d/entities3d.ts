import * as THREE from 'three';
import { Assets } from '../assets';
import type { EntityManager, EntityView } from '../entities';
import { lerpAngle } from '../entities';
import type { SheetInfo } from '../types';
import { FACTION_COLORS } from '../types';
import type { ModelDef } from './manifest3d';
import { Manifest3DLoader } from './manifest3d';
import { ModelLibrary, VISUAL_SIZE_UNIT, instantiate, type ModelTemplate } from './models';
import { Overlay, OverlayItem } from './overlay';
import { SheetBillboard, glowTexture } from './sprites3d';
import { Ribbon, trailMaterial } from './trail';

const ENGINE_COLOR = '#78c8ff';
/** fx.engineTrail gradient head colour (0, 1, 0.969) */
const TRAIL_COLOR = '#00fff7';
const DRONE_LEN = 46;
const MAX_TRAIL_DIST = 2600;

const placeholderGeo = new THREE.ConeGeometry(18, 60, 4).rotateZ(-Math.PI / 2);
const engineGlowMat = new THREE.SpriteMaterial({ map: glowTexture(), color: new THREE.Color(ENGINE_COLOR).multiplyScalar(1.5), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });

type Visual = { kind: 'model'; obj: THREE.Object3D; t: ModelTemplate } | { kind: 'sheet'; bb: SheetBillboard } | { kind: 'placeholder'; obj: THREE.Mesh };

interface Drone3D {
  type: string;
  root: THREE.Group;
  visual: Visual | null;
  pos: THREE.Vector3;
  key: string;
  len: number;
  init: boolean;
}

/** A 3D entity (ship / NPC) mirroring an EntityView. */
export class Ent3D {
  readonly root = new THREE.Group();
  readonly yaw = new THREE.Group();
  readonly bank = new THREE.Group();
  visual: Visual | null = null;
  pending: Visual | null = null;
  visualKey = '';
  heading = 0;
  angVel = 0;
  bankAngle = 0;
  speed = 0;
  lastX = NaN;
  lastY = NaN;
  len = 110;
  radius = 45;
  height = 30;
  laserIdx = 0;
  culled = false;
  disposed = false;
  overlay = new OverlayItem();
  trails: Ribbon[] = [];
  glows: THREE.Sprite[] = [];
  engines: THREE.Vector3[] = [];
  drones: Drone3D[] = [];
  droneKey = '';
  /** active drone formation id (snapshot `fm`), see formations.json */
  formation = 'standard';
  bobPhase = Math.random() * 10;

  constructor(readonly id: string) {
    this.root.add(this.yaw);
    this.yaw.add(this.bank);
  }

  /** world-space muzzle points (model laserpoint_* nodes or two nose offsets) */
  laserOrigins(): THREE.Vector3[] {
    const v = this.visual;
    if (v?.kind === 'model' && v.t.laserPoints.length) return v.t.laserPoints.map((p) => this.bank.localToWorld(p.clone()));
    return [-1, 1].map((s) => this.bank.localToWorld(new THREE.Vector3(this.len * 0.25, 0, s * this.len * 0.16)));
  }

  /** current world position of drone i */
  dronePositions(): THREE.Vector3[] {
    return this.drones.map((d) => d.pos.clone());
  }

  center(out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(this.root.position);
  }
}

const STANDARD_POS: [number, number][] = [
  [150, 0], [225, 0], [187.5, 37.5], [187.5, -37.5], [-37.5, -150], [37.5, -150], [0, -112.5], [0, -187.5],
  [-37.5, 150], [37.5, 150], [0, 187.5], [0, 112.5],
];
const STANDARD_USED: Record<number, number[]> = {
  1: [1], 2: [3, 4], 3: [1, 3, 4], 4: [1, 2, 3, 4], 5: [2, 3, 4, 5, 9], 6: [1, 2, 3, 4, 5, 9], 7: [2, 3, 4, 5, 6, 9, 10],
  8: [1, 2, 3, 4, 5, 6, 9, 10], 9: [2, 3, 4, 5, 6, 8, 9, 10, 11], 10: [1, 2, 3, 4, 5, 6, 8, 9, 10, 11],
  11: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 12: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
};
const FORMATION_SCALE = 0.75;

/** Drone formation layouts from the client's game.txt (tools/formations_build.py). */
interface FormationDef { pos: [number, number, number][]; scale: number; used: Record<string, number[]>; rot: { ids: number[]; degPerSec: number }[] }
let FORMATIONS: Record<string, FormationDef> = {};
void fetch('/assets3d/formations.json')
  .then((r) => (r.ok ? r.json() : {}))
  .then((f: Record<string, FormationDef>) => { FORMATIONS = f; })
  .catch(() => undefined);

/** Formation-space position (+x behind, y lateral, z up) of drone i of n; null = fall back to standard. */
function formationPos(id: string, i: number, n: number, now: number): [number, number, number] | null {
  const f = FORMATIONS[id];
  if (!f?.pos.length) return null;
  const used = f.used[String(n)] ?? f.pos.map((_, k) => k + 1);
  const pid = used[i] ?? i + 1;
  const p = f.pos[pid - 1];
  if (!p) return null;
  let [x, y, z] = p;
  // rotation groups spin drones around the ship's axis (e.g. Drill)
  const g = f.rot.find((r) => r.ids.includes(pid));
  if (g) {
    const a = ((g.degPerSec * now) / 1000) * (Math.PI / 180);
    const c = Math.cos(a), sn = Math.sin(a);
    [y, z] = [y * c - z * sn, y * sn + z * c];
  }
  const k = f.scale || 1;
  return [x * k, y * k, z * k];
}

function droneSheetCandidates(t: string): string[] {
  const base = t.replace(/^drone[_-]/, '');
  return [t, `drone_${base}_0`, `drone_${base}`, `drone-${base}`, `drone_${base}_design_${base}_0`];
}

/** Keeps a 3D view per EntityView: models (or 2D sheet billboards), banking, engine trails, drones, labels. */
export class Entities3D {
  readonly root = new THREE.Group();
  readonly trailRoot = new THREE.Group();
  readonly map = new Map<string, Ent3D>();
  private ring: THREE.Mesh;
  private ring2: THREE.Mesh;
  private trailMat = trailMaterial(TRAIL_COLOR, 1.1);
  private tmp = new THREE.Vector3();
  private lastVersion = -1;
  ents: EntityManager | null = null;

  constructor(
    scene: THREE.Scene,
    private readonly overlay: Overlay,
    private readonly assets: Assets,
    private readonly lib: ModelLibrary,
    private readonly man: Manifest3DLoader,
  ) {
    scene.add(this.root, this.trailRoot);
    const { a, b } = makeSelectionRings();
    this.ring = a;
    this.ring2 = b;
    this.root.add(a, b);
  }

  get(id: string | number | null | undefined): Ent3D | undefined {
    return id === null || id === undefined ? undefined : this.map.get(String(id));
  }

  // ---------------- visuals ----------------
  private modelTargetLen(def: ModelDef, sheet: SheetInfo | null, fallback: number): number | null {
    if (def.size) return def.size;
    if (def.bounds) return null; // already in world units
    if (def.visualSize) return def.visualSize * VISUAL_SIZE_UNIT;
    if (sheet) return Math.min(sheet.cw, sheet.ch) * 0.55;
    return fallback;
  }

  /** resolve model → billboard → placeholder; models load async and replace the billboard when ready */
  private resolveVisual(
    sheetKey: string,
    fallbackLen: number,
    color: THREE.ColorRepresentation,
    onReady: (v: Visual) => void,
    isAlive: () => boolean,
  ): Visual {
    const sheet = this.assets.sheet(sheetKey);
    const def = this.man.model(sheetKey);
    if (def) {
      const len = this.modelTargetLen(def, sheet, fallbackLen);
      const key = `m:${JSON.stringify(def)}|${len}|${this.man.data.forward ?? '+x'}`;
      const now = this.lib.templateNow(key);
      if (now) return { kind: 'model', obj: instantiate(now), t: now };
      void this.lib.template(key, def, len, this.man.data.forward ?? '+x').then((t) => {
        if (t && isAlive()) onReady({ kind: 'model', obj: instantiate(t), t });
      });
    }
    if (sheet) return { kind: 'sheet', bb: new SheetBillboard(this.assets, sheet, 1, { renderOrder: 5 }) };
    const m = new THREE.Mesh(placeholderGeo, new THREE.MeshPhongMaterial({ color, emissive: color, emissiveIntensity: 0.3 }));
    m.scale.setScalar(fallbackLen / 60);
    return { kind: 'placeholder', obj: m };
  }

  private disposeVisual(v: Visual | null): void {
    if (!v) return;
    if (v.kind === 'sheet') v.bb.dispose();
    else if (v.kind === 'placeholder') { v.obj.removeFromParent(); (v.obj.material as THREE.Material).dispose(); }
    else v.obj.removeFromParent();
  }

  private attachVisual(e: Ent3D, v: Visual): void {
    this.disposeVisual(e.visual);
    e.visual = v;
    if (v.kind === 'sheet') e.root.add(v.bb.group);
    else e.bank.add(v.obj);
    if (v.kind === 'model') {
      e.len = v.t.length;
      e.radius = Math.max(28, v.t.radius * 0.85);
      e.height = v.t.height;
      e.engines = v.t.engines.length ? v.t.engines.slice(0, 3) : [new THREE.Vector3(-v.t.length * 0.47, 0, 0)];
    } else if (v.kind === 'sheet') {
      const s = v.bb.sheet;
      e.len = Math.min(s.cw, s.ch) * 0.55;
      e.radius = Math.max(28, Math.min(s.cw, s.ch) * 0.33);
      e.height = 20;
      e.engines = [];
    } else {
      e.engines = [new THREE.Vector3(-e.len * 0.45, 0, 0)];
    }
    this.rebuildEngines(e);
  }

  private rebuildEngines(e: Ent3D): void {
    for (const t of e.trails) t.dispose();
    for (const g of e.glows) g.removeFromParent();
    e.trails = [];
    e.glows = [];
    for (const p of e.engines) {
      const et = this.man.data.fx.engineTrail as { width?: number; time?: number } | undefined;
      const r = new Ribbon(this.trailMat, 26, Math.max(4.5, (et?.width ?? 3) * 1.5), (et?.time ?? 0.5) * 1000, 4);
      this.trailRoot.add(r.mesh);
      e.trails.push(r);
      const g = new THREE.Sprite(engineGlowMat);
      g.position.copy(p);
      g.renderOrder = 7;
      e.bank.add(g);
      e.glows.push(g);
    }
  }

  private ensure(v: EntityView, isMe: boolean): Ent3D {
    const k = String(v.snap.id);
    let e = this.map.get(k);
    if (!e) {
      e = new Ent3D(k);
      e.heading = v.a;
      this.map.set(k, e);
      this.root.add(e.root);
      this.overlay.items.add(e.overlay.group);
    }
    const key = `${v.snap.s}#${this.man.version}`;
    if (e.visualKey !== key) {
      e.visualKey = key;
      const ent = e;
      const color = v.snap.k === 'n' ? 0xff4040 : isMe ? 0xffe04a : new THREE.Color(FACTION_COLORS[v.snap.f ?? ''] ?? '#9fd0ff');
      const vis = this.resolveVisual(v.snap.s, v.snap.k === 'b' ? 55 : 110, color, (nv) => {
        if (ent.visualKey === key) this.attachVisual(ent, nv);
        else this.disposeVisual(nv);
      }, () => !ent.disposed && ent.visualKey === key);
      this.attachVisual(e, vis);
    }
    return e;
  }

  private remove(k: string, e: Ent3D): void {
    e.disposed = true;
    this.disposeVisual(e.visual);
    for (const t of e.trails) t.dispose();
    for (const d of e.drones) this.disposeVisual(d.visual);
    e.root.removeFromParent();
    e.overlay.dispose();
    this.map.delete(k);
  }

  clear(): void {
    for (const [k, e] of this.map) this.remove(k, e);
  }

  // ---------------- drones ----------------
  private syncDrones(e: Ent3D, types: string[]): void {
    const key = types.join(',') + '#' + this.man.version;
    if (key === e.droneKey) return;
    e.droneKey = key;
    for (const d of e.drones) { this.disposeVisual(d.visual); d.root.removeFromParent(); }
    e.drones = [];
    for (const t of types) {
      const root = new THREE.Group();
      const d: Drone3D = { type: t, root, visual: null, pos: new THREE.Vector3(), key, len: DRONE_LEN, init: false };
      const cands = droneSheetCandidates(t);
      const sheetKey = cands.find((c) => this.man.model(c)) ?? cands.find((c) => this.assets.sheet(c)) ?? cands[1];
      const attach = (v: Visual) => {
        this.disposeVisual(d.visual);
        d.visual = v;
        if (v.kind === 'sheet') root.add(v.bb.group);
        else root.add(v.obj);
      };
      attach(this.resolveVisual(sheetKey, DRONE_LEN, 0x9fb4c8, (nv) => {
        if (e.droneKey === key && !e.disposed) attach(nv);
        else this.disposeVisual(nv);
      }, () => e.droneKey === key && !e.disposed));
      this.root.add(root);
      e.drones.push(d);
    }
  }

  /** DO "standard" drone formation (game.txt <formation id="0">): back group + right + left groups */
  private updateDrones(e: Ent3D, dt: number, now: number, camera: THREE.Camera): void {
    const n = e.drones.length;
    if (!n) return;
    const ids = STANDARD_USED[Math.min(n, 12)] ?? [];
    const fid = e.formation;
    const k = 1 - Math.exp(-dt * 7);
    const c = Math.cos(-e.heading);
    const s = Math.sin(-e.heading);
    for (let i = 0; i < n; i++) {
      const d = e.drones[i];
      // DO formation space: +x = behind the ship, -y = right; ours: +x = nose, +z = right
      const fp = formationPos(fid, i, n, now) ?? [...(STANDARD_POS[(ids[i] ?? i + 1) - 1] ?? [150 + 40 * (i - 11), 0]), 0];
      const lx = -fp[0] * FORMATION_SCALE;
      const lz = -fp[1] * FORMATION_SCALE;
      const up = fp[2] * FORMATION_SCALE;
      // rotate local (lx, lz) by yaw (rotation.y = -heading)
      const wx = e.root.position.x + lx * c + lz * s;
      const wz = e.root.position.z - lx * s + lz * c;
      const wy = 6 + up + Math.sin(now / 600 + i * 1.3) * 3;
      if (!d.init) { d.pos.set(wx, wy, wz); d.init = true; }
      else d.pos.set(d.pos.x + (wx - d.pos.x) * k, wy, d.pos.z + (wz - d.pos.z) * k);
      d.root.position.copy(d.pos);
      d.root.visible = !e.culled;
      const v = d.visual;
      if (v?.kind === 'sheet') {
        v.bb.group.quaternion.copy(camera.quaternion);
        v.bb.setFrame(this.assets.frameFor(e.heading, v.bb.sheet.frames));
      } else d.root.rotation.y = -e.heading;
    }
  }

  // ---------------- per frame ----------------
  sync(ents: EntityManager, dt: number, now: number, camera: THREE.PerspectiveCamera, target: THREE.Vector3, viewRadius: number, project: (p: THREE.Vector3) => { x: number; y: number; z: number }): void {
    this.ents = ents;
    if (this.man.version !== this.lastVersion) this.lastVersion = this.man.version;
    for (const [k, e] of this.map) if (!ents.views.has(k)) this.remove(k, e);
    const camPos = camera.position;
    for (const [k, v] of ents.views) {
      const isMe = k === ents.myId;
      const e = this.ensure(v, isMe);
      // position & heading
      e.root.position.set(v.x, 0, v.y);
      const dx = Math.hypot(v.x - target.x, v.y - target.z);
      e.culled = !isMe && k !== ents.selectedId && dx > viewRadius;
      e.root.visible = !e.culled;
      if (Number.isFinite(e.lastX) && dt > 0) {
        const sp = Math.hypot(v.x - e.lastX, v.y - e.lastY) / dt;
        e.speed += (Math.min(sp, 2000) - e.speed) * (1 - Math.exp(-dt * 6));
      }
      e.lastX = v.x;
      e.lastY = v.y;
      const prev = e.heading;
      e.heading = lerpAngle(e.heading, v.a, 1 - Math.exp(-dt * 10));
      let dh = e.heading - prev;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      const av = dt > 0 ? dh / dt : 0;
      e.angVel += (av - e.angVel) * (1 - Math.exp(-dt * 8));
      // turning right on screen (angle increasing, +y down) rolls the right wing (+z local) down
      const wantBank = THREE.MathUtils.clamp(e.angVel * 0.28, -0.55, 0.55);
      e.bankAngle += (wantBank - e.bankAngle) * (1 - Math.exp(-dt * 6));
      v.radius = e.radius;
      if (e.culled) {
        e.overlay.group.visible = false;
        for (const t of e.trails) t.reset();
        continue;
      }
      e.yaw.rotation.y = -e.heading;
      e.bank.rotation.x = e.bankAngle;
      e.bank.position.y = Math.sin(now / 900 + e.bobPhase) * 2.5;
      const vis = e.visual;
      if (vis?.kind === 'sheet') {
        vis.bb.group.quaternion.copy(camera.quaternion);
        vis.bb.setFrame(this.assets.frameFor(e.heading, vis.bb.sheet.frames));
      }
      // engines
      const spk = THREE.MathUtils.clamp(e.speed / 300, 0, 1.3);
      const near = dx < MAX_TRAIL_DIST;
      if (e.trails.length) {
        e.bank.updateMatrixWorld(true);
        for (let i = 0; i < e.trails.length; i++) {
          const g = e.glows[i];
          const gs = e.len * (0.07 + 0.07 * spk) * (0.9 + 0.1 * Math.sin(now / 40 + i));
          g.scale.set(gs, gs, 1);
          g.visible = spk > 0.05 || e.speed > 5;
          if (near) e.trails[i].update(e.bank.localToWorld(this.tmp.copy(e.engines[i])), now, camPos, 0.4 + 0.6 * Math.min(1, spk));
          else e.trails[i].reset();
        }
      }
      // drones
      const dr = (v.snap as { dr?: unknown }).dr;
      const fm = (v.snap as { fm?: unknown }).fm;
      e.formation = typeof fm === 'string' ? fm : 'standard';
      this.syncDrones(e, Array.isArray(dr) ? dr.map(String) : []);
      this.updateDrones(e, dt, now, camera);
      // overlay label + bars below the ship (loot boxes have none)
      if (v.snap.k === 'b') { e.overlay.group.visible = false; continue; }
      const s = project(e.root.position);
      if (s.z > 1) { e.overlay.group.visible = false; continue; }
      const edge = project(this.tmp.set(v.x, 0, v.y + e.radius));
      const color = v.snap.k === 'n' ? '#ff4b4b' : isMe ? '#ffffff'
        : v.snap.f && ents.myFaction && v.snap.f !== ents.myFaction ? FACTION_COLORS[v.snap.f] ?? '#ff8080' : '#ffffff';
      e.overlay.setLabel(v.snap.n ?? '', color);
      const hpk = v.snap.mhp > 0 ? clamp01(v.snap.hp / v.snap.mhp) : 0;
      const shk = v.snap.msh > 0 ? clamp01(v.snap.sh / v.snap.msh) : 0;
      e.overlay.set(s.x, Math.max(edge.y, s.y + 24) + 10, hpk, shk, v.snap.msh > 0);
    }
    this.updateRing(ents, now);
  }

  private updateRing(ents: EntityManager, now: number): void {
    const sel = ents.selectedId ? this.map.get(ents.selectedId) : undefined;
    if (!sel || sel.culled) {
      this.ring.visible = this.ring2.visible = false;
      return;
    }
    const r = Math.max(42, sel.radius * 1.3);
    const atk = ents.attacking;
    const col = atk ? 0xff2a2a : 0xffffff;
    for (const m of [this.ring, this.ring2]) {
      m.visible = true;
      m.position.set(sel.root.position.x, -4, sel.root.position.z);
      (m.material as THREE.MeshBasicMaterial).color.setHex(col);
    }
    const pulse = 1 + Math.sin(now / 160) * (atk ? 0.035 : 0.015);
    this.ring.scale.set(r * 2 * pulse, r * 2 * pulse, 1);
    this.ring2.scale.set(r * 2.3, r * 2.3, 1);
    this.ring2.rotation.z = now / 1200;
    this.ring.rotation.z = -now / 3000;
  }

  /** raycast against entity bounding spheres (excluding self) */
  pick(ray: THREE.Ray, myId: string | null): string | null {
    let best: string | null = null;
    let bestD = Infinity;
    const sph = new THREE.Sphere();
    const hit = new THREE.Vector3();
    for (const [k, e] of this.map) {
      if (k === myId || e.culled) continue;
      sph.center.copy(e.root.position);
      sph.radius = e.radius * 1.05;
      if (ray.intersectSphere(sph, hit)) {
        const d = ray.distanceSqToPoint(e.root.position);
        if (d < bestD) { bestD = d; best = k; }
      }
    }
    return best;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** DO-style lock-on circle lying on the plane: thin circle + 4 bracket arcs */
function makeSelectionRings(): { a: THREE.Mesh; b: THREE.Mesh } {
  const mk = (draw: (g: CanvasRenderingContext2D) => void) => {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d')!;
    g.strokeStyle = '#ffffff';
    g.shadowColor = 'rgba(255,255,255,0.8)';
    g.shadowBlur = 6;
    draw(g);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, opacity: 0.95 }));
    m.rotation.x = -Math.PI / 2;
    m.renderOrder = 3;
    m.visible = false;
    return m;
  };
  const a = mk((g) => {
    g.lineWidth = 3;
    g.beginPath();
    g.arc(128, 128, 116, 0, Math.PI * 2);
    g.stroke();
    g.lineWidth = 7;
    for (let i = 0; i < 4; i++) {
      g.beginPath();
      const a0 = i * (Math.PI / 2) - 0.32;
      g.arc(128, 128, 116, a0, a0 + 0.64);
      g.stroke();
    }
  });
  const b = mk((g) => {
    g.lineWidth = 2;
    g.globalAlpha = 0.55;
    for (let i = 0; i < 24; i++) {
      g.beginPath();
      const a0 = (i / 24) * Math.PI * 2;
      g.arc(128, 128, 118, a0, a0 + 0.12);
      g.stroke();
    }
  });
  return { a, b };
}
