/**
 * manifest3d.json (models agent) + manifest3d.maps.json (scene agent), merged.
 * Both are optional; the loader polls for them and bumps `version` whenever the merged content changes,
 * so the renderer can rebuild models / the map scene without a reload.
 */

export interface TexSet { diffuse?: string; normal?: string; specular?: string; glow?: string; alpha?: string }
export interface RimDef { color?: string; strength?: number; power?: number }

export interface ModelDef {
  glb?: string;
  scale?: number;
  visualSize?: number;
  /** explicit length of the model in world units (overrides visualSize-based sizing) */
  size?: number;
  tex?: TexSet;
  rim?: RimDef;
  /** euler fix in radians applied to the raw model */
  rot?: [number, number, number];
  /** texture flipY (default false = glTF UV convention) */
  flipY?: boolean;
  /** specular shininess (Phong exponent) */
  shininess?: number;
  /** emissive (glow map) multiplier */
  glow?: number;
  forward?: string;
  /** keep the model pivot (scene props) instead of centring on the bounding box */
  noCenter?: boolean;
  mainMaterial?: string;
  materials?: { name: string; shader?: string; tex?: TexSet }[];
  /** raw glb bounds (models agent): the glb is already in world units, pivot = gameplay position */
  bounds?: { min: number[]; max: number[] };
  parts?: Record<string, ModelDef & { pos?: number[]; rotY?: number }>;
  doubleSided?: boolean;
}

export interface LightDef { color?: string; diffuse?: number; specular?: number; ambientColor?: string; ambient?: number; tilt?: number; pan?: number; /** light travel direction (three coords) */ dir?: number[] }
export interface SkyboxDef { stars?: string | string[]; nebula?: string | string[]; tint?: string; rot?: number }
export interface PlaneDef {
  tex: string; phi?: number; theta?: number; r?: number; scale?: number | number[]; rotX?: number; rotZ?: number;
  blend?: string; alpha?: boolean; x?: number; y?: number; z?: number; opacity?: number; color?: string;
  /** absolute position (three coords); overrides the spherical placement */
  pos?: number[];
  /** three.js quaternion (x,y,z,w) of a 1x1 XY quad (front +Z); used with `pos` */
  quat?: number[];
  aspect?: number; name?: string; texSize?: number[];
  uvRect?: number[]; backdrop?: boolean;
}
export interface AnimDef { node?: string; degPerSec?: boolean; x?: number[]; y?: number[]; z?: number[] }
export interface TileLayerDef {
  name?: string; atlas: string; atlasSize?: number[]; rects: number[][]; y?: number; blend?: string;
  tileFields?: string[]; tiles: number[][]; mapScale?: number;
}
export interface MeshDef {
  glb: string; tex?: TexSet; x?: number; y?: number; z?: number; scale?: number | number[]; rot?: [number, number, number];
  /** degrees per second around Y */
  spin?: number; rim?: RimDef; flipY?: boolean;
  name?: string; pos?: number[]; quat?: number[]; shader?: string;
  material?: { _Glossiness?: number; _GlowAmount?: number; _Alpha?: number; doubleSided?: boolean; alphaMask?: boolean };
  anim?: AnimDef[]; randomRotYDeg?: number[];
}
export interface FlareElementDef { image?: number; pos?: number; size?: number; color?: number[]; useLightColor?: boolean; rotate?: boolean }
export interface FlareDef {
  x?: number; y?: number; z?: number; type?: number; color?: string; size?: number; textures?: { tex: string; size?: number; distance?: number; color?: string }[];
  pos?: number[]; quat?: number[]; scale?: number[]; sprite?: string; spriteSize?: number[]; blend?: string;
  backdrop?: boolean; name?: string;
  flare?: { texture?: string; layout?: number; color?: number[]; brightness?: number; elements?: FlareElementDef[] };
}
export interface StarfieldDef { color?: string; count?: number; size?: number; tex?: string; emitter?: { tex?: string; maxParticles?: number; colorOverLife?: { gradient?: { color?: number[][] } } } }
export interface MapScene3D {
  light?: LightDef;
  skybox?: SkyboxDef;
  planes?: PlaneDef[];
  meshes?: MeshDef[];
  lensflares?: FlareDef[];
  starfield?: StarfieldDef;
  /** center of the background sphere in three coords (default: map center) */
  center?: [number, number, number];
  fog?: { color?: string; near?: number; far?: number };
  backgrounds?: PlaneDef[];
  tileLayers?: TileLayerDef[];
  starfieldType?: string;
  backdrop?: { pivot?: number[]; fitScale?: number; follow?: number; members?: string[] };
  unityMapSize?: number[];
}
export interface CameraDef { fov?: number; pitch?: number; pitchDeg?: number; distance?: number; near?: number; far?: number; minZoom?: number; maxZoom?: number; follow?: number; clearColor?: string }
export interface SheetLike { url: string; frames: number; cols: number; cw: number; ch: number; fps?: number }
export interface TrailDef { tex?: string; width?: number; time?: number; color?: string }
export interface RocketDef extends ModelDef { trail?: TrailDef; tex2d?: string; speed?: number }

