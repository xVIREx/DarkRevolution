// Upgrades panel (U): the ship tier ladder plus every sensible next purchase with its simulated
// effect on your best fit (server world/upgrades.rs). Nothing is bought blindly: each row shows
// what it changes, what it costs and a value figure, so skipping a tier is a visible choice.
import type { Actions } from '../actions';
import type { UpgradeOption, YouMsg } from '../types';
import type { ShipDef } from '../types';
import { el, esc, isTyping } from './dom';
import { barIcon, formationIcon, boosterIcon } from './items';
import { fmtBig, loadShop, SHOP } from './season';
import { DOWindow, iconUrl } from './ui';

const CATS: { id: string; label: string; cats: string[] }[] = [
  { id: 'all', label: 'All', cats: [] },
  { id: 'ships', label: 'Ships', cats: ['ship'] },
  { id: 'weapons', label: 'Weapons', cats: ['laser', 'drone'] },
  { id: 'defense', label: 'Defense', cats: ['shield', 'extra'] },
  { id: 'boosts', label: 'Boosts', cats: ['design', 'formation', 'booster', 'tech'] },
  { id: 'levels', label: 'Levels', cats: ['level'] },
];
const CAT_NAME: Record<string, string> = {
  ship: 'Ship', laser: 'Laser', shield: 'Shield', drone: 'Drone', extra: 'Extra', design: 'Drone design',
  formation: 'Formation', booster: 'Booster', tech: 'Tech', level: 'Upgrade',
};

export class UpgradePanel {
  readonly win: DOWindow;
  private ladder: HTMLDivElement;
  private list: HTMLDivElement;
  private tabEls = new Map<string, HTMLDivElement>();
  private tab = 'all';
  private options: UpgradeOption[] = [];
  private you: YouMsg | null = null;
  private sig = '';
  private timer = 0;

  constructor(private readonly actions: Actions, private readonly ships: Map<string, ShipDef>) {
    this.win = new DOWindow({ id: 'win-upgrades', title: 'Upgrades [U]', icon: 'shop', w: 520, anchor: 'tc', x: 0, y: 110, open: false, cls: 'win-upgrades' });
    this.ladder = el('div', 'up-ladder', '', this.win.body);
    const tabs = el('div', 'up-tabs', undefined, this.win.body);
    for (const c of CATS) {
      const t = el('div', `up-tab${c.id === this.tab ? ' on' : ''}`, c.label, tabs);
      t.addEventListener('click', () => {
        this.tab = c.id;
        this.tabEls.forEach((x, k) => x.classList.toggle('on', k === c.id));
        this.render(true);
      });
      this.tabEls.set(c.id, t);
    }
    this.list = el('div', 'up-list', '', this.win.body);
    const hint = el('div', 'hint', '', this.win.body);
    const setHint = () => {
      hint.textContent = `Effects are compared with your current best fit. "Value" = gain per 10k credits (uridium counted at ${SHOP?.upgrade.uriValue ?? 400} credits) - skipping to a bigger item is often worth it. New gear is fitted automatically.`;
    };
    setHint();
    this.win.onToggle = (open) => {
      clearInterval(this.timer);
      if (open) {
        this.request();
        this.timer = window.setInterval(() => this.request(), 3000);
      }
    };
    // DOWindow restores a saved open state in its constructor, before onToggle existed
    if (this.win.visible) this.win.onToggle(true);
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyU' && !e.repeat && !isTyping() && !e.ctrlKey && !e.metaKey) this.toggle();
    });
    void loadShop().then(() => {
      setHint();
      this.render(true);
    });
  }

  toggle(): void {
    this.win.toggle();
    if (this.win.visible) this.win.front();
  }

  private request(): void {
    this.actions.sendRaw({ t: 'upgrades' });
  }

  setOptions(o: UpgradeOption[]): void {
    this.options = o;
    this.render();
  }

  setYou(y: YouMsg): void {
    this.you = y;
    this.render();
  }

  private render(force = false): void {
    if (!this.win.visible && !force) return;
    const y = this.you;
    const sig = JSON.stringify([this.tab, this.options, y?.ship, y?.season?.ships, Math.floor((y?.credits ?? 0) / 1000), Math.floor(y?.uridium ?? 0)]);
    if (sig === this.sig && !force) return;
    this.sig = sig;
    this.renderLadder();
    const cats = CATS.find((c) => c.id === this.tab)?.cats ?? [];
    const opts = this.options.filter((o) => !cats.length || cats.includes(o.cat));
    // best value among what you can afford now (not free ship switches)
    const best = opts.filter((o) => o.ok && o.kind !== 'switch' && o.value > 0).sort((a, b) => b.value - a.value)[0];
    this.list.innerHTML = '';
    if (!opts.length) {
      el('div', 'hint', 'Nothing to buy here right now.', this.list);
      return;
    }
    for (const o of opts) {
      const row = el('div', `up-row${o.ok ? ' ok' : ''}${o === best ? ' best' : ''}`, undefined, this.list);
      el('div', 'up-ico', `<img src="${icon(o)}" draggable="false" onerror="this.style.visibility='hidden'">`, row);
      const fx: string[] = [];
      const chip = (v: number, label: string) => {
        if (Math.abs(v) >= 0.1) fx.push(`<i class="${v > 0 ? 'pos' : 'neg'}">${v > 0 ? '+' : ''}${v >= 100 ? Math.round(v) : v}% ${label}</i>`);
      };
      chip(o.dmg, 'damage');
      chip(o.shd, 'shield');
      chip(o.hp, 'HP');
      chip(o.spd, 'speed');
      el('div', 'up-txt',
        `<b>${esc(o.label)}</b><small>${esc(CAT_NAME[o.cat] ?? o.cat)}${o === best ? ' · <em>best value</em>' : ''}</small>` +
        `<span>${esc(o.desc)}</span><div class="up-fx">${fx.join('') || '<i class="neu">no direct stat change</i>'}${o.value > 0 ? `<u>value ${o.value}</u>` : ''}</div>`, row);
      const price = o.kind === 'switch' ? 'free' : [o.c ? `${fmtBig(o.c)} C` : '', o.u ? `${fmtBig(o.u)} U` : ''].filter(Boolean).join(' + ');
      const b = el('button', `dobtn ${o.ok ? 'green' : 'blue'}`, `${o.kind === 'switch' ? 'Fly it' : 'Buy'}<small>${price}</small>`, row);
      b.type = 'button';
      b.disabled = !o.ok;
      b.title = o.ok ? '' : `Not enough yet${progress(o, y)}`;
      b.addEventListener('click', () => this.actions.sendRaw({ t: 'buy', kind: o.kind, id: o.id, qty: 1 }));
    }
  }

  private renderLadder(): void {
    const tiers = SHOP?.tiers ?? [];
    const y = this.you;
    if (!tiers.length || !y) {
      this.ladder.innerHTML = '';
      return;
    }
    const owned = new Set(y.season?.ships ?? []);
    const curTier = tiers.findIndex((t) => t.ships.includes(y.ship));
    let h = '';
    tiers.forEach((t, i) => {
      const has = t.ships.some((s) => owned.has(s));
      const names = t.ships.map((s) => `${this.ships.get(s)?.name ?? s}${owned.has(s) ? ' ✓' : ''}`).join(', ');
      h += `${i ? '<span class="up-arrow">›</span>' : ''}<div class="up-tier${i === curTier ? ' cur' : has ? ' own' : ''}" title="${esc(`${t.name}: ${names}`)}">${esc(t.name.replace('Tier ', 'T'))}</div>`;
    });
    const cur = this.ships.get(y.ship);
    this.ladder.innerHTML = `<div class="up-ship">Flying <b>${esc(cur?.name ?? y.ship)}</b>${curTier >= 0 ? ` · ${esc(tiers[curTier].name)}` : ''}</div><div class="up-tiers">${h}</div>`;
  }
}

