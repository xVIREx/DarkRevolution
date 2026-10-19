// Company objective (server world/objectives.rs): beacons on the neutral 4-x maps. The bar under
// the round timer shows company points and every beacon (owner colour + capture progress); on the
// beacon's map a ring marks the capture zone and a light pillar its owner.
import * as THREE from 'three';
import type { World } from '../world';
import type { BeaconState, ObjMsg } from '../types';
import { toThreeY } from '../sprites';
import { el, esc } from './dom';
import { fcol as col, fname } from './season';

export class ObjectiveBar {
  private root: HTMLDivElement;
  private scores: HTMLDivElement;
  private beacons: HTMLDivElement;
  private sig = '';
  private goal: HTMLDivElement;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'obj-bar empty', undefined, parent);
    this.root.title = 'Company goal: capture and hold the beacons on the 4-x maps. Most beacon points when the round ends wins.';
    this.goal = el('div', 'obj-goal', '', this.root);
    this.scores = el('div', 'obj-scores', '', this.root);
    this.beacons = el('div', 'obj-beacons', '', this.root);
  }

  update(m: ObjMsg, myFaction: string): void {
    const sig = JSON.stringify([m, myFaction]);
    if (sig === this.sig) return;
    this.sig = sig;
    const has = m.beacons.length > 0;
    this.root.classList.toggle('empty', !has);
    document.documentElement.classList.toggle('objectives', has);
    if (!has) return;
    // bars fill towards the winning score (first there wins the round), else relative to the leader
    const target = m.target ?? 0;
    const total = target > 0 ? target : Math.max(1, ...['mmo', 'eic', 'vru'].map((f) => m.score[f] ?? 0));
    this.goal.textContent = target > 0 ? `First company to ${target.toLocaleString('en-US')} beacon points wins` : '';
    this.root.title = target > 0
      ? `Company goal: capture and hold the beacons on the 4-x maps. The first company to ${target.toLocaleString('en-US')} points wins the round on the spot; otherwise the most points when time runs out.`
      : 'Company goal: capture and hold the beacons on the 4-x maps. Most beacon points when the round ends wins.';
    this.scores.innerHTML = ['mmo', 'eic', 'vru']
      .map((f) => {
        const v = Math.floor(m.score[f] ?? 0);
        return `<div class="obj-sc${f === myFaction ? ' me' : ''}" style="--fc:${col(f)}"><b>${fname(f)}</b><i style="width:${Math.min(100, (v / total) * 100)}%"></i><span>${v}</span></div>`;
      })
      .join('');
    this.beacons.innerHTML = m.beacons
      .map((b) => {
        const fill = Math.round(b.cap * 100);
        const title = `${b.name}${b.weight > 1 ? ' (double points)' : ''}: ${b.owner ? `held by ${fname(b.owner)}` : 'neutral'}${b.contested ? ' - contested!' : b.side && b.side !== b.owner ? ` - ${fname(b.side)} capturing ${fill}%` : ''}`;
        return `<div class="obj-b${b.contested ? ' contested' : ''}" title="${esc(title)}" style="--oc:${col(b.owner)};--sc:${col(b.side)};--p:${fill}%">${esc(b.name)}${b.weight > 1 ? '<sup>x2</sup>' : ''}</div>`;
      })
      .join('');
  }
}

/** Ring + pillar for the beacon on the current map (2D and 3D renderers). */
export class BeaconsView {
  private group = new THREE.Group();
  private ring: THREE.Mesh;
  private progress: THREE.Mesh;
  private core: THREE.Mesh;
  private pillar: THREE.Mesh | null = null;
  private lastCap = -1;
  private lastSide: string | null = null;
  private lastKey = '';
  private is3d: boolean;

  constructor(world: World) {
    this.is3d = !!world.r3d;
    const parent = world.r3d ? world.r3d.scene : world.entityLayer;
    parent.add(this.group);
    const add = THREE.AdditiveBlending;
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.97, 1, 96), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.55, blending: add, depthWrite: false, side: THREE.DoubleSide }));
    this.progress = new THREE.Mesh(new THREE.RingGeometry(0.9, 0.96, 96, 1, 0, 0.01), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.8, blending: add, depthWrite: false, side: THREE.DoubleSide }));
    this.core = new THREE.Mesh(new THREE.CircleGeometry(0.12, 48), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.35, blending: add, depthWrite: false, side: THREE.DoubleSide }));
    this.group.add(this.ring, this.progress, this.core);
    if (this.is3d) {
      // flat on the play plane (three XZ), pillar standing up
      for (const m of [this.ring, this.progress, this.core]) m.rotation.x = -Math.PI / 2;
      this.pillar = new THREE.Mesh(new THREE.CylinderGeometry(18, 40, 900, 24, 1, true), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.22, blending: add, depthWrite: false, side: THREE.DoubleSide }));
      this.pillar.position.y = 450;
      this.group.add(this.pillar);
    }
    this.group.visible = false;
    this.group.renderOrder = 2;
  }

  update(m: ObjMsg | null, mapId: number | null): void {
    const b: BeaconState | undefined = m?.beacons.find((x) => x.map === mapId);
    this.group.visible = !!b;
    if (!b) return;
    // placement and owner colour only change on server updates (~1/s), not every frame
    const key = `${b.map}|${b.x}|${b.y}|${b.r}|${b.owner}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      if (this.is3d) this.group.position.set(b.x, 3, b.y);
      else this.group.position.set(b.x, toThreeY(b.y), -2);
      for (const o of [this.ring, this.progress, this.core]) o.scale.setScalar(b.r);
      const owner = new THREE.Color(col(b.owner)).multiplyScalar(b.owner ? 2.2 : 1.2);
      (this.ring.material as THREE.MeshBasicMaterial).color.copy(owner);
      (this.core.material as THREE.MeshBasicMaterial).color.copy(owner);
      if (this.pillar) (this.pillar.material as THREE.MeshBasicMaterial).color.copy(owner);
    }
    if (b.cap !== this.lastCap || b.side !== this.lastSide) {
      this.lastCap = b.cap;
      this.lastSide = b.side ?? null;
      this.progress.geometry.dispose();
      this.progress.geometry = new THREE.RingGeometry(0.9, 0.96, 96, 1, Math.PI / 2, Math.max(0.01, b.cap * Math.PI * 2));
      (this.progress.material as THREE.MeshBasicMaterial).color.copy(new THREE.Color(col(b.side)).multiplyScalar(2.5));
    }
    if (b.contested || (this.ring.material as THREE.MeshBasicMaterial).opacity !== 0.55) {
      (this.ring.material as THREE.MeshBasicMaterial).opacity = b.contested ? 0.35 + 0.25 * Math.sin(performance.now() / 120) : 0.55;
    }
  }
}

/** Minimap marker for the beacon on the current map. */
export function drawBeacon(c: CanvasRenderingContext2D, b: BeaconState, sx: number, sy: number): void {
  const x = b.x * sx;
  const y = b.y * sy;
  c.strokeStyle = col(b.owner);
  c.lineWidth = 2;
  c.beginPath();
  c.arc(x, y, Math.max(6, b.r * sx), 0, Math.PI * 2);
  c.stroke();
  c.fillStyle = col(b.owner);
  c.beginPath();
  c.moveTo(x, y - 5); c.lineTo(x + 5, y); c.lineTo(x, y + 5); c.lineTo(x - 5, y); c.closePath();
  c.fill();
}
