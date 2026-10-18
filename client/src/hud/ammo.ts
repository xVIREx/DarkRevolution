import type { Actions, GameState } from '../actions';
import type { AmmoDef } from '../types';
import { el, esc } from './dom';
import { barIcon, DEFAULT_FORMATIONS, isFormation, ITEMS, itemName, loadItems, registerAmmo } from './items';
import { ui } from './ui';

/**
 * DarkOrbit action bar (bottom centre): the item-control category bar (lasers, rockets, ...)
 * with its item popup, and the 1..0 slot bar. Slots are configurable by drag & drop and saved
 * in localStorage. Laser ammo slots select the ammo AND start attacking the selected target;
 * rocket slots fire that rocket. Input calls activateSlot(i) for keys 1..9,0.
 */
const DEFAULT_SLOTS = ['x1', 'x2', 'x3', 'x4', 'sab', 'rsb', 'r310', 'plt2026', 'plt2021', 'plt3030'];
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
const ROCKET_CD_MS = 1000;

interface Cat { id: string; title: string; items: string[] }

let current: AmmoBar | null = null;
/** Trigger action-bar slot i (0..9) as if the slot was clicked (keys 1..9, 0). */
export function activateSlot(i: number): void {
  current?.activate(i);
}

interface SlotEl { root: HTMLDivElement; icon: HTMLImageElement; cd: HTMLDivElement; amt: HTMLSpanElement; bg: string }

export class AmmoBar {
  private slots: (string | null)[];
  private slotEls: SlotEl[] = [];
  private popup: HTMLDivElement;
  private openCat: string | null = null;
  private cats: Cat[];
  private catEls = new Map<string, { b: HTMLDivElement; img: HTMLImageElement }>();
  private ammoIds: Set<string>;
  private rocketIds: Set<string>;
  private state: GameState | null = null;
  private cdAt = 0;
  private lastAmmo = '';
  private ammoCd = new Map<string, number>();

