import type { EntId, EntSnap, Faction, MapDef, YouMsg } from './types';

/** Things HUD/input can ask the game to do. */
export interface Actions {
  moveTo(x: number, y: number): void;
  select(id: EntId | null): void;
  toggleAttack(): void;
  setAmmo(id: string): void;
  setRocket(id: string): void;
  fireRocket(): void;
  jump(): void;
  /** instant warp to any map (`warp`, jump CPU) */
  warp(mapId: number): void;
  toggleWarp(): void;
  revive(): void;
  chat(text: string): void;
  toggleHangar(): void;
  setShip(ship: string, design?: string): void;
  setConfig(speedGens: number): void;
  setCheat(god: boolean, dmgMult: number): void;
  /** start lasers on the selected target (no-op if already attacking; logs if no target) */
  startAttack(): void;
  isAttacking(): boolean;
  /** send an `equip` message (CONTRACT.md) */
  equip(m: EquipMsg): void;
  /** switch active config (`cfg`); without n toggles 1 <-> 2 */
  switchConfig(n?: 1 | 2): void;
  /** send any additive protocol message (upgrade / formation / booster ...) as-is */
  sendRaw(msg: { t: string; [k: string]: unknown }): void;
}

export interface DroneCfg { type: string; items: string[] }
export interface EquipConfig { lasers: string[]; gens: string[]; extras: string[]; drones: DroneCfg[]; droneDesign?: string | null }
/** config as sent by the server: items may carry upgrade levels ({id, lvl}) or parallel lvls arrays */
export type RawItem = string | { id: string; lvl?: number; level?: number };
export interface RawConfig {
  lasers?: RawItem[]; gens?: RawItem[]; extras?: RawItem[];
  drones?: { type: RawItem; items?: RawItem[]; lvl?: number; level?: number; lvls?: number[] }[];
  droneDesign?: string | null;
  [k: string]: unknown;
}
export interface EquipMsg extends Partial<EquipConfig> { config: 1 | 2 }
/** `you` fields added by the equipment system (CONTRACT.md). */
export interface EquipYou {
  cfg?: 1 | 2;
  cfgCd?: number;
  configs?: RawConfig[];
  slots?: { lasers: number; gens: number; extras: number; drones: number };
  formation?: string | null;
  boosters?: unknown;
  stats?: { damageBreakdown?: unknown; damage: number; shield: number; absorb: number; speed: number; hp?: number; repair?: number; missMult?: number; autoRocket?: boolean };
}

/** Read-only view of game state for the HUD. */
export interface GameState {
  name: string;
  faction: Faction;
  you: YouMsg | null;
  map: MapDef | null;
  me: EntSnap | null;
  target: EntSnap | null;
  attacking: boolean;
  ammo: string;
  rocket: string;
  rocketReadyAt: number;
  ents: Iterable<{ snap: EntSnap; x: number; y: number }>;
  myId: string | null;
  selectedId: string | null;
}
