import * as THREE from 'three';
import { Assets } from '../assets';
import type { MapDef } from '../types';
import type { FlareDef, LightDef, MapScene3D, MeshDef, ModelDef, PlaneDef, SkyboxDef, TileLayerDef } from './manifest3d';
import { Manifest3DLoader, url3d } from './manifest3d';
import { ModelLibrary, instantiate, setSpecularLevel } from './models';
import { ImageBillboard, SheetBillboard } from './sprites3d';

const DEG = Math.PI / 180;

/** 1x1 quad, optionally cropped to uvRect [u0, v0, u1, v1] */
function quadGeo(uvr?: number[]): THREE.PlaneGeometry {
  const g = new THREE.PlaneGeometry(1, 1);
  if (uvr && uvr.length === 4) {
    const uv = g.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) ? uvr[2] : uvr[0], uv.getY(i) ? uvr[3] : uvr[1]);
  }
  return g;
}

/** approximate home-station layout (offsets from the station position, world units; [x, z, rotY°]) */
const STATION_LAYOUT: Record<string, [number, number, number?][]> = {
  hq: [[0, 0, 0]],
  hangar: [[-820, 380, 0]],
  repair: [[760, 520, 0]],
  trade: [[820, -420, 0]],
  mission: [[-700, -560, 0]],
  turretSmall: [[-420, -260], [420, 300]],
  turretLarge: [[0, -620], [0, 640]],
};

/** maps-config defaults (1-1 … x-8 all use this light) */
export const DEFAULT_LIGHT: Required<Omit<LightDef, 'dir'>> & { dir?: number[] } = {
  color: '#a3ffff', diffuse: 0.8, specular: 1.1, ambientColor: '#ff855c', ambient: 0.5, tilt: 100, pan: 35,
};

export interface FlareView { pos: THREE.Vector3; color: THREE.Color; size: number; textures?: FlareDef['textures']; flare?: FlareDef['flare'] }

interface FarBillboard { b: ImageBillboard; anchor: THREE.Vector3; p: number; kind: 'bg' | 'planet'; iw: number; ih: number }
interface Spinner { o: THREE.Object3D; speed: THREE.Vector3 }
export interface PortalView3D { x: number; y: number; group: THREE.Object3D; sheet: SheetBillboard | null; phase: number; model: boolean }

/** Per-map static scene: lights, skybox, background planes, scene meshes, dust, lens flares, stations, portals. */
export class MapScene {
  readonly root = new THREE.Group();
  readonly bgRoot = new THREE.Group();
  readonly sun = new THREE.DirectionalLight(0xffffff, 1);
  readonly ambient = new THREE.AmbientLight(0xffffff, 1);
  readonly flares: FlareView[] = [];
  portals: PortalView3D[] = [];
  private farBoards: FarBillboard[] = [];
  private spinners: Spinner[] = [];
  private backdrops: { o: THREE.Object3D | null; pos: THREE.Vector3; scale: THREE.Vector3; flare?: FlareView }[] = [];
  private backdropDef: MapScene3D['backdrop'] | null = null;
  private mapCentre = new THREE.Vector3();
  private sky: THREE.Mesh[] = [];
  private owned: THREE.Object3D[] = [];
  private dust: THREE.Points | null = null;
  private dustMat: THREE.ShaderMaterial | null = null;
  private billboards: THREE.Object3D[] = [];
  private gen = 0;
  map: MapDef | null = null;
  private tmpPivot = new THREE.Vector3();
  usingFallbackBg = false;

  constructor(
    scene: THREE.Scene,
    /** background scene rendered before the main scene (depth cleared in between) */
    private readonly bgScene: THREE.Scene,
    private readonly assets: Assets,
    private readonly lib: ModelLibrary,
    private readonly man: Manifest3DLoader,
  ) {
    scene.add(this.root, this.sun, this.sun.target, this.ambient);
    bgScene.add(this.bgRoot);
    this.bgRoot.renderOrder = -50;
  }