  constructor(parent: HTMLElement, ammo: AmmoDef[], rockets: { id: string; name?: string }[], private readonly actions: Actions) {
    current = this;
    this.ammoIds = new Set(ammo.map((a) => a.id));
    this.rocketIds = new Set(rockets.map((r) => r.id));
    registerAmmo(ammo, 'laser');
    registerAmmo(rockets, 'rocket');
    for (const a of ammo as (AmmoDef & { cooldown_ms?: number; cooldown?: number })[]) {
      const ms = a.cooldown_ms ?? (a.cooldown ? a.cooldown * 1000 : 0);
      if (ms > 1000) this.ammoCd.set(a.id, ms);
    }
    let saved: unknown = null;
    try { saved = JSON.parse(localStorage.getItem('do.slots') || 'null'); } catch { /* ignore */ }
    this.slots = Array.isArray(saved) && saved.length === 10 ? saved.map((x) => (typeof x === 'string' ? x : null)) : [...DEFAULT_SLOTS];

    this.cats = [
      { id: 'lasers', title: 'Laser ammunition', items: ammo.map((a) => a.id) },
      { id: 'rockets', title: 'Rockets', items: rockets.map((r) => r.id) },
      { id: 'rocket_launchers', title: 'Rocket launcher', items: [] },
      { id: 'special_items', title: 'Special items', items: [] },
      { id: 'mines', title: 'Mines', items: [] },
      { id: 'cpus', title: 'CPUs', items: [] },
      { id: 'buy_now', title: 'Buy now', items: [] },
      { id: 'tech_items', title: 'Tech items', items: [] },
      { id: 'ship_abilities', title: 'Ship abilities', items: [] },
      { id: 'drone_formations', title: 'Drone formations (drag to a slot for a hotkey)', items: DEFAULT_FORMATIONS },
      { id: 'pet', title: 'P.E.T.', items: [] },
    ];

    const root = el('div', undefined, undefined, parent);
    root.id = 'actionbar';
    this.popup = el('div', 'ab-popup', undefined, root);
    const catBar = el('div', 'ab-cats', undefined, root);
    for (const c of this.cats) {
      const b = el('div', `ab-cat${c.items.length ? '' : ' disabled'}`, undefined, catBar);
      b.title = c.title;
      const img = el('img', undefined, undefined, b);
      img.draggable = false;
      img.src = ui(`bar/${c.id}_normal`);
      b.addEventListener('mouseenter', () => this.paintCat(c.id, true));
      b.addEventListener('mouseleave', () => this.paintCat(c.id, false));
      b.addEventListener('click', () => this.toggleCat(c.id));
      this.catEls.set(c.id, { b, img });
    }
    const bar = el('div', 'ab-slots', undefined, root);
    for (let i = 0; i < 10; i++) this.slotEls.push(this.makeSlot(bar, i));
    this.render();
    void loadItems().then(() => {
      const f = this.cats.find((c) => c.id === 'drone_formations');
      if (f && ITEMS.formations?.length) f.items = ITEMS.formations.map((x) => x.id);
      this.render();
    });

    // drop an item outside the bar = remove it from its slot
    document.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('x-do-slot')) e.preventDefault(); });
    document.addEventListener('drop', (e) => {
      const from = e.dataTransfer?.getData('x-do-slot');
      if (from && !(e.target as HTMLElement).closest?.('.ab-slot')) {
        e.preventDefault();
        this.slots[Number(from)] = null;
        this.save();
      }
    });
  }

  private makeSlot(parent: HTMLElement, i: number): SlotEl {
    const root = el('div', 'ab-slot', undefined, parent);
    const icon = el('img', 'ico', undefined, root);
    icon.draggable = false;
    const amt = el('span', 'amt', '', root);
    el('span', 'key', KEYS[i], root);
    const cd = el('div', 'cd', undefined, root);
    el('div', 'sel', undefined, root);
    root.draggable = true;
    root.addEventListener('click', () => this.activate(i));
    root.addEventListener('contextmenu', (e) => e.preventDefault());
    root.addEventListener('dragstart', (e) => {
      if (!this.slots[i]) { e.preventDefault(); return; }
      e.dataTransfer!.setData('x-do-slot', String(i));
      e.dataTransfer!.setData('x-do-item', this.slots[i]!);
      e.dataTransfer!.effectAllowed = 'move';
    });
    root.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('x-do-item')) { e.preventDefault(); root.classList.add('drop'); }
    });
    root.addEventListener('dragleave', () => root.classList.remove('drop'));
    root.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      root.classList.remove('drop');
      const item = e.dataTransfer!.getData('x-do-item');
      const from = e.dataTransfer!.getData('x-do-slot');
      if (!item) return;
      if (from !== '') {
        const f = Number(from);
        [this.slots[f], this.slots[i]] = [this.slots[i], this.slots[f]];
      } else {
        this.slots[i] = item;
      }
      this.save();
    });
    return { root, icon, cd, amt, bg: '' };
  }

  private save(): void {
    try { localStorage.setItem('do.slots', JSON.stringify(this.slots)); } catch { /* ignore */ }
    this.render();
  }

  private render(): void {
    this.slotEls.forEach((s, i) => {
      const id = this.slots[i];
      s.root.classList.toggle('empty', !id);
      if (id) {
        const src = barIcon(id);
        if (!s.icon.src.endsWith(src)) s.icon.src = src;
        s.root.title = `${itemName(id)}  [${KEYS[i]}]${this.ammoIds.has(id) ? ' - select ammo & attack' : this.rocketIds.has(id) ? ' - fire rocket' : isFormation(id) ? ' - drone formation' : ''}`;
        s.amt.textContent = isFormation(id) ? '' : '∞';
      } else {
        s.icon.removeAttribute('src');
        s.root.title = `Empty slot [${KEYS[i]}] - drag an item here`;
        s.amt.textContent = '';
      }
    });
  }

  private paintCat(id: string, hover: boolean): void {
    const c = this.catEls.get(id);
    if (!c) return;
    const st = this.openCat === id ? 'select' : hover ? 'hover' : 'normal';
    c.img.src = ui(`bar/${id}_${st}`);
    c.b.classList.toggle('open', this.openCat === id);
  }

  private toggleCat(id: string): void {
    const prev = this.openCat;
    this.openCat = prev === id ? null : id;
    if (prev) this.paintCat(prev, false);
    this.paintCat(id, true);
    const cat = this.cats.find((c) => c.id === id);
    this.popup.innerHTML = '';
    this.popup.classList.toggle('show', !!this.openCat);
    if (!this.openCat || !cat) return;
    el('div', 'ab-pop-title', esc(cat.title), this.popup);
    const row = el('div', 'ab-pop-items', undefined, this.popup);
    if (!cat.items.length) el('div', 'ab-pop-empty', 'No items', row);
    for (const it of cat.items) {
      const b = el('div', 'ab-item', `<img src="${barIcon(it)}" draggable="false"><span>${esc(itemName(it))}</span>${isFormation(it) ? "" : "<b>∞</b>"}`, row);
      b.draggable = true;
      b.title = `${itemName(it)} - click to use, drag onto a slot`;
      b.addEventListener('dragstart', (e) => {
        e.dataTransfer!.setData('x-do-item', it);
        e.dataTransfer!.effectAllowed = 'copy';
      });
      b.addEventListener('click', () => this.use(it));
      b.dataset.item = it.toLowerCase();
    }
    this.paintPopupSel();
  }

  /** highlight the active formation / ammo / rocket inside the open category popup */
  private paintPopupSel(): void {
    const s = this.state;
    const cur = new Set([this.formation, s?.ammo, s?.rocket].filter((x): x is string => !!x).map((x) => x.toLowerCase()));
    this.popup.querySelectorAll<HTMLElement>('.ab-item').forEach((b) => b.classList.toggle('selected', cur.has(b.dataset.item ?? '')));
  }

  /** Activate slot i (click or key). */
  activate(i: number): void {
    const id = this.slots[i];
    const s = this.slotEls[i];
    if (s) {
      s.root.classList.remove('flash');
      void s.root.offsetWidth;
      s.root.classList.add('flash');
    }
    if (id) this.use(id);
  }

  private use(id: string): void {
    const a = this.actions;
    if (this.ammoIds.has(id)) {
      a.setAmmo(id);
      if (this.state?.selectedId) a.startAttack();
    } else if (this.rocketIds.has(id)) {
      a.setRocket(id);
      a.fireRocket();
    } else if (isFormation(id)) {
      this.formation = id;
      this.formationAt = performance.now();
      a.sendRaw({ t: 'formation', id });
      this.paintPopupSel();
    }
  }

  private formation: string | null = null;
  private formationAt = 0;

  update(s: GameState, now: number): void {
    this.state = s;
    const acd = this.ammoCd.get(s.ammo) ?? 0;
    if (acd && s.ammo !== this.lastAmmo) this.cdAt = now + acd;
    if (acd && s.attacking && now > this.cdAt) this.cdAt = now + acd;
    this.lastAmmo = s.ammo;
    // the server reports the formation in you.stats (CONTRACT.md); hold a local pick briefly until it echoes back
    const you = s.you as { formation?: unknown; stats?: { formation?: unknown } } | null;
    const yf = you?.formation ?? you?.stats?.formation;
    if (typeof yf === 'string' && yf !== this.formation && performance.now() - this.formationAt > 1500) {
      this.formation = yf;
      this.paintPopupSel();
    }
    this.slotEls.forEach((el2, i) => {
      const id = this.slots[i];
      const isAmmo = !!id && this.ammoIds.has(id);
      const isRocket = !!id && this.rocketIds.has(id);
      const sel = (isAmmo && id === s.ammo) || (isRocket && id === s.rocket) || (!!id && !!this.formation && id.toLowerCase() === this.formation.toLowerCase());
      el2.root.classList.toggle('selected', sel);
      el2.root.classList.toggle('attacking', sel && isAmmo && s.attacking);
      let k = 0;
      if (isRocket) k = Math.max(0, Math.min(1, (s.rocketReadyAt - now) / ROCKET_CD_MS));
      else if (id && id === s.ammo && acd && s.attacking) k = Math.max(0, Math.min(1, (this.cdAt - now) / acd));
      const bg = k > 0.001 ? `conic-gradient(rgba(0,0,0,0.69) ${(k * 360).toFixed(1)}deg, transparent 0deg)` : '';
      if (el2.bg !== bg) { el2.bg = bg; el2.cd.style.background = bg; }
    });
  }
}
