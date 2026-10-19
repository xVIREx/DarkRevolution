import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { ModelDef, RimDef, TexSet } from './manifest3d';
import { url3d } from './manifest3d';

/** world units per lib_ships `visualSize` (goliath visualSize 1.4 → ~150 units, close to its 2D sprite). */
/** Orientation fixes for GLBs the exporter got wrong (keyed by manifest `geometry`, Euler XYZ like `rot`).
 * These prefabs are authored standing up or lying on their side; the values lay them flat with the face up
 * so the top view matches the 2D sprite (checked with tools/m3d_render.py against sheet frame 16). */
const Q = Math.PI / 2;
const ROT_FIX: Record<string, [number, number, number]> = {
  'lordakia': [0, 0, Q],
  'lordakia-boss': [0, 0, Q],
  'lordakium': [0, 0, Q],
  'lordakium-boss': [0, 0, -Q],
  'sibelon-boss': [0, 0, -Q],
  'sibelonit': [-Q, Q, 0],
  'kucurbium': [-Q, -Q, 0],
};

export const VISUAL_SIZE_UNIT = 105;

export type TexKind = 'diffuse' | 'normal' | 'specular' | 'glow' | 'alpha';

export interface ModelTemplate {
  /** normalised wrapper: nose along +x, centred, sized in world units */
  root: THREE.Object3D;
  length: number;
  radius: number;
  height: number;
  laserPoints: THREE.Vector3[];
  engines: THREE.Vector3[];
  skinned?: boolean;
}

const doMaterials = new Set<THREE.MeshPhongMaterial>();
let specLevel = 1;
/** per-map light `specular / diffuse` ratio applied to every DO material's specular colour */
export function setSpecularLevel(level: number): void {
  specLevel = level;
  for (const m of doMaterials) m.specular.setScalar((m.userData.specBase as number) * level);
}