  private add(o: THREE.Object3D, parent: THREE.Object3D = this.root): void {
    parent.add(o);
    this.owned.push(o);
  }

  clear(): void {
    this.gen++;
    for (const o of this.owned) {
      o.removeFromParent();
      o.traverse((c) => {
        if (c.userData.shared) return;
        const m = c as THREE.Mesh;
        if (m.userData.ownGeo) m.geometry?.dispose();
        if (m.userData.ownMat) (m.material as THREE.Material)?.dispose();
      });
    }
    for (const f of this.farBoards) f.b.dispose();
    for (const p of this.portals) p.sheet?.dispose();
    this.owned = [];
    this.farBoards = [];
    this.spinners = [];
    this.backdrops = [];
    this.sky = [];
    this.portals = [];
    this.billboards = [];
    this.flares.length = 0;
    this.bgScene.background = null;
    if (this.dust) {
      this.dust.geometry.dispose();
      this.dust = null;
    }
  }

  setMap(map: MapDef): void {
    this.clear();
    this.map = map;
    const gen = this.gen;
    const def = this.man.mapScene(map.id);
    this.setupLight(def?.light);
    const hasSky = !!def?.skybox && !!(def.skybox.stars || def.skybox.nebula);
    const hasPlanes = !!def?.planes?.length || !!def?.backgrounds?.length;
    if (def?.skybox) this.buildSkybox(def.skybox, gen);
    // backdrop quads + planets: deepest first (depthWrite off, depthTest off)
    const quads = [...(def?.backgrounds ?? []), ...(def?.planes ?? [])].sort((a, b) => (a.pos?.[1] ?? -1e5) - (b.pos?.[1] ?? -1e5));
    this.backdropDef = def?.backdrop ?? null;
    this.mapCentre.set((def?.unityMapSize?.[0] ?? map.w) / 2, 0, (def?.unityMapSize?.[1] ?? map.h) / 2);
    quads.forEach((p, i) => this.buildPlane(map, def!, p, -99 + i, gen));
    for (const m of def?.meshes ?? []) this.buildMesh(m, gen);
    for (const [i, t] of (def?.tileLayers ?? []).entries()) this.buildTileLayer(t, i, gen);
    for (const f of def?.lensflares ?? []) this.buildFlare(f, gen);
    this.usingFallbackBg = !hasSky && !hasPlanes;
    if (this.usingFallbackBg) this.buildFallbackBackground(map);
    this.buildDust(def);
    this.buildBorder(map);
    this.buildStations(map, gen);
    this.buildPortals(map, gen);
  }