function icon(o: UpgradeOption): string {
  switch (o.cat) {
    case 'formation': return formationIcon(o.id);
    case 'booster': return boosterIcon(o.id);
    case 'ship': return '/assets/ui/menu/hangar_normal.png';
    case 'tech': return o.id === 'pet' ? iconUrl('lf-p01') : o.id === 'refining' ? '/assets/ui/menu/refinement_normal.png' : '/assets/ui/menu/pilotSheet_normal.png';
    default: return o.cat === 'level' ? iconUrl(o.id) : iconUrl(o.id) || barIcon(o.id);
  }
}

function progress(o: UpgradeOption, y: YouMsg | null): string {
  if (!y) return '';
  const k = Math.min(o.c ? y.credits / o.c : 1, o.u ? y.uridium / o.u : 1);
  return ` (${Math.floor(Math.max(0, Math.min(1, k)) * 100)}% there)`;
}

/** HUD button above the action bar: opens the panel, shows how many upgrades you can afford. */
export class UpgradeButton {
  private root: HTMLDivElement;
  private badge: HTMLElement;
  private last = 0;

  constructor(parent: HTMLElement, onClick: () => void) {
    this.root = el('div', 'upg-btn', '<kbd>U</kbd><div class="upg-txt"><b>Upgrades</b></div>', parent);
    this.badge = el('span', 'upg-badge', '', this.root);
    this.root.addEventListener('click', onClick);
    this.root.title = 'Upgrades [U]';
  }

  update(y: YouMsg): void {
    const n = y.season?.affordable ?? 0;
    this.badge.textContent = n ? `${n} affordable` : '';
    this.root.classList.toggle('ok', n > 0);
    if (n > this.last) {
      this.root.classList.remove('pulse');
      void this.root.offsetWidth;
      this.root.classList.add('pulse');
    }
    this.last = n;
  }
}
