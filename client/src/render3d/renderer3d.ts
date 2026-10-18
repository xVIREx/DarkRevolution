import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FXAAPass } from 'three/examples/jsm/postprocessing/FXAAPass.js';
import { Assets } from '../assets';
import type { EntityManager } from '../entities';
import type { EntId, MapDef } from '../types';
import { Entities3D } from './entities3d';
import { Fx3D } from './fx3d';
import { Manifest3DLoader } from './manifest3d';
import { ModelLibrary } from './models';
import { Overlay } from './overlay';
import { MapScene } from './scene3d';

const DEG = Math.PI / 180;

/** Defaults close to the Unity client's 3D camera (scene agent may override via manifest `camera`). */
export const CAMERA_DEFAULTS = { fov: 40, pitch: 58 };

/**
 * Modern-DarkOrbit-style 3D renderer. Game (x, y) with +y down maps to three (x, 0, y) on the XZ plane, Y up.
 * The camera sits south of (+z) and above its target, looking north-down, so screen-up = world −y like in 2D.
 */
export class Renderer3D {
  readonly scene = new THREE.Scene();
  readonly bgScene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly man = new Manifest3DLoader();
  readonly lib = new ModelLibrary();
  readonly overlay = new Overlay();
  readonly mapScene: MapScene;
  readonly ents3d: Entities3D;
  readonly fx: Fx3D;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private fxaa: FXAAPass | null = null;
  private target = new THREE.Vector3();
  private dist = 1200;
  private width = 1;
  private height = 1;
  private ray = new THREE.Raycaster();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private ents: EntityManager | null = null;
  private map: MapDef | null = null;
  private mapVersion = -1;
  private tmpV = new THREE.Vector3();
  private frameMs = 16;
  /** quality knobs */
  bloomEnabled = true;

