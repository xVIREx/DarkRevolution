// Item catalog for the HUD: names + icons for ammo, rockets and equipment (/data/items.json).
import { iconUrl, ui } from './ui';

export interface ItemDef {
  id: string;
  name: string;
  damage?: number;
  shield?: number;
  absorb?: number;
  speed?: number;
  slots?: number;
  repair?: number;
  desc?: string;
  [k: string]: unknown;
}

export interface ItemsData {
  lasers: ItemDef[];
  shieldGens: ItemDef[];
  speedGens: ItemDef[];
  extras: ItemDef[];
  drones: ItemDef[];
  droneDesigns: ItemDef[];
  formations?: ItemDef[];
  boosters?: ItemDef[];
  maxDrones?: number;
}

export type EquipKind = 'laser' | 'shield' | 'speed' | 'extra' | 'drone' | 'design' | 'formation' | 'booster';

const FALLBACK: ItemsData = {
  lasers: [
    { id: 'lf1', name: 'LF-1', damage: 40 }, { id: 'mp1', name: 'MP-1', damage: 60 }, { id: 'lf2', name: 'LF-2', damage: 100 },
    { id: 'lf3', name: 'LF-3', damage: 150 }, { id: 'lf4', name: 'LF-4', damage: 200 }, { id: 'prometheus', name: 'Prometheus', damage: 210 },
  ],
  shieldGens: [
    { id: 'sg3n-a01', name: 'SG3N-A01', shield: 1000, absorb: 0.4 }, { id: 'sg3n-a02', name: 'SG3N-A02', shield: 2000, absorb: 0.5 },
    { id: 'sg3n-a03', name: 'SG3N-A03', shield: 5000, absorb: 0.6 }, { id: 'sg3n-b01', name: 'SG3N-B01', shield: 4000, absorb: 0.7 },
    { id: 'sg3n-b02', name: 'SG3N-B02', shield: 10000, absorb: 0.8 },
  ],
  speedGens: [
    { id: 'g3n-1010', name: 'G3N-1010', speed: 2 }, { id: 'g3n-2010', name: 'G3N-2010', speed: 3 }, { id: 'g3n-3210', name: 'G3N-3210', speed: 4 },
    { id: 'g3n-3310', name: 'G3N-3310', speed: 5 }, { id: 'g3n-6900', name: 'G3N-6900', speed: 7 }, { id: 'g3n-7900', name: 'G3N-7900', speed: 10 },
  ],
  extras: [{ id: 'rep-4', name: 'REP-4' }, { id: 'aim-02', name: 'AIM-02' }, { id: 'arol-x', name: 'AROL-X' }],
  drones: [{ id: 'flax', name: 'Flax', slots: 1 }, { id: 'iris', name: 'Iris', slots: 2 }, { id: 'apis', name: 'Apis', slots: 2 }, { id: 'zeus', name: 'Zeus', slots: 2 }],
  droneDesigns: [{ id: 'havoc', name: 'Havoc' }, { id: 'hercules', name: 'Hercules' }],
  maxDrones: 10,
};

export let ITEMS: ItemsData = FALLBACK;
let loaded: Promise<ItemsData> | null = null;
const byId = new Map<string, { def: ItemDef; kind: EquipKind }>();

function index(): void {
  byId.clear();
  const add = (l: ItemDef[] | undefined, kind: EquipKind) => { for (const d of l ?? []) byId.set(d.id, { def: d, kind }); };
  add(ITEMS.lasers, 'laser'); add(ITEMS.shieldGens, 'shield'); add(ITEMS.speedGens, 'speed');
  add(ITEMS.extras, 'extra'); add(ITEMS.drones, 'drone'); add(ITEMS.droneDesigns, 'design');
  add(ITEMS.formations, 'formation'); add(ITEMS.boosters, 'booster');
}
index();

export function loadItems(): Promise<ItemsData> {
  if (!loaded) {
    loaded = fetch('/data/items.json', { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Partial<ItemsData> | null) => {
        if (d && Array.isArray(d.lasers)) {
          ITEMS = { ...FALLBACK, ...d } as ItemsData;
          for (const k of ['formations', 'boosters'] as const) {
            const v = (d as Record<string, unknown>)[k];
            if (v && !Array.isArray(v) && typeof v === 'object') ITEMS[k] = Object.entries(v as Record<string, ItemDef>).map(([id, x]) => ({ ...x, id: x.id ?? id, name: x.name ?? id }));
            else if (!Array.isArray(v)) ITEMS[k] = undefined;
          }
          index();
        }
        return ITEMS;
      })
      .catch(() => ITEMS);
  }
  return loaded;
}

export function itemInfo(id: string): { def: ItemDef; kind: EquipKind } | undefined {
  return byId.get(id);
}

// ---------------------------------------------------------------- action bar items

/** Slot-bar icon of laser ammo / rockets (itemControlmenu sprites, with the x1..x4 badges). */
const BAR_ICON: Record<string, string> = {
  x1: 'ammunition_laser_lcb-10', x2: 'ammunition_laser_mcb-25', x3: 'ammunition_laser_mcb-50', x4: 'ammunition_laser_ucb-100',
  sab: 'ammunition_laser_sab-50', rsb: 'ammunition_laser_rsb-75',
  cbo: 'ammunition_laser_cbo-100', abl: 'ammunition_laser_a-bl', pib: 'ammunition_laser_pib-100', idb: 'ammunition_laser_idb-125',
  job: 'ammunition_laser_job-100', rb214: 'ammunition_laser_rb-214', rcb: 'ammunition_laser_rcb-140', sbl: 'ammunition_laser_sbl-100',
  vb: 'ammunition_laser_vb-142', emaa: 'ammunition_laser_emaa-20',
  r310: 'ammunition_rocket_r-310', plt2026: 'ammunition_rocket_plt-2026', plt2021: 'ammunition_rocket_plt-2021', plt3030: 'ammunition_rocket_plt-3030',
};
export const AMMO_NAMES: Record<string, string> = {
  x1: 'LCB-10', x2: 'MCB-25', x3: 'MCB-50', x4: 'UCB-100', sab: 'SAB-50', rsb: 'RSB-75',
  r310: 'R-310', plt2026: 'PLT-2026', plt2021: 'PLT-2021', plt3030: 'PLT-3030',
};