export interface Manifest3D {
  forward?: string;
  models: Record<string, ModelDef>;
  maps: Record<string, MapScene3D>;
  stations: Record<string, ModelDef>;
  portal?: ModelDef;
  box?: ModelDef;
  lasers: Record<string, string | { tex: string; width?: number; length?: number; color?: string; size?: number[]; pivot?: number[] }>;
  fx: { engineTrail?: string; explosion?: string | SheetLike; shieldHit?: string; engineGlow?: string; [k: string]: unknown };
  rockets: Record<string, RocketDef> & { impact?: unknown };
  camera?: CameraDef;
  default?: MapScene3D;
}

const EMPTY: Manifest3D = { models: {}, maps: {}, stations: {}, lasers: {}, fx: {}, rockets: {} as Manifest3D['rockets'] };

export const ASSET3D_BASE = '/assets3d/';

export function url3d(rel: string | undefined | null): string | null {
  if (!rel) return null;
  if (/^(https?:)?\/\//.test(rel) || rel.startsWith('/') || rel.startsWith('data:')) return rel;
  return ASSET3D_BASE + rel.replace(/^\.?\//, '');
}

async function fetchText(u: string): Promise<string | null> {
  try {
    const r = await fetch(u, { cache: 'no-cache' });
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') ?? '';
    const t = await r.text();
    // SPA fallbacks may answer with index.html
    if (ct.includes('text/html') || t.trimStart().startsWith('<')) return null;
    return t;
  } catch {
    return null;
  }
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export class Manifest3DLoader {
  data: Manifest3D = EMPTY;
  version = 0;
  modelsOk = false;
  mapsOk = false;
  private lastKey = '';
  private timer = 0;

  async init(): Promise<void> {
    await this.poll();
    this.schedule();
  }

  private schedule(): void {
    window.clearTimeout(this.timer);
    // poll quickly while something is missing (agents are still producing assets), slowly otherwise
    const ms = this.modelsOk && this.mapsOk ? 30000 : 8000;
    this.timer = window.setTimeout(() => void this.poll().finally(() => this.schedule()), ms);
  }

  private async poll(): Promise<void> {
    const [a, b] = await Promise.all([fetchText(ASSET3D_BASE + 'manifest3d.json'), fetchText(ASSET3D_BASE + 'manifest3d.maps.json')]);
    const key = `${a ?? ''}\u0000${b ?? ''}`;
    if (key === this.lastKey) return;
    let ma: Record<string, unknown> = {};
    let mb: Record<string, unknown> = {};
    try { if (a) ma = obj(JSON.parse(a)); } catch (e) { console.warn('manifest3d.json parse error', e); return; }
    try { if (b) mb = obj(JSON.parse(b)); } catch (e) { console.warn('manifest3d.maps.json parse error', e); return; }
    this.lastKey = key;
    this.modelsOk = !!a;
    this.mapsOk = !!b;
    const merged: Manifest3D = {
      ...EMPTY,
      ...ma,
      ...mb,
      models: { ...obj(ma.models), ...obj(mb.models) } as Record<string, ModelDef>,
      maps: { ...obj(ma.maps), ...obj(mb.maps) } as Record<string, MapScene3D>,
      stations: { ...obj(ma.stations), ...obj(mb.stations) } as Record<string, ModelDef>,
      lasers: { ...obj(ma.lasers), ...obj(mb.lasers) } as Manifest3D['lasers'],
      fx: { ...obj(ma.fx), ...obj(mb.fx) } as Manifest3D['fx'],
      rockets: { ...obj(ma.rockets), ...obj(mb.rockets) } as Manifest3D['rockets'],
      forward: (ma.forward as string | undefined) ?? (mb.forward as string | undefined) ?? '+x',
      portal: (ma.portal ?? mb.portal) as ModelDef | undefined,
      box: (ma.box ?? mb.box) as ModelDef | undefined,
      camera: { ...obj(ma.camera), ...obj(mb.camera) } as CameraDef,
    };
    this.data = merged;
    this.version++;
    if (this.version > 1) console.info('[render3d] manifest3d updated', { models: Object.keys(merged.models).length, maps: Object.keys(merged.maps).length });
  }

  /** model for a 2D sheet id with fallbacks: exact → lower-case → base ship (strip design suffix). */
  model(sheet: string | undefined | null): ModelDef | null {
    if (!sheet) return null;
    const m = this.data.models;
    const ok = (d: ModelDef | undefined) => (d && d.glb ? d : null);
    const cands = [sheet, sheet.toLowerCase()];
    const dash = sheet.indexOf('-');
    if (dash > 0) cands.push(sheet.slice(0, dash));
    for (const c of cands) {
      const d = ok(m[c]);
      if (d) return d;
    }
    return null;
  }

  mapScene(id: number | string): MapScene3D | null {
    return this.data.maps[String(id)] ?? this.data.default ?? null;
  }
}
