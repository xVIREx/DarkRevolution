import * as THREE from 'three';
import { Assets } from './assets';
import type { MapDef } from './types';
import { FACTION_COLORS } from './types';
import { ImageSprite, SheetSprite, basicMat, disposeTree, makeCircle, makeLabel, makeRing, toThreeY } from './sprites';
import type { EntityManager } from './entities';
import { setEntityLite } from './entities';
import { Renderer3D } from './render3d/renderer3d';
import { registerRendererToggle, rendererMode } from './render3d/mode';
import { addSettingsToggle } from './hud/volume';

export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 2;

interface StarLayer { group: THREE.Group; f: number; geo: THREE.BufferGeometry; mat: THREE.PointsMaterial }
interface PlanetView { sprite: ImageSprite; ax: number; ay: number; p: number }
interface PortalView { sprite: SheetSprite; ring: THREE.Mesh; x: number; y: number; phase: number }

const STAR_TILE = 1024;

/**
 * Owns the renderer, cameras, the parallax background scene and the static map layer
 * (border, portals, stations). World coordinates are +y down; three.js uses y = -worldY.
 */
export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
  private readonly bgScene = new THREE.Scene();
  private readonly bgCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);

  /** Layers in the world scene */
  readonly staticLayer = new THREE.Group();
  readonly entityLayer = new THREE.Group();
  readonly effectLayer = new THREE.Group();

  // camera state in world coords
  camX = 0;
  camY = 0;
  zoom = 1;
  targetZoom = 1;
  width = 1;
  height = 1;

  map: MapDef | null = null;
  private bg: THREE.Mesh | null = null;
  private bgW = 2048;
  private bgH = 1276;
  private bgParallax = 10;
  private bgFallback: THREE.Mesh;
  private stars: StarLayer[] = [];
  private planets: PlanetView[] = [];
  private portals: PortalView[] = [];
  private mapObjects: THREE.Object3D[] = [];
  private mapGen = 0;
  /** modern 3D renderer (null = classic 2D sprites, `?r=2d`) */
  readonly r3d: Renderer3D | null = null;

  constructor(private readonly assets: Assets, container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x02040a, 1);
    this.renderer.autoClear = false;
    this.renderer.domElement.id = 'game-canvas';
    container.appendChild(this.renderer.domElement);
    registerRendererToggle(addSettingsToggle);
    if (rendererMode() === '3d') {
      try {
        this.r3d = new Renderer3D(this.renderer, assets);
        setEntityLite(true);
      } catch (e) {
        console.error('3D renderer failed, using 2D', e);
        this.r3d = null;
      }
    }

    this.camera.position.z = 100;
    this.bgCamera.position.z = 100;
    this.scene.add(this.staticLayer, this.entityLayer, this.effectLayer);

    // fallback background: subtle dark-blue vignette
    this.bgFallback = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), basicMat({ map: makeVignetteTexture() }));
    this.bgFallback.renderOrder = -10;
    this.bgScene.add(this.bgFallback);

    if (!this.r3d) this.buildStars();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h);
    this.bgCamera.left = -w / 2;
    this.bgCamera.right = w / 2;
    this.bgCamera.top = h / 2;
    this.bgCamera.bottom = -h / 2;
    this.bgCamera.updateProjectionMatrix();
    this.bgFallback.scale.set(w, h, 1);
    if (this.r3d) {
      this.r3d.resize(w, h);
      return;
    }
    this.rebuildStarTiles();
    this.updateCamera();
  }

  // ---------- coordinate helpers ----------
  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    if (this.r3d) return this.r3d.screenToWorld(sx, sy);
    return { x: this.camX + (sx - this.width / 2) / this.zoom, y: this.camY + (sy - this.height / 2) / this.zoom };
  }

  worldToScreen(x: number, y: number): { x: number; y: number } {
    if (this.r3d) return this.r3d.worldToScreen(x, y);
    return { x: (x - this.camX) * this.zoom + this.width / 2, y: (y - this.camY) * this.zoom + this.height / 2 };
  }

  zoomBy(factor: number): void {
    const cam = this.r3d?.man.data.camera;
    this.targetZoom = THREE.MathUtils.clamp(this.targetZoom * factor, cam?.minZoom ?? MIN_ZOOM, cam?.maxZoom ?? MAX_ZOOM);
  }

  /** Follow a world point smoothly. */
  follow(x: number, y: number, dt: number, snap = false): void {
    if (snap) {
      this.camX = x;
      this.camY = y;
    } else {
      const k = 1 - Math.exp(-dt * 8);
      this.camX += (x - this.camX) * k;
      this.camY += (y - this.camY) * k;
    }
  }

  private updateCamera(): void {
    const w = this.width / this.zoom;
    const h = this.height / this.zoom;
    this.camera.left = -w / 2;
    this.camera.right = w / 2;
    this.camera.top = h / 2;
    this.camera.bottom = -h / 2;
    this.camera.position.x = this.camX;
    this.camera.position.y = toThreeY(this.camY);
    this.camera.updateProjectionMatrix();
  }

  // ---------- map ----------
  /** 3D renderer reads entity views from the manager every frame */
  attachEntities(ents: EntityManager): void {
    this.r3d?.attach(ents);
  }

  /** 3D raycast pick (null in 2D or when nothing is under the cursor) */
  pickEntity(sx: number, sy: number): string | number | null {
    return this.r3d ? this.r3d.pickEntity(sx, sy) : null;
  }

  setMap(map: MapDef): void {
    this.map = map;
    if (this.r3d) {
      this.r3d.setMap(map);
      return;
    }
    const gen = ++this.mapGen;
    for (const o of this.mapObjects) {
      this.staticLayer.remove(o);
      this.bgScene.remove(o);
      disposeTree(o);
    }
    this.mapObjects = [];
    for (const p of this.planets) p.sprite.dispose();
    for (const p of this.portals) p.sprite.dispose();
    this.planets = [];
    this.portals = [];
    if (this.bg) {
      this.bgScene.remove(this.bg);
      this.bg.geometry.dispose();
      (this.bg.material as THREE.Material).dispose();
      this.bg = null;
    }

    // background image
    const bgRel = this.assets.manifest.backgrounds[String(map.background)];
    const layer = (map as MapDef & { backgrounds?: { typeID: string; pFactor?: string }[] }).backgrounds?.find((b) => String(b.typeID) === String(map.background));
    this.bgParallax = Math.max(1, Number(layer?.pFactor) || 10);
    if (bgRel) {
      void this.assets.texture(bgRel).then((tex) => {
        if (!tex || gen !== this.mapGen) return;
        const img = tex.image as { width: number; height: number };
        this.bgW = Math.max(1, img.width);
        this.bgH = Math.max(1, img.height);
        const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), basicMat({ map: tex }));
        m.renderOrder = -9;
        this.bg = m;
        this.bgScene.add(m);
      });
    }

    // planets (maps-config coords are in region space, usually 2048x1276)
    let rw = 2048 * (map.w / 21000);
    let rh = 1276 * (map.h / 13100);
    if (map.region) {
      const [a, b] = String(map.region).split(',').map(Number);
      if (a > 0 && b > 0) { rw = a; rh = b; }
    }
    for (const p of map.planets ?? []) {
      const rel = this.assets.manifest.planets[String(p.type)];
      const ph = makeCircle(70, 0x2a3550, 0.6);
      const sprite = new ImageSprite(this.assets, rel, ph, -5);
      this.bgScene.add(sprite.group);
      this.mapObjects.push(sprite.group);
      this.planets.push({ sprite, ax: (p.x / rw) * map.w, ay: (p.y / rh) * map.h, p: Math.max(1, p.p || 1) });
    }

    // border
    const pts = [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(map.w, 0, 0),
      new THREE.Vector3(map.w, -map.h, 0),
      new THREE.Vector3(0, -map.h, 0),
    ];
    const border = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0x5a7fa8, transparent: true, opacity: 0.55, depthTest: false }),
    );
    border.renderOrder = 1;
    this.addStatic(border);

    // stations
    for (const st of map.stations ?? []) {
      const rel = this.assets.manifest.stations[st.faction];
      const color = FACTION_COLORS[st.faction] ?? '#aaaaaa';
      const ph = new THREE.Group();
      ph.add(makeCircle(160, 0x111a28, 0.85), makeRing(150, 165, color, 0.8), makeRing(60, 72, color, 0.6));
      const sprite = new ImageSprite(this.assets, rel, ph, 2);
      sprite.group.position.set(st.x, toThreeY(st.y), 0);
      const label = makeLabel(`${st.faction.toUpperCase()} Station`, color, 13, 3);
      label.position.y = -190;
      sprite.group.add(label);
      sprite.onLoad = (s) => {
        label.position.y = -s.height / 2 - 12;
      };
      this.addStatic(sprite.group);
    }

    // portals
    for (const p of map.portals ?? []) {
      const sheet = this.assets.manifest.portal ?? null;
      const ph = new THREE.Group();
      ph.add(makeRing(70, 82, 0x8fd8ff, 0.8), makeRing(45, 50, 0xffffff, 0.5));
      const sprite = new SheetSprite(this.assets, sheet && sheet.url ? sheet : null, ph, 2);
      sprite.group.position.set(p.x, toThreeY(p.y), 0);
      const ring = makeRing(495, 500, 0x8fd8ff, 0.08); // jump range hint
      sprite.group.add(ring);
      this.addStatic(sprite.group);
      this.portals.push({ sprite, ring, x: p.x, y: p.y, phase: Math.random() * 10 });
    }
  }

  private addStatic(o: THREE.Object3D): void {
    this.staticLayer.add(o);
    this.mapObjects.push(o);
  }

  // ---------- starfield ----------
  private buildStars(): void {
    const defs = [
      { count: 260, size: 1.4, f: 0.05, opacity: 0.45 },
      { count: 140, size: 2.0, f: 0.12, opacity: 0.7 },
      { count: 45, size: 2.8, f: 0.25, opacity: 0.9 },
    ];
    const dot = makeDotTexture();
    for (const d of defs) {
      const pos = new Float32Array(d.count * 3);
      for (let i = 0; i < d.count; i++) {
        pos[i * 3] = Math.random() * STAR_TILE;
        pos[i * 3 + 1] = Math.random() * STAR_TILE;
        pos[i * 3 + 2] = 0;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const mat = new THREE.PointsMaterial({
        size: d.size * this.renderer.getPixelRatio(), sizeAttenuation: false, map: dot, transparent: true,
        opacity: d.opacity, depthWrite: false, depthTest: false, color: 0xcfe3ff,
      });
      const group = new THREE.Group();
      group.renderOrder = -8;
      this.bgScene.add(group);
      this.stars.push({ group, f: d.f, geo, mat });
    }
  }

  private rebuildStarTiles(): void {
    const nx = Math.ceil(this.width / STAR_TILE) + 2;
    const ny = Math.ceil(this.height / STAR_TILE) + 2;
    for (const s of this.stars) {
      s.group.clear();
      for (let i = 0; i < nx; i++) {
        for (let j = 0; j < ny; j++) {
          const pts = new THREE.Points(s.geo, s.mat);
          pts.position.set(i * STAR_TILE, j * STAR_TILE, 0);
          pts.renderOrder = -8;
          pts.frustumCulled = false;
          s.group.add(pts);
        }
      }
    }
  }

  // ---------- frame update ----------
  update(dt: number, now: number): void {
    // smooth zoom
    const zk = 1 - Math.exp(-dt * 12);
    this.zoom += (this.targetZoom - this.zoom) * zk;
    if (Math.abs(this.zoom - this.targetZoom) < 1e-4) this.zoom = this.targetZoom;
    if (this.r3d) {
      this.r3d.update(dt, now, this.camX, this.camY, this.zoom);
      return;
    }
    this.updateCamera();

    const W = this.width;
    const H = this.height;
    const mw = this.map?.w ?? 21000;
    const mh = this.map?.h ?? 13100;

    // background: cover the screen with margin and pan across it as the camera crosses the map
    if (this.bg) {
      // region image (≈2048x1276) moving at 1/pFactor of camera speed: the image must span
      // screen + map/pFactor so it pans exactly edge to edge across the map
      const p = this.bgParallax;
      const s = Math.max((W + mw / p) / this.bgW, (H + mh / p) / this.bgH);
      const bw = this.bgW * s;
      const bh = this.bgH * s;
      const fx = THREE.MathUtils.clamp(this.camX / mw, 0, 1);
      const fy = THREE.MathUtils.clamp(this.camY / mh, 0, 1);
      this.bg.scale.set(bw, bh, 1);
      this.bg.position.set((bw - W) * (0.5 - fx), -(bh - H) * (0.5 - fy), 0);
    }

    // stars
    for (const s of this.stars) {
      const ox = mod(-this.camX * s.f * this.zoom, STAR_TILE);
      const oy = mod(this.camY * s.f * this.zoom, STAR_TILE);
      s.group.position.set(-W / 2 - STAR_TILE + ox, -H / 2 - STAR_TILE + oy, 0);
    }

    // planets: offset from camera divided by their parallax factor
    const pz = 0.6 + 0.4 * this.zoom;
    for (const p of this.planets) {
      const sx = ((p.ax - this.camX) / p.p) * pz;
      const sy = ((p.ay - this.camY) / p.p) * pz;
      p.sprite.group.position.set(sx, -sy, 0);
      p.sprite.group.scale.setScalar(pz);
    }

    // portals: animate
    const t = now / 1000;
    for (const p of this.portals) {
      const sh = p.sprite.sheet;
      if (sh && p.sprite.loaded) {
        p.sprite.setFrame(Math.floor((t + p.phase) * (sh.fps ?? 24)) % sh.frames);
      } else {
        p.sprite.group.rotation.z = t * 0.8;
      }
    }
  }

  nearestPortal(x: number, y: number): { x: number; y: number; d: number } | null {
    if (this.r3d) return this.r3d.nearestPortal(x, y);
    let best: { x: number; y: number; d: number } | null = null;
    for (const p of this.portals) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (!best || d < best.d) best = { x: p.x, y: p.y, d };
    }
    return best;
  }

  render(): void {
    if (this.r3d) {
      this.r3d.render();
      return;
    }
    this.renderer.clear();
    this.renderer.render(this.bgScene, this.bgCamera);
    this.renderer.render(this.scene, this.camera);
  }
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

function makeDotTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.4, 'rgba(255,255,255,0.8)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 32, 32);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function makeVignetteTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(128, 128, 10, 128, 128, 180);
  grd.addColorStop(0, '#0c1630');
  grd.addColorStop(1, '#02040a');
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
