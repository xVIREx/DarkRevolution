import type { Actions, DroneCfg, EquipConfig, EquipYou, RawConfig, RawItem } from '../actions';
import type { ShipDef, YouMsg } from '../types';
import { el, esc, fmt } from './dom';
import { boosterIcon, DEFAULT_FORMATIONS, formationIcon, ITEMS, itemInfo, itemName, itemStat, loadItems, type EquipKind, type ItemDef } from './items';
import { button, iconUrl } from './ui';
import { fmtBig, priceHtml, SHOP, unlocked, upgradeCost } from './season';

/**
 * DarkOrbit-style Equipment panel (hangar tab): Config 1/2, ship slot rows (lasers,
 * generators, extras), drone bar with per-drone slots + drone design, and an infinite
 * inventory. Drag & drop inventory -> slot, double-click to equip, right-click or drag a
 * slot item out to unequip. Changes are sent as `equip` (CONTRACT.md); stats come from you.stats.
 */
type Zone = 'lasers' | 'gens' | 'extras' | 'drone' | 'dronetype' | 'design';
interface Src { zone: Zone; i: number; j?: number }
const ACCEPT: Record<Zone, EquipKind[]> = {
  lasers: ['laser'], gens: ['shield', 'speed'], extras: ['extra'], drone: ['laser', 'shield'], dronetype: ['drone'], design: ['design'],
};
const FILTERS: { id: string; label: string; kinds: EquipKind[] }[] = [
  { id: 'all', label: 'All', kinds: ['laser', 'shield', 'speed', 'extra', 'drone', 'design'] },
  { id: 'lasers', label: 'Lasers', kinds: ['laser'] },
  { id: 'gens', label: 'Generators', kinds: ['shield', 'speed'] },
  { id: 'extras', label: 'Extras', kinds: ['extra'] },
  { id: 'drones', label: 'Drones', kinds: ['drone', 'design'] },
];
const EDIT_HOLD_MS = 1500;

type You = YouMsg & EquipYou;

const emptyCfg = (): EquipConfig => ({ lasers: [], gens: [], extras: [], drones: [], droneDesign: null });
const MAX_LVL = 16;
/** highest upgrade level any item has (LF-5: 20); the server clamps each item to its own max */
const MAX_ANY = 20;

/** Upgrade cap of an equipped item: speed gens can't be upgraded (0), LF-5 goes to 20, the rest 16. */
function itemMaxLevel(id: string, target: 'laser' | 'gen' | 'drone'): number {
  if (target === 'drone') return MAX_LVL;
  const info = itemInfo(id);
  if (info?.kind === 'speed') return 0;
  return Number(info?.def.maxLevel) || MAX_LVL;
}
/** upgrade levels parallel to an EquipConfig: lasers[i], gens[i], drones[i] (drone level) */
interface Lv { lasers: number[]; gens: number[]; drones: number[] }
const emptyLv = (): Lv => ({ lasers: [], gens: [], drones: [] });
const rid = (x: RawItem | undefined): string => (typeof x === 'string' ? x : x?.id ?? '');
const rlv = (x: RawItem | undefined): number | undefined => (x && typeof x === 'object' ? x.lvl ?? x.level : undefined);
function parallel(c: RawConfig, key: 'lasers' | 'gens' | 'drones'): number[] | undefined {
  const one = key.slice(0, -1);
  const l = c.lvls as Record<string, unknown> | undefined;
  const cands = [l?.[key], l?.[one], c[`${one}Lvls`], c[`${key}Lvls`], c[`${key}_lvls`], c[`${one}_lvls`]];
  return cands.find(Array.isArray) as number[] | undefined;
}
/** server config (string ids or {id,lvl}) -> plain ids + level arrays */
function normalize(c: RawConfig | undefined): { cfg: EquipConfig; lv: Lv } {
  if (!c) return { cfg: emptyCfg(), lv: emptyLv() };
  const ids = (a: RawItem[] | undefined) => (a ?? []).map(rid).filter(Boolean);
  const lvs = (a: RawItem[] | undefined, key: 'lasers' | 'gens') => {
    const p = parallel(c, key);
    return (a ?? []).map((x, i) => rlv(x) ?? Number(p?.[i] ?? 0) ?? 0);
  };
  const pd = parallel(c, 'drones');
  const drones = (c.drones ?? []).map((d) => ({ type: rid(d.type), items: ids(d.items) }));
  const droneLv = (c.drones ?? []).map((d, i) => {
    const own = d.lvl ?? d.level ?? rlv(d.type) ?? pd?.[i];
    if (own !== undefined) return Number(own) || 0;
    const items = (d.items ?? []).map((x, j) => rlv(x) ?? d.lvls?.[j] ?? 0);
    return items.length ? Math.max(...items.map(Number)) : 0;
  });
  return {
    cfg: { lasers: ids(c.lasers), gens: ids(c.gens), extras: ids(c.extras), drones, droneDesign: c.droneDesign ?? null },
    lv: { lasers: lvs(c.lasers, 'lasers'), gens: lvs(c.gens, 'gens'), drones: droneLv },
  };
}
const clone = (c: EquipConfig): EquipConfig => ({
  lasers: [...(c.lasers ?? [])], gens: [...(c.gens ?? [])], extras: [...(c.extras ?? [])],
  drones: (c.drones ?? []).map((d) => ({ type: d.type, items: [...(d.items ?? [])] })), droneDesign: c.droneDesign ?? null,
});

