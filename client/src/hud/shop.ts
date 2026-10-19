// Season shop (hangar tab): equipment, drones, ammo, formations, boosters, tech and
// per-item-type upgrades. Ships are bought on the Ships tab. Purchases are sent as `buy`
// (server/src/world/season.rs validates and charges); the wallet comes from `you`.
import type { Actions } from '../actions';
import type { YouMsg } from '../types';
import { el, esc } from './dom';
import { boosterIcon, barIcon, formationIcon, ITEMS, itemInfo, itemName, itemStat, loadItems, type ItemDef } from './items';
import { canAfford, fmtBig, loadShop, priceHtml, SHOP, upgradeCost, unlocked, type Price } from './season';
import { iconUrl } from './ui';

interface Row {
  id: string;
  icon: string;
  name: string;
  stat: string;
  price?: Price;
  /** right-hand status text (owned / stock / level) */
  have: string;
  buttons: { label: string; kind: string; qty: number; price?: Price; n: number; disabled?: boolean }[];
}

const CATS: { id: string; label: string }[] = [
  { id: 'lasers', label: 'Lasers' },
  { id: 'gens', label: 'Generators' },
  { id: 'extras', label: 'Extras' },
  { id: 'drones', label: 'Drones' },
  { id: 'ammo', label: 'Ammunition' },
  { id: 'upgrades', label: 'Upgrades' },
  { id: 'formations', label: 'Formations' },
  { id: 'boosters', label: 'Boosters' },
  { id: 'tech', label: 'Tech' },
];

export class ShopPanel {
  private you: YouMsg | null = null;
  private cat = 'lasers';
  private wallet: HTMLDivElement;
  private list: HTMLDivElement;
  private catEls = new Map<string, HTMLDivElement>();
  private sig = '';

  constructor(parent: HTMLElement, private readonly actions: Actions) {
    const root = el('div', 'shop', undefined, parent);
    const side = el('div', 'shop-cats', undefined, root);
    this.wallet = el('div', 'shop-wallet', '', side);
    try { this.cat = localStorage.getItem('do.shop.cat') || this.cat; } catch { /* ignore */ }
    for (const c of CATS) {
      const b = el('div', `shop-cat${c.id === this.cat ? ' on' : ''}`, c.label, side);
      b.addEventListener('click', () => {
        this.cat = c.id;
        this.catEls.forEach((x, k) => x.classList.toggle('on', k === c.id));
        try { localStorage.setItem('do.shop.cat', c.id); } catch { /* ignore */ }
        this.render(true);
      });
      this.catEls.set(c.id, b);
    }
    el('div', 'hint', 'Ships are on the Ships tab. New gear is fitted automatically - fine-tune it on the Equipment tab.', side);
    this.list = el('div', 'shop-list', '', root);
    void Promise.all([loadShop(), loadItems()]).then(() => this.render(true));
  }

  setYou(y: YouMsg): void {
    this.you = y;
    this.render();
  }

  render(force = false): void {
    const y = this.you;
    const s = y?.season;
    const sig = JSON.stringify([this.cat, y?.credits, y?.uridium, s?.items, s?.levels, s?.unlocks, s?.ammo]);
    if (sig === this.sig && !force) return;
    this.sig = sig;
    this.wallet.innerHTML = `<div><img src="/assets/ui/win/shipInfoIcon_credits.png" draggable="false"><b>${fmtBig(y?.credits ?? 0)}</b></div>` +
      `<div><img src="/assets/ui/win/shipInfoIcon_uridium.png" draggable="false"><b>${fmtBig(y?.uridium ?? 0)}</b></div>`;
    this.list.innerHTML = '';
    if (!SHOP || !s) {
      el('div', 'hint', 'The shop opens once you are in the daily season.', this.list);
      return;
    }
    const rows = this.rows();
    if (!rows.length) el('div', 'hint', this.cat === 'upgrades' ? 'Buy lasers, shield generators or drones first - then upgrade them here.' : 'Nothing for sale here.', this.list);
    for (const r of rows) {
      const row = el('div', 'shop-row', undefined, this.list);
      el('div', 'shop-ico', `<img src="${r.icon}" draggable="false" onerror="this.style.visibility='hidden'">`, row);
      el('div', 'shop-txt', `<b>${esc(r.name)}</b><span>${esc(r.stat)}</span>`, row);
      el('div', 'shop-have', r.have, row);
      const btns = el('div', 'shop-btns', undefined, row);
      for (const b of r.buttons) {
        const ok = !b.disabled && canAfford(y, b.price, b.n);
        const bt = el('button', `dobtn ${ok ? 'green' : 'blue'}`, `${esc(b.label)}<small>${priceHtml(b.price, b.n)}</small>`, btns);
        bt.type = 'button';
        bt.disabled = !!b.disabled || !ok;
        bt.title = b.disabled ? 'Already owned / maxed' : ok ? `Buy (${b.label})` : 'Not enough credits / uridium yet';
        bt.addEventListener('click', () => this.actions.sendRaw({ t: 'buy', kind: b.kind, id: r.id, qty: b.qty }));
      }
    }
  }