  constructor(readonly renderer: THREE.WebGLRenderer, assets: Assets) {
    this.camera = new THREE.PerspectiveCamera(CAMERA_DEFAULTS.fov, 1, 8, 400000);
    this.lib.maxAnisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    this.mapScene = new MapScene(this.scene, this.bgScene, assets, this.lib, this.man);
    this.ents3d = new Entities3D(this.scene, this.overlay, assets, this.lib, this.man);
    this.fx = new Fx3D(this.scene, assets, this.lib, this.man, this.ents3d);
    this.fx.camera = this.camera;
    this.scene.background = null;
    renderer.setClearColor(0x02040a, 1);

    const pr = renderer.getPixelRatio();
    const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: pr > 1.5 ? 2 : 4 });
    this.composer = new EffectComposer(renderer, rt);
    this.composer.addPass(new RenderPass(this.bgScene, this.camera));
    const main = new RenderPass(this.scene, this.camera);
    main.clear = false;
    main.clearDepth = true;
    this.composer.addPass(main);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.45, 0.4, 0.9);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    if (/[?&]aa=fxaa/.test(window.location.search)) {
      this.fxaa = new FXAAPass();
      this.composer.addPass(this.fxaa);
    }
    void this.man.init();
    (window as unknown as { __r3d?: Renderer3D }).__r3d = this;
  }

  attach(ents: EntityManager): void {
    this.ents = ents;
  }

  get fov(): number {
    return this.man.data.camera?.fov ?? CAMERA_DEFAULTS.fov;
  }

  get pitch(): number {
    const c = this.man.data.camera;
    return (c?.pitchDeg ?? c?.pitch ?? CAMERA_DEFAULTS.pitch) * DEG;
  }

  resize(w: number, h: number): void {
    this.width = w;
    this.height = h;
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    this.overlay.resize(w, h);
  }

  setMap(map: MapDef): void {
    this.map = map;
    this.mapVersion = this.man.version;
    this.ents3d.clear();
    this.fx.clear();
    this.mapScene.setMap(map);
    this.overlay.setFlares(this.mapScene.flares, (rel) => this.lib.image(rel, true));
  }

  /** zoom = screen pixels per world unit at the camera target (same meaning as the 2D zoom). */
  private placeCamera(camX: number, camY: number, zoom: number): void {
    const cm = this.man.data.camera;
    const near = cm?.near ?? 8;
    const far = Math.max(160000, (cm?.far ?? 0) * 2);
    if (this.camera.fov !== this.fov || this.camera.near !== near || this.camera.far !== far) {
      this.camera.fov = this.fov;
      this.camera.near = near;
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
    this.target.set(camX, 0, camY);
    const cd = this.man.data.camera?.distance;
    // with the Unity camera distance known, zoom 1 = the original framing; otherwise zoom = px per world unit
    this.dist = cd ? cd / Math.max(0.05, zoom) : this.height / (2 * Math.tan((this.camera.fov * DEG) / 2) * Math.max(0.05, zoom));
    const p = this.pitch;
    this.camera.position.set(camX, Math.sin(p) * this.dist, camY + Math.cos(p) * this.dist);
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
  }

  update(dt: number, now: number, camX: number, camY: number, zoom: number): void {
    const t0 = performance.now();
    // manifests appeared/changed -> rebuild the map scene (entities re-resolve themselves)
    if (this.map && this.mapVersion !== this.man.version) this.setMap(this.map);
    this.placeCamera(camX, camY, zoom);
    const pxScale = this.height / (2 * Math.tan((this.camera.fov * DEG) / 2));
    /** effective screen px per world unit at the target */
    const ppu = pxScale / this.dist;
    this.fx.setPixelScale(pxScale);
    this.mapScene.update(dt, now, this.camera, this.target, this.dist, ppu, this.width, this.height);
    if (this.ents) {
      // anything farther than ~1.3 x the view footprint is skipped (LOD / culling)
      const halfW = (this.width / ppu) * 0.5;
      const halfH = ((this.height / ppu) * 0.5) / Math.sin(this.pitch);
      const viewRadius = Math.hypot(halfW, halfH) * 1.3 + 300;
      this.ents3d.sync(this.ents, dt, now, this.camera, this.target, viewRadius, (p) => this.project(p));
    }
    this.fx.update(now, dt);
    this.overlay.updateFlares(this.camera, this.width, this.height);
    this.frameMs = this.frameMs * 0.95 + (performance.now() - t0) * 0.05;
  }

  render(): void {
    const r = this.renderer;
    if (this.bloomEnabled) {
      this.composer.render();
    } else {
      r.setRenderTarget(null);
      r.clear();
      r.render(this.bgScene, this.camera);
      r.clearDepth();
      r.render(this.scene, this.camera);
    }
    r.setRenderTarget(null);
    r.clearDepth();
    r.render(this.overlay.scene, this.overlay.camera);
  }

  // ---------------- coordinate helpers ----------------
  project(p: THREE.Vector3): { x: number; y: number; z: number } {
    const v = this.tmpV.copy(p).project(this.camera);
    return { x: (v.x * 0.5 + 0.5) * this.width, y: (1 - (v.y * 0.5 + 0.5)) * this.height, z: v.z };
  }

  worldToScreen(x: number, y: number, h = 0): { x: number; y: number } {
    const s = this.project(new THREE.Vector3(x, h, y));
    return { x: s.x, y: s.y };
  }

  private rayAt(sx: number, sy: number): THREE.Ray {
    const ndc = new THREE.Vector2((sx / this.width) * 2 - 1, -(sy / this.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    return this.ray.ray;
  }

  /** screen pixel → game world point on the y=0 plane */
  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    const hit = this.rayAt(sx, sy).intersectPlane(this.plane, new THREE.Vector3());
    if (!hit) return { x: this.target.x, y: this.target.z };
    return { x: hit.x, y: hit.z };
  }

  /** entity id under the cursor (raycast against entity bounds, excludes own ship) */
  pickEntity(sx: number, sy: number): EntId | null {
    return this.ents3d.pick(this.rayAt(sx, sy).clone(), this.ents?.myId ?? null);
  }

  nearestPortal(x: number, y: number): { x: number; y: number; d: number } | null {
    return this.mapScene.nearestPortal(x, y);
  }

  stats(): { ms: number; calls: number; tris: number; ents: number } {
    return { ms: this.frameMs, calls: this.renderer.info.render.calls, tris: this.renderer.info.render.triangles, ents: this.ents3d.map.size };
  }
}