  // ---------------- light ----------------
  private setupLight(l: LightDef | undefined): void {
    const L = { ...DEFAULT_LIGHT, ...(l ?? {}) };
    this.sun.color.set(L.color);
    this.sun.intensity = L.diffuse * Math.PI;
    this.ambient.color.set(L.ambientColor);
    this.ambient.intensity = L.ambient * Math.PI;
    // Away3D-style tilt (around X) then pan (around Y) of the +z axis = light travel direction
    const dir = L.dir && L.dir.length === 3 ? new THREE.Vector3(L.dir[0], L.dir[1], L.dir[2]).normalize()
      : new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(L.tilt * DEG, L.pan * DEG, 0, 'YXZ'));
    this.sun.position.copy(dir).multiplyScalar(-1000);
    this.sun.target.position.set(0, 0, 0);
    setSpecularLevel(0.6 * L.specular / Math.max(0.05, L.diffuse));
  }

  /** direction pointing TO the sun (for flare fallbacks) */
  sunDir(): THREE.Vector3 {
    return this.sun.position.clone().normalize();
  }

  // ---------------- skybox ----------------
  private buildSkybox(s: SkyboxDef, gen: number): void {
    const layers: { src: string | string[]; add: boolean }[] = [];
    if (s.nebula) layers.push({ src: s.nebula, add: false });
    if (s.stars) layers.push({ src: s.stars, add: !!s.nebula });
    layers.forEach((layer, i) => {
      if (Array.isArray(layer.src)) {
        if (i > 0) return; // cube maps: only the first one as scene.background
        const urls = layer.src.map((u) => url3d(u)!).filter(Boolean);
        if (urls.length === 6) {
          new THREE.CubeTextureLoader().load(urls, (t) => {
            if (gen !== this.gen) return;
            t.colorSpace = THREE.SRGBColorSpace;
            this.bgScene.background = t;
          });
        }
        return;
      }
      void this.lib.image(layer.src, true).then((tex) => {
        if (!tex || gen !== this.gen) return;
        tex.mapping = THREE.EquirectangularReflectionMapping;
        tex.wrapS = THREE.RepeatWrapping;
        const mat = new THREE.MeshBasicMaterial({
          map: tex, side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
          transparent: layer.add, blending: layer.add ? THREE.AdditiveBlending : THREE.NormalBlending,
          color: s.tint && i === 0 ? new THREE.Color(s.tint) : 0xffffff,
        });
        const m = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), mat);
        m.userData.ownGeo = m.userData.ownMat = true;
        m.scale.setScalar(150000);
        m.rotation.y = (s.rot ?? 0) * DEG;
        m.renderOrder = -100 + i;
        m.frustumCulled = false;
        this.sky.push(m);
        this.add(m, this.bgRoot);
      });
    });
  }

  // ---------------- background planes ----------------
  private sphereCenter(map: MapDef, def: MapScene3D, p: PlaneDef): THREE.Vector3 {
    const c = def.center ? new THREE.Vector3(...def.center) : new THREE.Vector3(map.w / 2, 0, map.h / 2);
    if (p.x !== undefined) c.x = p.x;
    if (p.y !== undefined) c.y = p.y;
    if (p.z !== undefined) c.z = p.z;
    return c;
  }

  private buildPlane(map: MapDef, def: MapScene3D, p: PlaneDef, order: number, gen: number): void {
    void this.lib.image(p.tex, true).then((tex) => {
      if (!tex || gen !== this.gen) return;
      const img = tex.image as { width: number; height: number };
      const aspect = p.aspect ?? img.width / Math.max(1, img.height);
      const add = (p.blend ?? '').toLowerCase() === 'add';
      const mat = new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthWrite: false, depthTest: false, fog: false,
        blending: add ? THREE.AdditiveBlending : THREE.NormalBlending, opacity: p.opacity ?? 1,
        color: p.color ? new THREE.Color(p.color) : 0xffffff, side: THREE.DoubleSide,
      });
      const m = new THREE.Mesh(quadGeo(p.uvRect), mat);
      m.userData.ownGeo = m.userData.ownMat = true;
      if (Array.isArray(p.scale)) m.scale.set(p.scale[0] ?? 1, p.scale[1] ?? p.scale[0] ?? 1, 1);
      else {
        const sc = p.scale ?? 50000;
        m.scale.set(sc * aspect, sc, 1);
      }
      if (p.pos && p.quat) {
        // scene agent: exact Unity transform already converted to three (1x1 XY quad, front +Z)
        m.position.set(p.pos[0], p.pos[1], p.pos[2]);
        m.quaternion.set(p.quat[0], p.quat[1], p.quat[2], p.quat[3]);
      } else {
        const c = this.sphereCenter(map, def, p);
        if (p.pos) m.position.set(p.pos[0], p.pos[1], p.pos[2]);
        else {
          // spherical placement around the map centre: theta measured from straight down (-Y),
          // phi around Y with -90 deg = towards -z (north / screen top)
          const r = p.r ?? 50000;
          const th = (p.theta ?? 30) * DEG;
          const ph = (p.phi ?? -90) * DEG;
          m.position.set(c.x + r * Math.sin(th) * Math.cos(ph), c.y - r * Math.cos(th), c.z + r * Math.sin(th) * Math.sin(ph));
        }
        m.lookAt(c);
      }
      if (p.rotZ) m.rotateZ(p.rotZ * DEG);
      m.renderOrder = order;
      m.frustumCulled = false;
      if (p.backdrop || this.backdropDef?.members?.includes(p.name ?? '')) this.backdrops.push({ o: m, pos: m.position.clone(), scale: m.scale.clone() });
      this.add(m, this.bgRoot);
    });
  }

  /** flat cloud/dust tiles from an atlas, merged into one mesh per layer */
  private buildTileLayer(t: TileLayerDef, i: number, gen: number): void {
    void this.lib.image(t.atlas, true).then((tex) => {
      if (!tex || gen !== this.gen) return;
      const img = tex.image as { width: number; height: number };
      const AW = t.atlasSize?.[0] ?? img.width;
      const AH = t.atlasSize?.[1] ?? img.height;
      const f = t.tileFields ?? ['x', 'z', 'rect', 'w', 'h', 'rotY', 'alpha'];
      const ix = (k: string) => f.indexOf(k);
      const n = t.tiles.length;
      const pos = new Float32Array(n * 4 * 3);
      const uv = new Float32Array(n * 4 * 2);
      const col = new Float32Array(n * 4 * 4);
      const idx: number[] = [];
      const y = t.y ?? 0;
      t.tiles.forEach((tile, k) => {
        const x = tile[ix('x')];
        const z = tile[ix('z')];
        const r = t.rects[tile[ix('rect')]] ?? [0, 0, AW, AH];
        const w = tile[ix('w')] / 2;
        const h = tile[ix('h')] / 2;
        const ry = (tile[ix('rotY')] ?? 0) * DEG;
        const a = ix('alpha') >= 0 ? tile[ix('alpha')] : 1;
        const c = Math.cos(ry);
        const sn = Math.sin(ry);
        const corners = [[-w, -h], [w, -h], [w, h], [-w, h]];
        // atlas rects are in image pixels, origin top-left (verified against the atlas alpha); texture is flipY
        const u0 = r[0] / AW, u1 = (r[0] + r[2]) / AW, vTop = 1 - r[1] / AH, vBot = 1 - (r[1] + r[3]) / AH;
        // corners: NW, NE, SE, SW (north = -z = image top)
        const uvs = [[u0, vTop], [u1, vTop], [u1, vBot], [u0, vBot]];
        corners.forEach(([lx, lz], j) => {
          const o = (k * 4 + j);
          pos[o * 3] = x + lx * c + lz * sn;
          pos[o * 3 + 1] = y;
          pos[o * 3 + 2] = z - lx * sn + lz * c;
          uv[o * 2] = uvs[j][0];
          uv[o * 2 + 1] = uvs[j][1];
          col.set([1, 1, 1, a], o * 4);
        });
        const b = k * 4;
        idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
      geo.setIndex(idx);
      const add = (t.blend ?? '').toLowerCase() === 'add';
      const mat = new THREE.MeshBasicMaterial({
        map: tex, vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
        blending: add ? THREE.AdditiveBlending : THREE.NormalBlending,
      });
      const m = new THREE.Mesh(geo, mat);
      m.userData.ownGeo = m.userData.ownMat = true;
      m.renderOrder = -30 + i;
      m.frustumCulled = false;
      this.add(m);
    });
  }

  private buildFlare(f: FlareDef, gen: number): void {
    const p = f.pos ? new THREE.Vector3(f.pos[0], f.pos[1], f.pos[2]) : new THREE.Vector3(f.x ?? 0, f.y ?? 0, f.z ?? 0);
    const fc = f.flare?.color;
    const color = fc ? new THREE.Color(fc[0], fc[1], fc[2]) : new THREE.Color(f.color ?? '#fff3d8');
    const view: FlareView = { pos: p, color, size: f.size ?? 1, textures: f.textures, flare: f.flare };
    this.flares.push(view);
    const isBd = !!f.backdrop || !!this.backdropDef?.members?.includes(f.name ?? '');
    if (isBd) this.backdrops.push({ o: null, pos: p.clone(), scale: new THREE.Vector3(1, 1, 1), flare: view });
    if (f.sprite) {
      void this.lib.image(f.sprite, true).then((tex) => {
        if (!tex || gen !== this.gen) return;
        const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
          map: tex, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, fog: false,
        }));
        m.userData.ownGeo = m.userData.ownMat = true;
        const ss = f.spriteSize ?? [1, 1];
        const sc = f.scale ?? [1, 1, 1];
        m.scale.set(ss[0] * sc[0], ss[1] * sc[1], 1);
        m.position.copy(p);
        if (f.quat) m.quaternion.set(f.quat[0], f.quat[1], f.quat[2], f.quat[3]);
        m.renderOrder = -60;
        m.frustumCulled = false;
        if (isBd) this.backdrops.push({ o: m, pos: m.position.clone(), scale: m.scale.clone() });
        this.add(m, this.bgRoot);
      });
    }
  }

  // ---------------- scene meshes ----------------
  private buildMesh(d: MeshDef, gen: number): void {
    const mat = d.material ?? {};
    const def: ModelDef = {
      glb: d.glb, tex: d.tex, scale: 1, rim: d.rim, flipY: d.flipY, noCenter: true,
      doubleSided: mat.doubleSided, shininess: mat._Glossiness !== undefined ? 4 + mat._Glossiness * 60 : undefined,
      glow: mat._GlowAmount !== undefined ? 0.4 + mat._GlowAmount * 1.4 : undefined,
    };
    const key = `scene:${JSON.stringify(def)}`;
    void this.lib.template(key, def, null, '+x').then((t) => {
      if (!t || gen !== this.gen) return;
      const o = instantiate(t);
      o.userData.shared = true;
      if (d.pos) o.position.set(d.pos[0], d.pos[1], d.pos[2]);
      else o.position.set(d.x ?? 0, d.y ?? 0, d.z ?? 0);
      if (d.quat) o.quaternion.set(d.quat[0], d.quat[1], d.quat[2], d.quat[3]);
      else if (d.rot) o.rotation.set((d.rot[0] ?? 0) * DEG, (d.rot[1] ?? 0) * DEG, (d.rot[2] ?? 0) * DEG);
      if (Array.isArray(d.scale)) o.scale.set(d.scale[0] ?? 1, d.scale[1] ?? 1, d.scale[2] ?? 1);
      else if (typeof d.scale === 'number') o.scale.setScalar(d.scale);
      if (d.randomRotYDeg) o.rotateY((d.randomRotYDeg[0] + Math.random() * (d.randomRotYDeg[1] - d.randomRotYDeg[0])) * DEG);
      this.add(o);
      if (d.spin) this.spinners.push({ o, speed: new THREE.Vector3(0, d.spin * DEG, 0) });
      for (const a of d.anim ?? []) {
        const rr = (r?: number[]) => (r ? (r[0] + Math.random() * ((r[1] ?? r[0]) - r[0])) * DEG : 0);
        const node = (a.node && o.getObjectByName(a.node)) || o;
        this.spinners.push({ o: node, speed: new THREE.Vector3(rr(a.x), rr(a.y), rr(a.z)) });
      }
    });
  }

  // ---------------- 2D fallback background ----------------
  private buildFallbackBackground(map: MapDef): void {
    const bgRel = this.assets.manifest.backgrounds[String(map.background)];
    const layer = (map as MapDef & { backgrounds?: { typeID: string; pFactor?: string }[] }).backgrounds?.find((b) => String(b.typeID) === String(map.background));
    const p = Math.max(1.5, Number(layer?.pFactor) || 10);
    const center = new THREE.Vector3(map.w / 2, 0, map.h / 2);
    if (bgRel) {
      const b = new ImageBillboard(this.assets, bgRel, 1, { renderOrder: -80, depthTest: false });
      const fb: FarBillboard = { b, anchor: center, p, kind: 'bg', iw: 2048, ih: 1276 };
      b.onLoad = (bb) => { fb.iw = bb.w; fb.ih = bb.h; };
      this.bgRoot.add(b.group);
      this.farBoards.push(fb);
    }
    let rw = 2048 * (map.w / 21000);
    let rh = 1276 * (map.h / 13100);
    if (map.region) {
      const [a, bb] = String(map.region).split(',').map(Number);
      if (a > 0 && bb > 0) { rw = a; rh = bb; }
    }
    for (const pl of map.planets ?? []) {
      const rel = this.assets.manifest.planets[String(pl.type)];
      if (!rel) continue;
      const b = new ImageBillboard(this.assets, rel, 1, { renderOrder: -70 + Math.round(10 / Math.max(1, pl.p)), depthTest: false });
      const fb: FarBillboard = { b, anchor: new THREE.Vector3((pl.x / rw) * map.w, 0, (pl.y / rh) * map.h), p: Math.max(1.2, pl.p || 1), kind: 'planet', iw: 0, ih: 0 };
      this.bgRoot.add(b.group);
      this.farBoards.push(fb);
    }
    // 2D lens flares (region coords) -> far points below the plane
    const lf = (map as MapDef & { lensflares?: { x: number; y: number; p?: number }[] }).lensflares ?? [];
    for (const f of lf) {
      this.flares.push({ pos: new THREE.Vector3((f.x / rw) * map.w, -9000, (f.y / rh) * map.h), color: new THREE.Color('#fff1d0'), size: 1 });
    }
  }

  // ---------------- dust / starfield particles ----------------
  private buildDust(def: MapScene3D | null): void {
    const sf = def?.starfield ?? {};
    let sfColor = sf.color;
    const grad = sf.emitter?.colorOverLife?.gradient?.color;
    if (!sfColor && grad?.length) {
      // brightest gradient key ([t, r, g, b])
      const best = grad.reduce((a, b) => (b[1] + b[2] + b[3] > a[1] + a[2] + a[3] ? b : a));
      sfColor = '#' + new THREE.Color(best[1], best[2], best[3]).getHexString();
    }
    const count = sf.count ?? 1400;
    const S = 7000;
    const pos = new Float32Array(count * 3);
    const rnd = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = Math.random() * S;
      pos[i * 3 + 1] = -150 - Math.pow(Math.random(), 0.7) * 3200 + (Math.random() < 0.08 ? 900 : 0);
      pos[i * 3 + 2] = Math.random() * S;
      rnd[i] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aRnd', new THREE.BufferAttribute(rnd, 1));
    if (!this.dustMat) {
      this.dustMat = new THREE.ShaderMaterial({
        uniforms: {
          uCenter: { value: new THREE.Vector3() }, uSize: { value: S }, uColor: { value: new THREE.Color('#bfe6ff') },
          uPx: { value: 2.2 }, uScale: { value: 800 }, uTime: { value: 0 },
        },
        vertexShader: `
          uniform vec3 uCenter; uniform float uSize; uniform float uPx; uniform float uScale; uniform float uTime;
          attribute float aRnd;
          varying float vA;
          void main() {
            vec3 p = position;
            p.xz = uCenter.xz + mod(p.xz - uCenter.xz + 0.5 * uSize, uSize) - 0.5 * uSize;
            vec4 mv = viewMatrix * vec4(p, 1.0);
            gl_Position = projectionMatrix * mv;
            float d = length(p.xz - uCenter.xz) / (0.5 * uSize);
            vA = (1.0 - smoothstep(0.6, 1.0, d)) * (0.45 + 0.55 * aRnd) * (0.75 + 0.25 * sin(uTime * (0.5 + aRnd * 2.0) + aRnd * 40.0));
            gl_PointSize = clamp(uPx * (0.6 + aRnd) * uScale / -mv.z, 1.0, 6.0);
          }`,
        fragmentShader: `
          uniform vec3 uColor;
          varying float vA;
          void main() {
            vec2 c = gl_PointCoord - 0.5;
            float a = smoothstep(0.5, 0.0, length(c));
            gl_FragColor = vec4(uColor * a * vA, 1.0);
          }`,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      });
    }
    (this.dustMat.uniforms.uColor.value as THREE.Color).set(sfColor ?? '#bfe6ff');
    this.dustMat.uniforms.uPx.value = sf.size ?? 2.2;
    const pts = new THREE.Points(geo, this.dustMat);
    pts.frustumCulled = false;
    pts.renderOrder = -40;
    pts.userData.ownGeo = true;
    this.dust = pts;
    this.add(pts);
  }

  private buildBorder(map: MapDef): void {
    const pts = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(map.w, 0, 0), new THREE.Vector3(map.w, 0, map.h), new THREE.Vector3(0, 0, map.h)];
    const border = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0x5a7fa8, transparent: true, opacity: 0.35, depthWrite: false }),
    );
    border.userData.ownGeo = border.userData.ownMat = true;
    this.add(border);
  }

  // ---------------- stations / portals ----------------
  private sizedTemplate(key: string, def: ModelDef, fallbackLen: number) {
    // honour explicit size; otherwise use raw×scale only when it is in a plausible range
    return this.lib.gltf(def.glb!).then((g) => {
      if (!g) return null;
      let target: number | null = def.size ?? null;
      if (!target && !def.bounds) {
        const b = new THREE.Box3().setFromObject(g.scene);
        const s = b.getSize(new THREE.Vector3());
        const raw = Math.max(s.x, s.z) * (def.scale ?? 1);
        target = raw > fallbackLen * 0.3 && raw < fallbackLen * 3 ? null : fallbackLen;
      }
      return this.lib.template(key, def, target, '+x');
    });
  }

  private buildStations(map: MapDef, gen: number): void {
    for (const st of map.stations ?? []) {
      const def = this.man.data.stations[st.faction];
      const g = new THREE.Group();
      g.position.set(st.x, 0, st.y);
      this.add(g);
      const fallback = () => {
        const rel = this.assets.manifest.stations[st.faction];
        const b = new ImageBillboard(this.assets, rel, 1, { renderOrder: 1 });
        g.add(b.group);
        this.billboards.push(b.group);
        this.owned.push(b.group);
      };
      const parts: { def: ModelDef; x: number; z: number; rotY: number }[] = [];
      if (def?.parts && Object.keys(def.parts).length) {
        // the station layout is server data in DO; approximate the home-base ring around the HQ
        for (const [name, pd] of Object.entries(def.parts)) {
          const list = STATION_LAYOUT[name] ?? [];
          for (const l of list) parts.push({ def: pd, x: pd.pos?.[0] ?? l[0], z: pd.pos?.[2] ?? l[1], rotY: pd.rotY ?? l[2] ?? 0 });
        }
      } else if (def?.glb) parts.push({ def, x: 0, z: 0, rotY: 0 });
      if (!parts.length) {
        fallback();
        continue;
      }
      let failed = 0;
      for (const pt of parts) {
        void this.sizedTemplate(`station:${pt.def.glb}`, pt.def, 900).then((t) => {
          if (gen !== this.gen) return;
          if (!t) {
            if (++failed === parts.length) fallback();
            return;
          }
          const o = instantiate(t);
          o.userData.shared = true;
          o.position.set(pt.x, 0, pt.z);
          o.rotation.y = pt.rotY * DEG;
          g.add(o);
          this.spinners.push({ o, speed: new THREE.Vector3(0, (pt.def === def?.parts?.hq ? 1 : 0.5) * DEG, 0) });
        });
      }
    }
  }

  private buildPortals(map: MapDef, gen: number): void {
    for (const p of map.portals ?? []) {
      const g = new THREE.Group();
      g.position.set(p.x, 0, p.y);
      this.add(g);
      const pv: PortalView3D = { x: p.x, y: p.y, group: g, sheet: null, phase: Math.random() * 10, model: false };
      this.portals.push(pv);
      const fallback = () => {
        const sh = this.assets.manifest.portal;
        if (sh && sh.url) {
          pv.sheet = new SheetBillboard(this.assets, sh, 1, { renderOrder: 2 });
          g.add(pv.sheet.group);
          this.billboards.push(pv.sheet.group);
        }
      };
      const def = this.man.data.portal;
      if (def?.glb) {
        void this.sizedTemplate(`portal:${def.glb}`, def, 320).then((t) => {
          if (gen !== this.gen) return;
          if (!t) return fallback();
          const o = instantiate(t);
          o.userData.shared = true;
          g.add(o);
          pv.model = true;
          this.spinners.push({ o, speed: new THREE.Vector3(0, 0, 0) });
        });
      } else fallback();
    }
  }

  // ---------------- per frame ----------------
  update(dt: number, now: number, camera: THREE.PerspectiveCamera, target: THREE.Vector3, dist: number, zoom: number, viewW: number, viewH: number): void {
    for (const s of this.sky) s.position.copy(camera.position);
    // scene agent backdrop rule: pos' = pivot + (pos - pivot)*fitScale + follow*(camTarget - mapCentre), scale' = scale*fitScale
    const bd = this.backdropDef;
    if (bd && this.backdrops.length) {
      const fit = bd.fitScale ?? 1;
      const fol = bd.follow ?? 0;
      const pv = this.tmpPivot.set(bd.pivot?.[0] ?? 0, bd.pivot?.[1] ?? 0, bd.pivot?.[2] ?? 0);
      const fx = fol * (target.x - this.mapCentre.x);
      const fz = fol * (target.z - this.mapCentre.z);
      for (const b of this.backdrops) {
        const dst = b.o ? b.o.position : b.flare!.pos;
        dst.copy(b.pos).sub(pv).multiplyScalar(fit).add(pv);
        dst.x += fx;
        dst.z += fz;
        if (b.o) b.o.scale.copy(b.scale).multiplyScalar(fit);
      }
    }
    for (const s of this.spinners) {
      s.o.rotation.x += s.speed.x * dt;
      s.o.rotation.y += s.speed.y * dt;
      s.o.rotation.z += s.speed.z * dt;
    }
    for (const b of this.billboards) b.quaternion.copy(camera.quaternion);
    for (const p of this.portals) {
      if (p.sheet?.loaded) {
        const sh = p.sheet.sheet;
        p.sheet.setFrame(Math.floor((now / 1000 + p.phase) * (sh.fps ?? 24)) % sh.frames);
      }
    }
    if (this.dustMat && this.dust) {
      (this.dustMat.uniforms.uCenter.value as THREE.Vector3).copy(target);
      this.dustMat.uniforms.uTime.value = now / 1000;
      this.dustMat.uniforms.uScale.value = viewH / (2 * Math.tan((camera.fov * DEG) / 2));
    }
    if (this.farBoards.length && this.map) {
      const fwd = camera.getWorldDirection(new THREE.Vector3());
      const mw = this.map.w;
      const mh = this.map.h;
      const pz = 0.6 + 0.4 * zoom;
      for (const f of this.farBoards) {
        const g = f.b.group;
        const depth = dist * (f.p - 1);
        g.position.copy(f.anchor).addScaledVector(fwd, depth);
        g.quaternion.copy(camera.quaternion);
        if (f.kind === 'bg') {
          const needW = (viewW / zoom + mw / f.p) * 1.08;
          const needH = (viewH / zoom + mh / f.p) * 1.08;
          const s = Math.max(needW / Math.max(1, f.iw), needH / Math.max(1, f.ih)) * f.p;
          g.scale.set(s, s, 1);
        } else {
          g.scale.setScalar((pz / zoom) * f.p);
        }
      }
    }
  }

  nearestPortal(x: number, y: number): { x: number; y: number; d: number } | null {
    let best: { x: number; y: number; d: number } | null = null;
    for (const p of this.map?.portals ?? []) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (!best || d < best.d) best = { x: p.x, y: p.y, d };
    }
    return best;
  }
}