/** laser ammo icon names present in assets/ui/bar (itemControlmenu) */
const LASER_ICONS = new Set(['a-bl', 'cbo-100', 'emaa-20', 'idb-125', 'job-100', 'lcb-10', 'mcb-25', 'mcb-50', 'pib-100', 'rb-214', 'rcb-140',
  'rsb-75', 'sab-50', 'sbl-100', 'ucb-100', 'vb-142']);

/** Register ammo / rocket defs from lasers.json so names + icons resolve for new ammo ids. */
export function registerAmmo(defs: { id: string; name?: string }[], kind: 'laser' | 'rocket'): void {
  for (const d of defs) {
    if (d.name) AMMO_NAMES[d.id] ??= d.name;
    if (BAR_ICON[d.id]) continue;
    const n = (d.name ?? d.id).toLowerCase().replace(/\s+/g, '-');
    const cands = [n, n.replace(/-?(\d+)$/, '-$1'), d.id];
    for (const c of cands) {
      if (kind === 'laser' && LASER_ICONS.has(c)) { BAR_ICON[d.id] = `ammunition_laser_${c}`; break; }
      if (kind === 'rocket') { BAR_ICON[d.id] = `ammunition_rocket_${n}`; break; }
    }
  }
}

/** Drone formation id -> itemControlmenu icon. */
const FORMATION_ICON: Record<string, string> = {
  standard: 'default', default: 'default', turtle: 'f-01-tu', arrow: 'f-02-ar', lance: 'f-03-la', star: 'f-04-st', pincer: 'f-05-pi',
  double_arrow: 'f-06-da', doublearrow: 'f-06-da', diamond: 'f-07-di', chevron: 'f-08-ch', moth: 'f-09-mo', crab: 'f-10-cr', heart: 'f-11-he',
  barrage: 'f-12-ba', bat: 'f-13-bt', dome: 'f-3d-dm', drill: 'f-3d-dr', ring: 'f-3d-rg', veteran: 'f-3d-vt', wheel: 'f-3d-wl', wave: 'f-3d-wv', x: 'f-3d-x',
};
export const DEFAULT_FORMATIONS = ['standard', 'turtle', 'arrow', 'lance', 'star', 'pincer', 'double_arrow', 'diamond', 'chevron', 'moth', 'crab',
  'heart', 'barrage', 'bat', 'dome', 'drill', 'ring', 'veteran', 'wheel', 'wave'];
export function formationIcon(id: string): string {
  const k = id.toLowerCase().replace(/^(formation[_-]|drone_formation_|f[_-])/, '').replace(/-/g, '_');
  const f = FORMATION_ICON[k] ?? (k.startsWith('f-') ? k : 'default');
  return ui(`bar/drone_formation_${f}`);
}
export function isFormation(id: string): boolean {
  return itemInfo(id)?.kind === 'formation' || id.toLowerCase().replace(/^formation[_-]/, '') in FORMATION_ICON;
}

/** Booster icon: items/<id>.png when extracted, else a keyword match on the Booster atlas. */
export function boosterIcon(id: string, icon?: string): string {
  const k = (icon || id).toLowerCase();
  if (/^[a-z]+-b0\d$/.test(k)) return iconUrl(k);
  if (/dmg|damage|dam/.test(k)) return iconUrl('dmg-b01');
  if (/shd|shield/.test(k)) return iconUrl('shd-b01');
  if (/hp|hit|hull/.test(k)) return iconUrl('hp-b01');
  if (/rep|repair/.test(k)) return iconUrl('rep-b01');
  if (/hon/.test(k)) return iconUrl('hon-b01');
  if (/ep|exp|xp/.test(k)) return iconUrl('ep-b01');
  if (/res|ore|cargo/.test(k)) return iconUrl('res-b01');
  if (/speed|spd/.test(k)) return ui('boost/speed_100x100');
  return ui('boost/damage_100x100');
}

export function barIcon(id: string): string {
  const b = BAR_ICON[id];
  if (b) return ui(`bar/${b}`);
  if (isFormation(id)) return formationIcon(id);
  return iconUrl(`${id}_30`);
}

export function itemName(id: string): string {
  return AMMO_NAMES[id] ?? byId.get(id)?.def.name ?? id.toUpperCase();
}

/** Short stat line for tooltips. */
export function itemStat(id: string): string {
  const i = byId.get(id);
  if (!i) return '';
  const d = i.def;
  switch (i.kind) {
    case 'laser': return `Damage ${d.damage ?? '?'}`;
    case 'shield': return `Shield ${d.shield ?? '?'} · absorb ${Math.round((d.absorb ?? 0) * 100)}%`;
    case 'speed': return `Speed +${d.speed ?? '?'}`;
    case 'drone': return `${d.slots ?? 1} slot(s)`;
    case 'formation': case 'booster': return String(d.desc ?? d.effect ?? '');
    default: return String(d.desc ?? '');
  }
}