export class EquipmentPanel {
  private you: You | null = null;
  private cfgs: EquipConfig[] = [emptyCfg(), emptyCfg()];
  private lvs: Lv[] = [emptyLv(), emptyLv()];
  private lvEditedAt = 0;
  private extraEl: HTMLDivElement;
  private bdEl: HTMLDivElement;
  private fxEditedAt = 0;
  private formationLocal: string | null = null;
  private boostLocal: Record<string, boolean> = {};
  private edit: 0 | 1 = 0;
  private editedAt = 0;
  private filter = 'all';
  private top: HTMLDivElement;
  private shipEl: HTMLDivElement;
  private droneEl: HTMLDivElement;
  private invEl: HTMLDivElement;
  private statsEl: HTMLDivElement;
  private tabEls: HTMLDivElement[] = [];
  private activeEl: HTMLSpanElement;
  private activateBtn: HTMLButtonElement;
  private sig = '';

  constructor(parent: HTMLElement, private readonly actions: Actions, private readonly ship: () => ShipDef | undefined, private readonly season = false) {
    const root = el('div', 'eq', undefined, parent);
    this.top = el('div', 'eq-top', undefined, root);
    for (const n of [0, 1] as const) {
      const t = el('div', 'eq-cfgtab', `Config ${n + 1}`, this.top);
      t.addEventListener('click', () => { this.edit = n; this.render(); });
      this.tabEls.push(t);
    }
    this.activeEl = el('span', 'eq-active', '', this.top);
    this.activateBtn = button('Activate [C]', this.top, 'green', () => this.actions.switchConfig((this.edit + 1) as 1 | 2));
    el('span', 'eq-sp', '', this.top);
    if (season) {
      button('Auto-equip best', this.top, 'blue', () => this.actions.sendRaw({ t: 'autoequip' }));
      button('Unequip all', this.top, 'red', () => this.apply(emptyCfg()));
    } else {
      button('Auto-equip best', this.top, 'blue', () => this.quick('best'));
      button('All shields', this.top, 'blue', () => this.quick('shield'));
      button('All speed', this.top, 'blue', () => this.quick('speed'));
      button('Unequip all', this.top, 'red', () => this.apply(emptyCfg()));
      button('Upgrade all to max', this.top, 'green', () => this.upgradeAll(MAX_ANY));
    }

    const main = el('div', 'eq-main', undefined, root);
    const left = el('div', 'eq-left', undefined, main);
    this.statsEl = el('div', 'eq-stats', '', left);
    this.shipEl = el('div', 'eq-ship', '', left);
    this.bdEl = el('div', 'eq-breakdown', '', left);
    this.droneEl = el('div', 'eq-drones', '', left);
    this.extraEl = el('div', 'eq-extra', '', left);
    const right = el('div', 'eq-inv', undefined, main);
    const ft = el('div', 'eq-filters', undefined, right);
    for (const f of FILTERS) {
      const b = el('div', `eq-filter${f.id === this.filter ? ' on' : ''}`, f.label, ft);
      b.addEventListener('click', () => {
        this.filter = f.id;
        ft.querySelectorAll('.eq-filter').forEach((x) => x.classList.toggle('on', x === b));
        this.renderInv();
      });
    }
    this.invEl = el('div', 'eq-items', '', right);
    el('div', 'hint', season
      ? 'Your items (free / owned) · drag onto slots or double-click to equip · right-click / drag out to unequip · buy more in the Shop'
      : 'Drag items onto slots or double-click to equip · right-click / drag out to unequip · everything is free (∞)', right);

    // drop outside any slot = unequip
    root.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('x-do-eqsrc')) e.preventDefault(); });
    root.addEventListener('drop', (e) => {
      const src = e.dataTransfer?.getData('x-do-eqsrc');
      if (src && !(e.target as HTMLElement).closest('.eq-slot')) {
        e.preventDefault();
        this.remove(JSON.parse(src) as Src);
      }
    });
    void loadItems().then(() => { this.sig = ''; this.render(); });
  }

  setYou(y: YouMsg): void {
    const you = y as You;
    this.you = you;
    const now = performance.now();
    if (Array.isArray(you.configs)) {
      const n = [normalize(you.configs[0]), normalize(you.configs[1])];
      if (now - this.editedAt > EDIT_HOLD_MS) this.cfgs = n.map((x) => x.cfg);
      if (now - this.lvEditedAt > EDIT_HOLD_MS && now - this.editedAt > EDIT_HOLD_MS) this.lvs = n.map((x) => x.lv);
    }
    if (now - this.fxEditedAt > EDIT_HOLD_MS) {
      // the server sends these inside `stats` (CONTRACT.md); accept top-level too
      const st = you.stats as { formation?: unknown; boosters?: unknown } | undefined;
      const formation = you.formation ?? st?.formation;
      this.formationLocal = typeof formation === 'string' ? formation : null;
      this.boostLocal = parseBoosters(you.boosters ?? st?.boosters);
    }
    if (this.sigOf() !== this.sig) this.render();
  }

  private sigOf(): string {
    const y = this.you;
    return JSON.stringify([this.cfgs, this.lvs, this.formationLocal, this.boostLocal, y?.cfg, y?.slots, y?.stats, Math.ceil(y?.cfgCd ?? 0), y?.ship,
      y?.season?.items, y?.season?.unlocks, y?.season?.levels]);
  }

  // ------------------------------------------------------------ upgrades / formations / boosters
  private setLevel(target: 'laser' | 'gen' | 'drone', slot: number | 'all', level: number): void {
    if (this.season) {
      // season: upgrades are bought per item type (Shop > Upgrades); +1 from the badge
      const ids = target === 'laser' ? this.cfg.lasers : target === 'gen' ? this.cfg.gens : this.cfg.drones.map((d) => d.type);
      const id = slot === 'all' ? undefined : ids[slot];
      if (id) this.actions.sendRaw({ t: 'buy', kind: 'upgrade', id, qty: 1 });
      return;
    }
    level = Math.max(0, Math.round(level));
    const lv = this.lvs[this.edit];
    const arr = target === 'laser' ? lv.lasers : target === 'gen' ? lv.gens : lv.drones;
    const ids = target === 'laser' ? this.cfg.lasers : target === 'gen' ? this.cfg.gens : this.cfg.drones.map((d) => d.type);
    const cap = (i: number) => itemMaxLevel(ids[i] ?? '', target);
    if (slot === 'all') for (let i = 0; i < ids.length; i++) arr[i] = Math.min(level, cap(i));
    else arr[slot] = level = Math.min(level, cap(slot));
    this.lvEditedAt = performance.now();
    this.actions.sendRaw({ t: 'upgrade', config: this.edit + 1, target, slot, level });
    this.render();
  }

  private upgradeAll(level: number): void {
    for (const t of ['laser', 'gen', 'drone'] as const) this.setLevel(t, 'all', level);
  }

  private setFormation(id: string): void {
    this.formationLocal = id;
    this.fxEditedAt = performance.now();
    this.actions.sendRaw({ t: 'formation', id });
    this.render();
  }

  private toggleBooster(id: string): void {
    const on = !this.boostLocal[id];
    this.boostLocal = { ...this.boostLocal, [id]: on };
    this.fxEditedAt = performance.now();
    this.actions.sendRaw({ t: 'booster', id, on });
    this.render();
  }

  private slots(): { lasers: number; gens: number; extras: number; drones: number } {
    const s = this.you?.slots;
    const sh = this.ship();
    return {
      lasers: s?.lasers ?? sh?.lasers ?? 0,
      gens: s?.gens ?? sh?.generators ?? 0,
      extras: s?.extras ?? sh?.extras ?? 0,
      drones: s?.drones ?? ITEMS.maxDrones ?? 10,
    };
  }

  private get cfg(): EquipConfig {
    return this.cfgs[this.edit];
  }

  /** season: owned count of an item (Infinity in the sandbox) */
  private owned(id: string): number {
    if (!this.season) return Infinity;
    const s = this.you?.season;
    if (itemInfo(id)?.kind === 'design') return unlocked(s ?? null, 'design', id) ? Infinity : 0;
    return s?.items[id] ?? 0;
  }

  /** how many of `id` the edited config already uses */
  private used(id: string, c: EquipConfig = this.cfg): number {
    let n = 0;
    for (const x of [...c.lasers, ...c.gens, ...c.extras]) if (x === id) n++;
    for (const d of c.drones) {
      if (d.type === id) n++;
      for (const x of d.items) if (x === id) n++;
    }
    return n;
  }

  // ------------------------------------------------------------ edits
  private apply(c: EquipConfig): void {
    this.cfgs[this.edit] = c;
    this.editedAt = performance.now();
    this.actions.equip({ config: (this.edit + 1) as 1 | 2, lasers: c.lasers, gens: c.gens, extras: c.extras, drones: c.drones, droneDesign: c.droneDesign ?? null });
    this.render();
  }

  private place(id: string, dst: Src, from?: Src): void {
    const info = itemInfo(id);
    if (!info || !ACCEPT[dst.zone].includes(info.kind)) return;
    if (!from && info.kind !== 'design' && this.used(id) >= this.owned(id)) return;
    const c = clone(this.cfg);
    const sl = this.slots();
    if (from) this.removeFrom(c, from);
    const setArr = (arr: string[], i: number, max: number) => {
      if (i >= max) return;
      if (i >= arr.length) arr.push(id); else arr[i] = id;
    };
    switch (dst.zone) {
      case 'lasers': setArr(c.lasers, dst.i, sl.lasers); break;
      case 'gens': setArr(c.gens, dst.i, sl.gens); break;
      case 'extras': setArr(c.extras, dst.i, sl.extras); break;
      case 'design': c.droneDesign = id; break;
      case 'dronetype': {
        const n = droneSlots(id);
        if (dst.i < c.drones.length) {
          const d = c.drones[dst.i];
          d.type = id;
          d.items = d.items.slice(0, n);
        } else if (c.drones.length < sl.drones) c.drones.push({ type: id, items: [] });
        break;
      }
      case 'drone': {
        const d = c.drones[dst.i];
        if (!d || dst.j === undefined) return;
        setArr(d.items, dst.j, droneSlots(d.type));
        break;
      }
    }
    this.apply(c);
  }

  private removeFrom(c: EquipConfig, s: Src): void {
    switch (s.zone) {
      case 'lasers': c.lasers.splice(s.i, 1); break;
      case 'gens': c.gens.splice(s.i, 1); break;
      case 'extras': c.extras.splice(s.i, 1); break;
      case 'design': c.droneDesign = null; break;
      case 'dronetype': c.drones.splice(s.i, 1); break;
      case 'drone': if (c.drones[s.i] && s.j !== undefined) c.drones[s.i].items.splice(s.j, 1); break;
    }
  }

  private remove(s: Src): void {
    const c = clone(this.cfg);
    this.removeFrom(c, s);
    this.apply(c);
  }

  /** double-click in inventory: first free compatible slot (ship first, then drones). */
  private autoPlace(id: string): void {
    const info = itemInfo(id);
    if (!info) return;
    const c = this.cfg;
    const sl = this.slots();
    const k = info.kind;
    if (k === 'laser' && c.lasers.length < sl.lasers) return this.place(id, { zone: 'lasers', i: c.lasers.length });
    if ((k === 'shield' || k === 'speed') && c.gens.length < sl.gens) return this.place(id, { zone: 'gens', i: c.gens.length });
    if (k === 'extra' && c.extras.length < sl.extras && !c.extras.includes(id)) return this.place(id, { zone: 'extras', i: c.extras.length });
    if (k === 'drone' && c.drones.length < sl.drones) return this.place(id, { zone: 'dronetype', i: c.drones.length });
    if (k === 'design') return this.place(id, { zone: 'design', i: 0 });
    if (k === 'laser' || k === 'shield') {
      for (let i = 0; i < c.drones.length; i++) {
        const d = c.drones[i];
        if (d.items.length < droneSlots(d.type)) return this.place(id, { zone: 'drone', i, j: d.items.length });
      }
    }
  }

  private quick(mode: 'best' | 'shield' | 'speed'): void {
    const sl = this.slots();
    const best = (l: ItemDef[], k: keyof ItemDef) => [...l].sort((a, b) => (Number(b[k]) || 0) - (Number(a[k]) || 0))[0]?.id;
    // ship/drone lasers only (P.E.T.-only ones are rejected by the server), ranked by damage at max upgrade level
    const maxed = (l: ItemDef) => (Number(l.damage) || 0) * (1 + (Number(l.maxLevel) || 16) * (Number(l.upgradePerLevel) || 0.06 / 16));
    const laser = ITEMS.lasers.filter((l) => !l.petOnly).sort((a, b) => maxed(b) - maxed(a))[0]?.id;
    const shield = best(ITEMS.shieldGens, 'shield');
    const speed = best(ITEMS.speedGens, 'speed');
    const drone = [...ITEMS.drones].sort((a, b) => (Number(b.slots) || 0) - (Number(a.slots) || 0) || ITEMS.drones.indexOf(b) - ITEMS.drones.indexOf(a))[0]?.id;
    const c = emptyCfg();
    const fill = (n: number, f: (i: number) => string | undefined) => Array.from({ length: n }, (_, i) => f(i)).filter((x): x is string => !!x);
    c.lasers = fill(sl.lasers, () => laser);
    const nShield = mode === 'shield' ? sl.gens : mode === 'speed' ? 0 : Math.ceil(sl.gens / 2);
    c.gens = fill(sl.gens, (i) => (i < nShield ? shield : speed));
    const extras = ['rep-4', 'aim-02', 'arol-x'].filter((x) => itemInfo(x));
    for (const e of ITEMS.extras) if (!extras.includes(e.id)) extras.push(e.id);
    c.extras = extras.slice(0, sl.extras);
    const droneItem = mode === 'shield' ? shield : laser;
    if (drone) c.drones = fill(sl.drones, () => drone).map((t) => ({ type: t, items: fill(droneSlots(t), () => droneItem) }));
    // rank designs: damage first (then shield+hp) for best/speed, shield+hp first for all-shields
    const dmg = (d: ItemDef) => Number(d.damage) || 0;
    const tank = (d: ItemDef) => (Number(d.shield) || 0) + (Number(d.hp) || 0);
    const design = [...ITEMS.droneDesigns].sort((a, b) =>
      mode === 'shield' ? tank(b) - tank(a) || dmg(b) - dmg(a) : dmg(b) - dmg(a) || tank(b) - tank(a))[0];
    c.droneDesign = design?.id ?? null;
    this.apply(c);
  }

  // ------------------------------------------------------------ rendering
  render(): void {
    const y = this.you;
    this.sig = this.sigOf();
    const active = (y?.cfg ?? 1) - 1;
    this.tabEls.forEach((t, i) => {
      t.classList.toggle('on', i === this.edit);
      t.classList.toggle('active', i === active);
    });
    const cd = Math.max(0, y?.cfgCd ?? 0);
    this.activeEl.textContent = `Active: Config ${active + 1}${cd > 0.05 ? ` (switch in ${Math.ceil(cd)}s)` : ''}`;
    this.activateBtn.disabled = this.edit === active || cd > 0.05;
    this.activateBtn.textContent = this.edit === active ? 'Active' : 'Activate [C]';

    const st = y?.stats;
    const sh = this.ship();
    this.statsEl.innerHTML =
      stat('shipInfoIcon_hitpoints', 'HP', fmt(st?.hp ?? sh?.hp ?? 0)) +
      stat('shipInfoIcon_configuration', 'Damage', fmt(st?.damage ?? 0)) +
      stat('shild_small', 'Shield', `${fmt(st?.shield ?? 0)}${st ? ` <small>${Math.round((st.absorb ?? 0) * 100)}%</small>` : ''}`) +
      stat('shipInfoIcon_speed', 'Speed', fmt(st?.speed ?? y?.speed ?? 0)) +
      (st?.repair ? stat('shipInfoIcon_nanohull', 'Repair', `${fmt(st.repair)}/s`) : '') +
      (this.edit !== active ? '<div class="hint">stats shown are for the active config</div>' : '');

    const sl = this.slots();
    const c = this.cfg;
    this.shipEl.innerHTML = '';
    el('div', 'eq-shipname', esc(sh?.name ?? y?.ship ?? 'Ship'), this.shipEl);
    this.row('Lasers', 'lasers', c.lasers, sl.lasers);
    this.row('Generators', 'gens', c.gens, sl.gens);
    this.row('Extras', 'extras', c.extras, sl.extras);

    this.droneEl.innerHTML = '';
    const dh = el('div', 'eq-rowhead', `<span>Drones <small>${c.drones.length}/${sl.drones}</small></span>`, this.droneEl);
    const dz = el('div', 'eq-design', '<small>Design</small>', dh);
    this.slot(dz, c.droneDesign ?? null, { zone: 'design', i: 0 });
    const grid = el('div', 'eq-dronegrid', undefined, this.droneEl);
    for (let i = 0; i < sl.drones; i++) {
      const d: DroneCfg | undefined = c.drones[i];
      const box = el('div', `eq-drone${d ? '' : ' empty'}`, undefined, grid);
      this.slot(box, d?.type ?? null, { zone: 'dronetype', i: d ? i : c.drones.length }, 'big');
      const items = el('div', 'eq-droneitems', undefined, box);
      const n = d ? droneSlots(d.type) : 0;
      for (let j = 0; j < n; j++) this.slot(items, d!.items[j] ?? null, { zone: 'drone', i, j }, 'small');
    }
    this.renderBreakdown();
    this.renderExtra();
    this.renderInv();
  }

  private renderBreakdown(): void {
    const st = this.you?.stats;
    const bd = st?.damageBreakdown as ServerBreakdown | undefined;
    if (bd && Array.isArray(bd.groups)) {
      this.bdEl.style.display = '';
      this.bdEl.innerHTML = renderServerBreakdown(bd);
      return;
    }
    const rows = parseBreakdown(st?.damageBreakdown);
    this.bdEl.style.display = rows.length ? '' : 'none';
    if (!rows.length) return;
    let h = '<div class="eq-rowhead"><span>Damage breakdown</span></div><table class="eq-bd">';
    for (const [k, v] of rows) h += `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`;
    h += `<tr class="total"><th>Final damage / shot</th><td>${fmt(st?.damage ?? 0)}</td></tr></table>`;
    this.bdEl.innerHTML = h;
  }

  private renderExtra(): void {
    this.extraEl.innerHTML = '';
    // drone formations
    const fh = el('div', 'eq-rowhead', `<span>Drone formation <small>${esc(this.formationLocal ? itemName(this.formationLocal) : 'standard')}</small></span>`, this.extraEl);
    void fh;
    const fg = el('div', 'eq-formations', undefined, this.extraEl);
    const forms: ItemDef[] = ITEMS.formations?.length ? ITEMS.formations : DEFAULT_FORMATIONS.map((id) => ({ id, name: id }));
    const cur = (this.formationLocal ?? 'standard').toLowerCase();
    for (const f of forms) {
      const locked = this.season && f.id !== 'standard' && !unlocked(this.you?.season ?? null, 'formation', f.id);
      const b = el('div', `eq-form${f.id.toLowerCase() === cur ? ' on' : ''}${locked ? ' locked' : ''}`, `<img src="${formationIcon(f.id)}" draggable="false"><span>${esc(prettyName(f.name ?? f.id))}</span>`, fg);
      const price = SHOP?.formations[f.id];
      b.title = `${prettyName(f.name ?? f.id)}${f.desc ? `\n${f.desc}` : ''}${locked ? `\nLocked - buy it in the Shop${price ? ` (${priceHtml(price).replace(/<[^>]+>/g, '')})` : ''}` : ''}`;
      if (!locked) b.addEventListener('click', () => this.setFormation(f.id));
    }
    // boosters
    el('div', 'eq-rowhead', '<span>Boosters <small>click to toggle</small></span>', this.extraEl);
    const bg = el('div', 'eq-boosters', undefined, this.extraEl);
    const boosters = (ITEMS.boosters ?? []).filter((b) => !this.season || unlocked(this.you?.season ?? null, 'booster', b.id));
    if (!boosters.length) el('span', 'hint', this.season ? 'No boosters yet - buy them in the Shop (they last until the daily reset)' : 'No boosters in items.json yet', bg);
    for (const b of boosters) {
      const on = !!this.boostLocal[b.id];
      const c = el('div', `eq-boost${on ? ' on' : ''}`, `<img src="${boosterIcon(b.id, String(b.icon ?? ''))}" draggable="false"><div><b>${esc(b.name ?? b.id)}</b><span>${esc(String(b.desc ?? b.effect ?? effectText(b)))}</span></div><i class="led"></i>`, bg);
      c.title = `${b.name ?? b.id} - ${on ? 'ON (click to disable)' : 'OFF (click to enable)'}`;
      c.addEventListener('click', () => this.toggleBooster(b.id));
    }
  }

  private row(label: string, zone: Zone, items: string[], n: number): void {
    const r = el('div', 'eq-row', `<div class="eq-rowhead"><span>${label} <small>${items.length}/${n}</small></span></div>`, this.shipEl);
    const s = el('div', 'eq-slots', undefined, r);
    for (let i = 0; i < n; i++) this.slot(s, items[i] ?? null, { zone, i: items[i] ? i : items.length });
    if (!n) el('span', 'hint', 'no slots', s);
  }

  private slot(parent: HTMLElement, id: string | null, src: Src, size: '' | 'big' | 'small' = ''): HTMLDivElement {
    const s = el('div', `eq-slot ${size}${id ? '' : ' free'}`, undefined, parent);
    if (id) {
      s.innerHTML = `<img src="${iconUrl(id)}" draggable="false">`;
      const up = upTarget(src);
      const max = up ? itemMaxLevel(id, up) : 0;
      if (up && max > 0) {
        const lv = this.lvs[this.edit];
        const cur = (up === 'laser' ? lv.lasers : up === 'gen' ? lv.gens : lv.drones)[src.i] ?? 0;
        const badge = el('span', `eq-lvl${cur >= max ? ' max' : ''}`, String(cur), s);
        if (this.season) {
          const cost = cur < max ? upgradeCost(id, cur) : null;
          badge.title = cost ? `Level ${cur}/${max} (all your ${itemName(id)}) - click to upgrade for ${fmtBig(cost)} credits` : `Level ${cur}/${max}`;
          badge.addEventListener('click', (e) => { e.stopPropagation(); if (cur < max) this.setLevel(up, src.i, cur + 1); });
        } else {
          badge.title = `Upgrade level ${cur}/${max} - click +1 (shift-click -1), mouse wheel to change`;
          badge.addEventListener('click', (e) => { e.stopPropagation(); this.setLevel(up, src.i, e.shiftKey ? cur - 1 : cur >= max ? 0 : cur + 1); });
          s.addEventListener('wheel', (e) => { e.preventDefault(); this.setLevel(up, src.i, cur + (e.deltaY < 0 ? 1 : -1)); }, { passive: false });
        }
      }
      s.title = `${itemName(id)}\n${itemStat(id)}\n(right-click or drag out to unequip)`;
      s.draggable = true;
      s.addEventListener('dragstart', (e) => {
        e.dataTransfer!.setData('x-do-eq', id);
        e.dataTransfer!.setData('x-do-eqsrc', JSON.stringify(src));
        e.dataTransfer!.effectAllowed = 'move';
      });
      s.addEventListener('contextmenu', (e) => { e.preventDefault(); this.remove(src); });
      s.addEventListener('dblclick', () => this.remove(src));
    } else {
      s.title = `Empty ${src.zone === 'dronetype' ? 'drone slot' : src.zone === 'design' ? 'design slot' : 'slot'} - drop ${ACCEPT[src.zone].join('/')} here`;
    }
    s.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('x-do-eq')) { e.preventDefault(); s.classList.add('drop'); }
    });
    s.addEventListener('dragleave', () => s.classList.remove('drop'));
    s.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      s.classList.remove('drop');
      const item = e.dataTransfer!.getData('x-do-eq');
      const from = e.dataTransfer!.getData('x-do-eqsrc');
      if (!item) return;
      const f = from ? (JSON.parse(from) as Src) : undefined;
      if (f && f.zone === src.zone && f.i === src.i && f.j === src.j) return;
      if (f && sameArray(f, src)) this.swapWithin(f, src, item, id);
      else this.place(item, src, f);
    });
    return s;
  }

  /** drag between two slots of the same row: swap items */
  private swapWithin(f: Src, dst: Src, item: string, prev: string | null): void {
    const c = clone(this.cfg);
    const arr = arrOf(c, f);
    if (!arr) return;
    const di = dst.zone === 'drone' ? dst.j! : dst.i;
    const fi = f.zone === 'drone' ? f.j! : f.i;
    arr[di] = item;
    if (prev) arr[fi] = prev; else arr.splice(fi, 1);
    this.apply(c);
  }

  private renderInv(): void {
    const f = FILTERS.find((x) => x.id === this.filter) ?? FILTERS[0];
    const lists: [EquipKind, ItemDef[]][] = [['laser', ITEMS.lasers], ['shield', ITEMS.shieldGens], ['speed', ITEMS.speedGens], ['extra', ITEMS.extras], ['drone', ITEMS.drones], ['design', ITEMS.droneDesigns]];
    this.invEl.innerHTML = '';
    for (const [kind, list] of lists) {
      if (!f.kinds.includes(kind)) continue;
      for (const it of list ?? []) {
        const own = this.owned(it.id);
        if (own <= 0) continue;
        const free = own === Infinity ? Infinity : own - this.used(it.id);
        const count = own === Infinity ? (this.season ? '✓' : '∞') : `${free}/${own}`;
        const b = el('div', `eq-item${free <= 0 ? ' used' : ''}`, `<div class="eq-slot"><img src="${iconUrl(it.id)}" draggable="false"></div><div class="eq-itemtxt"><b>${esc(it.name)}</b><span>${esc(itemStat(it.id))}</span></div><i>${count}</i>`, this.invEl);
        b.draggable = true;
        b.title = `${it.name}\n${itemStat(it.id)}${it.desc ? `\n${it.desc}` : ''}\nDouble-click to equip`;
        b.addEventListener('dragstart', (e) => {
          e.dataTransfer!.setData('x-do-eq', it.id);
          e.dataTransfer!.effectAllowed = 'copy';
        });
        b.addEventListener('dblclick', () => this.autoPlace(it.id));
      }
    }
    if (!this.invEl.childElementCount) el('div', 'hint', 'Nothing here yet - buy items in the Shop tab.', this.invEl);
  }
}

