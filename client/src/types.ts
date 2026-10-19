// Shared types mirroring CONTRACT.md

export type Faction = 'mmo' | 'eic' | 'vru';

export interface SheetInfo {
  url: string;
  frames: number;
  cols: number;
  cw: number;
  ch: number;
  fps?: number;
}

export interface Manifest {
  sheets: Record<string, SheetInfo>;
  rotation: { frame0: number; dir: number };
  backgrounds: Record<string, string>;
  planets: Record<string, string>;
  lasers: Record<string, string>;
  rockets: Record<string, string>;
  portal?: SheetInfo;
  stations: Record<string, string>;
  explosion?: SheetInfo;
  box: Record<string, string>;
  minimaps: Record<string, string>;
}

export interface ShipDesign {
  id: string;
  name: string;
  sheet: string;
}

export interface ShipDef {
  id: string;
  name: string;
  hp: number;
  speed: number;
  lasers: number;
  generators: number;
  extras: number;
  cargo: number;
  sheet: string;
  designs: ShipDesign[];
  /** stats were guessed by the data agent */
  guess?: boolean;
}

export interface AmmoDef {
  id: string;
  name: string;
  mult: number;
  color: string;
}

export interface LasersData {
  ammo: AmmoDef[];
  laserDamage: number;
  rockets: { id: string; damage: number; name?: string }[];
}

export interface MapPlanet { type: string; x: number; y: number; p: number }
export interface MapPortal { id: number; x: number; y: number; to: number; tx?: number; ty?: number }
export interface MapStation { faction: string; x: number; y: number }

export interface MapDef {
  id: number;
  name: string;
  faction?: string;
  w: number;
  h: number;
  background: string;
  /** "W,H" maps-config region space for planet coords (default 2048x1276 scaled to map size) */
  region?: string | null;
  minimap?: string;
  type?: string;
  planets?: MapPlanet[];
  portals?: MapPortal[];
  stations?: MapStation[];
}

export interface EntSnap {
  id: number | string;
  /** player / NPC / loot box (season) */
  k: 'p' | 'n' | 'b';
  n: string;
  s: string;
  x: number;
  y: number;
  a: number;
  hp: number;
  mhp: number;
  sh: number;
  msh: number;
  f?: string;
  tg: number | string | null;
  atk: boolean;
}

export interface YouMsg {
  ship: string;
  design?: string | null;
  speed: number;
  ammo: string;
  credits: number;
  uridium: number;
  exp: number;
  honor: number;
  level: number;
  god: boolean;
  dmgMult: number;
  speedGens: number;
  // server additions beyond CONTRACT.md
  id?: number | string;
  map?: number;
  rocket?: string;
  dead?: boolean;
  faction?: string;
  /** inside a portal/station DMZ and not shooting: aliens can't attack you */
  protected?: boolean;
  /** daily season state (absent in the free sandbox) */
  season?: SeasonYou;
}

export interface PilotStats {
  npcKills: number;
  pvpKills: number;
  deaths: number;
  earnedC: number;
  earnedU: number;
  bestKill: string;
  bestKillEp: number;
  online: number;
}

export interface SeasonYou {
  /** unix ms of the next 00:00 UTC reset */
  resetAt: number;
  /** reward bonus of your company (0.25 = +25%) */
  bonus: number;
  ships: string[];
  items: Record<string, number>;
  levels: Record<string, number>;
  unlocks: string[];
  ammo: Record<string, number>;
  pilot: PilotStats;
  rank: number;
  /** PvP impossible where you are (protected map / safe zone) */
  safe: boolean;
  /** upgrade options affordable right now (badge on the U button) */
  affordable?: number;
  roundMinutes?: number;
  /** maps the Jump CPU can reach (visited this round) */
  visited?: number[];
  /** seconds until the Jump CPU is ready */
  warpCd?: number;
}

export interface TopRow { n: string; f: string; lvl: number; ep: number; hon: number; k: number; pk: number; on: boolean }
export interface FactionRow { pilots: number; online: number; ep: number; bonus: number }
export interface UpgradeOption { cat: string; kind: string; id: string; label: string; desc: string; c: number; u: number; ok: boolean; dmg: number; shd: number; hp: number; spd: number; value: number }
export interface BeaconState { map: number; name: string; x: number; y: number; r: number; owner: string | null; side: string | null; cap: number; contested: boolean; weight: number }
export interface ObjMsg { beacons: BeaconState[]; score: Record<string, number>; lastWinner: string | null }
export interface TopMsg { rows: TopRow[]; factions: Record<string, FactionRow>; champions: TopRow[]; rank: number; pilots: number }

export type ServerMsg =
  | { t: 'welcome'; id: number | string }
  | { t: 'map'; map: MapDef }
  | { t: 'state'; tick: number; ents: EntSnap[] }
  | ({ t: 'you' } & YouMsg)
  | { t: 'shot'; from: number | string; to: number | string; kind: 'laser' | 'rocket'; ammo: string; dmg: number; shd: number; miss: boolean }
  | { t: 'boom'; id: number | string; x: number; y: number }
  | { t: 'dead'; by: string }
  | { t: 'log'; text: string }
  | { t: 'chat'; from: string; text: string }
  | ({ t: 'top' } & TopMsg)
  | { t: 'roundEnd'; rows: TopRow[]; rank: number; pilots: number; ep: number; company: string | null; scores: Record<string, number> }
  | ({ t: 'obj' } & ObjMsg)
  | { t: 'upgrades'; options: UpgradeOption[] }
  | { t: 'pickup'; x: number; y: number; by: number; cargo: boolean };

export type ClientMsg =
  | { t: 'login'; name: string; faction: Faction; token?: string }
  | { t: 'buy'; kind: string; id: string; qty?: number }
  | { t: 'autoequip' }
  | { t: 'move'; x: number; y: number }
  | { t: 'select'; id: number | string | null }
  | { t: 'attack'; on: boolean }
  | { t: 'ammo'; id: string }
  | { t: 'rocket'; id: string }
  | { t: 'ship'; ship: string; design?: string }
  | { t: 'config'; speedGens: number }
  | { t: 'jump' }
  | { t: 'warp'; map: number }
  | { t: 'revive' }
  | { t: 'cheat'; god: boolean; dmgMult: number }
  | { t: 'chat'; text: string };

export type EntId = number | string;

export const FACTION_COLORS: Record<string, string> = {
  mmo: '#ff5a4a',
  eic: '#4aa8ff',
  vru: '#5cff6a',
};

export const LASER_AMMO_IDS = ['x1', 'x2', 'x3', 'x4', 'sab', 'rsb'] as const;
export const DEFAULT_AMMO: AmmoDef[] = [
  { id: 'x1', name: 'LCB-10', mult: 1, color: 'red' },
  { id: 'x2', name: 'MCB-25', mult: 2, color: 'blue' },
  { id: 'x3', name: 'MCB-50', mult: 3, color: 'green' },
  { id: 'x4', name: 'UCB-100', mult: 4, color: 'white' },
  { id: 'sab', name: 'SAB-50', mult: 2, color: 'sab' },
  { id: 'rsb', name: 'RSB-75', mult: 6, color: 'rsb' },
];
export const DEFAULT_ROCKETS = [
  { id: 'r310', name: 'R-310', damage: 1000 },
  { id: 'plt2026', name: 'PLT-2026', damage: 2000 },
  { id: 'plt2021', name: 'PLT-2021', damage: 4000 },
];