  private rows(): Row[] {
    const shop = SHOP!;
    const s = this.you!.season!;
    const owns = (id: string) => s.items[id] ?? 0;
    const item = (d: ItemDef, extraQty: number[] = [1, 5]): Row | null => {
      const p = shop.items[d.id];
      if (!p) return null;
      const extra = itemInfo(d.id)?.kind === 'extra';
      const qtys = extra ? [1] : extraQty;
      return {
        id: d.id, icon: iconUrl(d.id), name: d.name, stat: itemStat(d.id), price: p,
        have: owns(d.id) ? `owned <b>${owns(d.id)}</b>${s.levels[d.id] ? ` · lvl ${s.levels[d.id]}` : ''}` : '',
        buttons: qtys.map((q) => ({ label: q === 1 ? 'Buy' : `Buy ${q}`, kind: 'item', qty: q, price: p, n: q, disabled: extra && owns(d.id) > 0 })),
      };
    };
    const unlock = (kind: string, id: string, icon: string, name: string, stat: string, p: Price | undefined): Row | null => {
      if (!p) return null;
      const has = unlocked(s, kind, id);
      return { id, icon, name, stat, price: p, have: has ? '<b class="ok">OWNED</b>' : '', buttons: [{ label: 'Buy', kind, qty: 1, price: p, n: 1, disabled: has }] };
    };
    const keep = (r: Row | null): r is Row => !!r;
    switch (this.cat) {
      case 'lasers': return ITEMS.lasers.map((d) => item(d)).filter(keep);
      case 'gens': return [...ITEMS.shieldGens, ...ITEMS.speedGens].map((d) => item(d)).filter(keep);
      case 'extras': return ITEMS.extras.map((d) => item(d)).filter(keep);
      case 'drones': {
        const drones = ITEMS.drones.map((d) => item(d, [1])).filter(keep);
        const designs = ITEMS.droneDesigns.map((d) => unlock('design', d.id, iconUrl(d.id), `${d.name} design`, String(d.desc ?? ''), shop.designs[d.id])).filter(keep);
        return [...drones, ...designs];
      }
      case 'ammo': {
        const mk = (kind: 'ammo' | 'rocket', id: string, p: Price): Row => {
          const pack = p.pack || 100;
          const stock = s.ammo[id] ?? 0;
          return {
            id, icon: barIcon(id), name: itemName(id), stat: kind === 'ammo' ? 'Laser ammunition' : 'Rocket', price: p,
            have: `<b>${fmtBig(stock)}</b> left`,
            buttons: [1, 10].map((q) => ({ label: `+${fmtBig(pack * q)}`, kind, qty: q, price: p, n: q })),
          };
        };
        const free = { id: 'x1', icon: barIcon('x1'), name: itemName('x1'), stat: 'Basic laser ammunition', have: '<b>∞</b> free', buttons: [] };
        return [free, ...Object.entries(shop.ammo).map(([id, p]) => mk('ammo', id, p)), ...Object.entries(shop.rockets).map(([id, p]) => mk('rocket', id, p))];
      }
      case 'upgrades': {
        const ids = Object.keys(s.items).filter((id) => {
          const k = itemInfo(id)?.kind;
          return (k === 'laser' || k === 'shield' || k === 'drone') && owns(id) > 0;
        });
        return ids.map((id): Row => {
          const k = itemInfo(id)?.kind;
          const max = k === 'drone' ? 16 : Number(itemInfo(id)?.def.maxLevel ?? 16) || 16;
          const lvl = s.levels[id] ?? 0;
          const cost = (n: number) => { let c = 0; for (let l = lvl; l < Math.min(max, lvl + n); l++) c += upgradeCost(id, l) ?? 0; return c; };
          const per = Number(itemInfo(id)?.def.upgradePerLevel ?? 0.00375) || 0.00375;
          const bonus = k === 'drone' ? 'drone damage/shield' : k === 'laser' ? 'damage' : 'shield';
          return {
            id, icon: iconUrl(id), name: `${itemName(id)} ×${owns(id)}`, stat: `+${(per * 100).toFixed(2)}% ${bonus} per level, all units`,
            have: `level <b>${lvl}</b>/${max}`,
            buttons: lvl >= max ? [{ label: 'MAX', kind: 'upgrade', qty: 1, n: 1, disabled: true }] : [1, 5].map((q) => ({ label: `+${Math.min(q, max - lvl)} lvl`, kind: 'upgrade', qty: q, price: { c: cost(q) }, n: 1 })),
          };
        });
      }
      case 'formations':
        return (ITEMS.formations ?? []).map((f) => unlock('formation', f.id, formationIcon(f.id), f.name, String(f.desc ?? ''), shop.formations[f.id])).filter(keep);
      case 'boosters':
        return (ITEMS.boosters ?? []).map((b) => unlock('booster', b.id, boosterIcon(b.id), b.name, boostText(b), shop.boosters[b.id])).filter(keep);
      case 'tech':
        return Object.entries(shop.tech).map(([id, p]) => unlock('tech', id, techIcon(id), p.name ?? id, p.desc ?? '', p)).filter(keep);
    }
    return [];
  }
}

function boostText(b: ItemDef): string {
  return Object.entries(b)
    .filter(([k, v]) => typeof v === 'number' && !k.startsWith('_'))
    .map(([k, v]) => `+${Math.round((v as number) * 100)}% ${k}`)
    .join(', ') + ' for the rest of the day';
}

function techIcon(id: string): string {
  if (id === 'pet') return iconUrl('lf-p01');
  if (id === 'refining') return '/assets/ui/menu/refinement_normal.png';
  return '/assets/ui/menu/pilotSheet_normal.png';
}