function upTarget(s: Src): 'laser' | 'gen' | 'drone' | null {
  return s.zone === 'lasers' ? 'laser' : s.zone === 'gens' ? 'gen' : s.zone === 'dronetype' ? 'drone' : null;
}

/** "+10% damage, +5% shield" from numeric fraction fields of a booster/formation def */
function effectText(d: ItemDef): string {
  return Object.entries(d)
    .filter(([k, v]) => typeof v === 'number' && !k.startsWith('_') && k !== 'minDrones')
    .map(([k, v]) => `${(v as number) >= 0 ? '+' : ''}${+((v as number) * 100).toFixed(1)}% ${k}`)
    .join(', ');
}

function prettyName(n: string): string {
  return n.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** you.boosters: [ids] | [{id,on}] | {id: bool|{on}} -> {id: on} */
function parseBoosters(b: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (Array.isArray(b)) {
    for (const x of b) {
      if (typeof x === 'string') out[x] = true;
      else if (x && typeof x === 'object' && 'id' in x) out[String((x as { id: unknown }).id)] = (x as { on?: unknown; active?: unknown }).on !== false && (x as { active?: unknown }).active !== false;
    }
  } else if (b && typeof b === 'object') {
    for (const [k, v] of Object.entries(b)) out[k] = typeof v === 'object' && v ? (v as { on?: unknown }).on !== false : !!v;
  }
  return out;
}

interface BdFactor { label: string; pve: number; pvp: number }
interface BdGroup { name: string; lasers: number; basePve: number; factors: BdFactor[]; totalPve: number }
/** Server `stats.damageBreakdown` (server/src/equipment.rs `Breakdown`). */
interface ServerBreakdown {
  groups: BdGroup[];
  x1Pve: number;
  x1Pvp: number;
  overdrivePve?: number;
  flatPve?: number;
  perAmmo?: { id: string; mult: number; pve: number; pvp: number }[];
  variance?: number;
  rocket?: BdFactor[];
}

const mult = (v: number): string => `×${+v.toFixed(3)}`;

function renderServerBreakdown(bd: ServerBreakdown): string {
  let h = '<div class="eq-rowhead"><span>Damage breakdown <small>(per round, max roll, vs aliens)</small></span></div><table class="eq-bd">';
  for (const g of bd.groups) {
    if (!g.lasers && !g.totalPve) continue;
    h += `<tr class="grp"><th>${esc(prettyName(g.name))} · ${g.lasers} lasers</th><td>${fmt(g.basePve)} base</td></tr>`;
    for (const f of g.factors ?? []) {
      if (f.pve === 1) continue;
      h += `<tr><th>&nbsp;&nbsp;${esc(f.label)}</th><td>${mult(f.pve)}</td></tr>`;
    }
    h += `<tr class="sub"><th>&nbsp;&nbsp;= ${esc(prettyName(g.name))}</th><td>${fmt(g.totalPve)}</td></tr>`;
  }
  if (bd.flatPve) h += `<tr><th>Flat PvE bonus</th><td>+${fmt(bd.flatPve)}</td></tr>`;
  h += `<tr class="total"><th>x1 round</th><td>${fmt(bd.x1Pve)} <small>(PvP ${fmt(bd.x1Pvp)})</small></td></tr>`;
  if (bd.overdrivePve) h += `<tr><th>Overdrive round bonus</th><td>+${fmt(bd.overdrivePve)}</td></tr>`;
  const ammo = [...(bd.perAmmo ?? [])].sort((a, b) => b.pve - a.pve);
  if (ammo.length) {
    h += '<tr class="grp"><th>Per ammo</th><td></td></tr>';
    for (const a of ammo) h += `<tr><th>&nbsp;&nbsp;${esc(itemName(a.id))} ${mult(a.mult)}</th><td>${fmt(a.pve)}</td></tr>`;
  }
  if (bd.variance) h += `<tr><th>Damage roll</th><td>${Math.round((1 - bd.variance) * 100)}–100%</td></tr>`;
  return `${h}</table>`;
}

/** stats.damageBreakdown: [{name,value}] | [[name,value]] | {name: value} -> rows */
function parseBreakdown(b: unknown): [string, string][] {
  const val = (v: unknown): string => {
    if (typeof v === 'number') return Math.abs(v) >= 100 ? fmt(v) : `×${+v.toFixed(3)}`;
    return String(v);
  };
  if (Array.isArray(b)) {
    return b.map((x): [string, string] => {
      if (Array.isArray(x)) return [String(x[0]), val(x[1])];
      if (x && typeof x === 'object') {
        const o = x as Record<string, unknown>;
        return [String(o.name ?? o.label ?? o.id ?? '?'), val(o.value ?? o.mult ?? o.v ?? '')];
      }
      return [String(x), ''];
    });
  }
  if (b && typeof b === 'object') return Object.entries(b).map(([k, v]) => [prettyName(k), val(v)]);
  return [];
}

function droneSlots(type: string): number {
  return Number(itemInfo(type)?.def.slots ?? 1) || 1;
}

function sameArray(a: Src, b: Src): boolean {
  if (a.zone !== b.zone) return false;
  if (a.zone === 'drone') return a.i === b.i;
  return a.zone === 'lasers' || a.zone === 'gens' || a.zone === 'extras';
}

function arrOf(c: EquipConfig, s: Src): string[] | null {
  switch (s.zone) {
    case 'lasers': return c.lasers;
    case 'gens': return c.gens;
    case 'extras': return c.extras;
    case 'drone': return c.drones[s.i]?.items ?? null;
    default: return null;
  }
}

function stat(icon: string, label: string, v: string): string {
  return `<div class="eq-stat"><img src="/assets/ui/win/${icon}.png" draggable="false"><span>${label}</span><b>${v}</b></div>`;
}