/** DO look: Phong (diffuse/normal/specular/glow) + rim light (from lib_ships <shader><rimLight>). */
export function makeDoMaterial(opts: {
  map?: THREE.Texture | null; normalMap?: THREE.Texture | null; specularMap?: THREE.Texture | null;
  glowMap?: THREE.Texture | null; alphaMap?: THREE.Texture | null; rim?: RimDef | null; shininess?: number; glow?: number;
  color?: THREE.ColorRepresentation; doubleSide?: boolean;
}): THREE.MeshPhongMaterial {
  const m = new THREE.MeshPhongMaterial({
    color: opts.color ?? 0xffffff,
    map: opts.map ?? null,
    normalMap: opts.normalMap ?? null,
    specularMap: opts.specularMap ?? null,
    specular: 0xffffff,
    shininess: opts.shininess ?? 28,
    emissive: opts.glowMap ? 0xffffff : 0x000000,
    emissiveMap: opts.glowMap ?? null,
    emissiveIntensity: opts.glow ?? 1.6,
    alphaMap: opts.alphaMap ?? null,
    alphaTest: opts.alphaMap ? 0.4 : 0,
    side: opts.doubleSide ? THREE.DoubleSide : THREE.FrontSide,
  });
  m.userData.specBase = opts.specularMap ? 1 : 0.25;
  m.specular.setScalar(m.userData.specBase * specLevel);
  doMaterials.add(m);
  const rim = opts.rim;
  if (rim && (rim.strength ?? 0) > 0) {
    const u = {
      rimColor: { value: new THREE.Color(rim.color ?? '#ffffff') },
      rimStrength: { value: rim.strength ?? 1 },
      rimPower: { value: Math.max(0.1, rim.power ?? 1) },
    };
    m.userData.rim = u;
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 rimColor;\nuniform float rimStrength;\nuniform float rimPower;')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  float rimF = 1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
  totalEmissiveRadiance += rimColor * rimStrength * pow(rimF, rimPower);
}`);
    };
    m.customProgramCacheKey = () => 'do-rim';
  }
  return m;
}

/** Loads and caches glTF models, textures and normalised templates. */
export class ModelLibrary {
  private loader = new GLTFLoader();
  private texLoader = new THREE.TextureLoader();
  private gltfs = new Map<string, Promise<GLTF | null>>();
  private textures = new Map<string, Promise<THREE.Texture | null>>();
  private templates = new Map<string, Promise<ModelTemplate | null>>();
  private ready = new Map<string, ModelTemplate | null>();
  maxAnisotropy = 4;

  constructor() {
    this.loader.setMeshoptDecoder(MeshoptDecoder);
  }

  texture(rel: string | undefined | null, kind: TexKind, flipY = false): Promise<THREE.Texture | null> {
    const u = url3d(rel);
    if (!u) return Promise.resolve(null);
    const key = `${u}|${kind}|${flipY}`;
    let p = this.textures.get(key);
    if (!p) {
      p = new Promise((resolve) => {
        this.texLoader.load(u, (t) => {
          t.flipY = flipY;
          t.colorSpace = kind === 'diffuse' || kind === 'glow' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
          t.anisotropy = this.maxAnisotropy;
          t.wrapS = t.wrapT = THREE.RepeatWrapping;
          t.needsUpdate = true;
          resolve(t);
        }, undefined, () => {
          console.warn('[render3d] missing texture', u);
          resolve(null);
        });
      });
      this.textures.set(key, p);
    }
    return p;
  }

  /** plain sRGB texture (scene planes, fx) */
  image(rel: string | undefined | null, flipY = true): Promise<THREE.Texture | null> {
    return this.texture(rel, 'diffuse', flipY);
  }

  gltf(rel: string): Promise<GLTF | null> {
    const u = url3d(rel);
    if (!u) return Promise.resolve(null);
    let p = this.gltfs.get(u);
    if (!p) {
      p = this.loader.loadAsync(u).catch((e) => {
        console.warn('[render3d] missing model', u, e?.message ?? e);
        return null;
      });
      this.gltfs.set(u, p);
    }
    return p;
  }

  async materialFor(def: { tex?: TexSet; rim?: RimDef; flipY?: boolean; shininess?: number; glow?: number }, doubleSide = false): Promise<THREE.Material | null> {
    const t = def.tex;
    if (!t || !t.diffuse) return null;
    const fy = def.flipY ?? false;
    const [map, normalMap, specularMap, glowMap, alphaMap] = await Promise.all([
      this.texture(t.diffuse, 'diffuse', fy), this.texture(t.normal, 'normal', fy), this.texture(t.specular, 'specular', fy),
      this.texture(t.glow, 'glow', fy), this.texture(t.alpha, 'alpha', fy),
    ]);
    if (!map) return null;
    return makeDoMaterial({ map, normalMap, specularMap, glowMap, alphaMap, rim: def.rim, shininess: def.shininess, glow: def.glow, doubleSide });
  }

  /** synchronous: template if already built (undefined = loading / not requested, null = failed) */
  templateNow(key: string): ModelTemplate | null | undefined {
    return this.ready.get(key);
  }

  /**
   * Normalised template. `targetLen` = world length of the longest horizontal extent (null = keep raw × def.scale).
   * `forward` = model axis that is the nose (after def.rot).
   */
  template(key: string, def: ModelDef, targetLen: number | null, forward = '+x', rim?: RimDef | null): Promise<ModelTemplate | null> {
    let p = this.templates.get(key);
    if (!p) {
      p = this.build(def, targetLen, def.forward ?? forward, rim ?? def.rim ?? null).then((t) => {
        this.ready.set(key, t);
        return t;
      });
      this.templates.set(key, p);
    }
    return p;
  }

  private async build(def: ModelDef, targetLen: number | null, forward: string, rim: RimDef | null): Promise<ModelTemplate | null> {
    if (!def.glb) return null;
    const g = await this.gltf(def.glb);
    if (!g) return null;
    // distinct source materials of the glb
    const srcMats = new Set<THREE.Material>();
    g.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (m) (Array.isArray(m) ? m : [m]).forEach((x) => srcMats.add(x));
    });
    // texture resolution per glTF material: manifest mainMaterial/tex (design textures) > manifest materials[] by name
    // > texture names in the glTF extras > manifest tex for single-material models
    const byName = new Map((def.materials ?? []).map((m) => [m.name, m]));
    const built = new Map<THREE.Material, THREE.Material>();
    await Promise.all([...srcMats].map(async (src) => {
      const ex = src.userData ?? {};
      const names = ex.tex as Record<string, string> | undefined;
      const entry = byName.get(src.name);
      const isMain = def.mainMaterial ? src.name === def.mainMaterial : srcMats.size <= 1;
      const tex: TexSet | undefined = (isMain && def.tex?.diffuse ? def.tex : undefined)
        ?? (entry?.tex?.diffuse ? entry.tex : undefined)
        ?? (names?.diffuse ? Object.fromEntries(Object.entries(names).map(([k, v]) => [k, `tex/${v}_${k}.webp`])) as TexSet : undefined)
        ?? (srcMats.size <= 1 ? def.tex : undefined);
      const shader = String(entry?.shader ?? ex.shader ?? '').toLowerCase();
      const additive = /additive|particle|unlit_?trans/.test(shader);
      const masked = /masked|cutout|alpha/.test(shader);
      const cullOff = /culloff|doublesided/.test(shader);
      let mat: THREE.Material | null = null;
      if (additive && tex?.diffuse) {
        const map = await this.texture(tex.diffuse, 'diffuse', def.flipY ?? false);
        mat = new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
      } else {
        mat = await this.materialFor({ ...def, tex: masked || tex?.alpha ? tex : tex && { ...tex, alpha: undefined }, rim: rim ?? undefined },
          def.doubleSided ?? (cullOff || (src as THREE.MeshStandardMaterial).side === THREE.DoubleSide));
      }
      if (!mat) {
        const s0 = src as THREE.MeshStandardMaterial;
        mat = makeDoMaterial({ map: s0.map ?? null, normalMap: s0.normalMap ?? null, glowMap: s0.emissiveMap ?? null, rim, color: s0.map ? 0xffffff : s0.color ?? 0x9aa4b4 });
      }
      built.set(src, mat);
    }));
    let skinned = false;
    g.scene.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned = true; });
    const raw = skinned ? cloneSkinned(g.scene) : g.scene.clone(true);
    raw.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.material = Array.isArray(m.material) ? m.material.map((x) => built.get(x) ?? x) : built.get(m.material) ?? m.material;
      m.frustumCulled = true;
    });
    const rot = ROT_FIX[String((def as { geometry?: unknown }).geometry ?? '')] ?? def.rot;
    if (rot) raw.rotation.set(rot[0] ?? 0, rot[1] ?? 0, rot[2] ?? 0);
    const fwd = new THREE.Group();
    fwd.add(raw);
    fwd.rotation.y = forwardYaw(forward);
    const wrap = new THREE.Group();
    wrap.add(fwd);
    wrap.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(wrap);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const horiz = Math.max(size.x, size.z, 1e-6);
    let s = def.scale ?? 1;
    if (targetLen) s = targetLen / horiz;
    // wrap -> [scaled] -> fwd ; centre the model on the origin
    const inner = new THREE.Group();
    inner.add(fwd);
    // models-agent glbs keep their pivot (= gameplay position); only normalised fallbacks are centred
    if (!def.noCenter && !def.bounds && targetLen) fwd.position.sub(center);
    inner.scale.setScalar(s);
    const root = new THREE.Group();
    root.add(inner);
    root.updateMatrixWorld(true);
    const laserPoints: THREE.Vector3[] = [];
    const engines: THREE.Vector3[] = [];
    const trails: THREE.Vector3[] = [];
    root.traverse((o) => {
      const n = o.name.toLowerCase();
      if (!n) return;
      if (/^laser_?point/.test(n) || /^laser\d/.test(n)) laserPoints.push(o.getWorldPosition(new THREE.Vector3()));
      else if (/^engine(_?\d+)?$/.test(n)) engines.push(o.getWorldPosition(new THREE.Vector3()));
      else if (/^enginetrail/.test(n)) trails.push(o.getWorldPosition(new THREE.Vector3()));
    });
    const len = horiz * s;
    // EngineTrail child nodes (18 units behind engine_N) are where the Unity TrailRenderer starts
    return { skinned, engines: trails.length ? trails : engines, root, length: len, radius: Math.max(size.x, size.z) * s * 0.5, height: size.y * s, laserPoints };
  }

  clearTemplates(): void {
    this.templates.clear();
    this.ready.clear();
  }
}

export function forwardYaw(forward: string): number {
  switch (forward) {
    case '-x': return Math.PI;
    case '+z': case 'z': return Math.PI / 2;
    case '-z': return -Math.PI / 2;
    default: return 0;
  }
}

/** Clone sharing geometry/materials. */
export function instantiate(t: ModelTemplate): THREE.Object3D {
  // skinned meshes (40 models, rest pose) need their skeleton re-bound on clone
  return t.skinned ? cloneSkinned(t.root) : t.root.clone(true);
}
