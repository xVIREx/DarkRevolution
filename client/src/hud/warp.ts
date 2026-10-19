import type { Actions, GameState } from '../actions';
import type { MapDef } from '../types';
import { el, esc } from './dom';
import { DOWindow, button } from './ui';

const FACTION_CLS: Record<string, string> = { mmo: 'mmo', eic: 'eic', vru: 'vru' };

/**
 * Jump CPU window: warp instantly to any map (sends `warp`). Maps are grouped by sector
 * (1-x, 2-x, ...) like the DO galaxy map; the current map is highlighted.
 */
export class WarpWindow {
  readonly win: DOWindow;
  private btns = new Map<number, HTMLButtonElement>();
  private shownMap: number | null = null;
  private status: HTMLElement;
  private seasonSig = '';
  private ready = true;

  constructor(private readonly actions: Actions, hint = 'Instant jump to any map. Free and unlimited.') {
    this.win = new DOWindow({ id: 'win-warp', title: 'Jump CPU [G]', icon: 'ship_warp', w: 360, anchor: 'tc', x: 0, y: 140, open: false, cls: 'win-warp' });
    el('div', 'warp-hint', hint, this.win.body);
    this.status = el('div', 'warp-hint warp-status', '', this.win.body);
    const list = el('div', 'warp-list', 'Loading maps…', this.win.body);
    void fetch('/data/maps.json')
      .then((r) => r.json() as Promise<MapDef[]>)
      .then((maps) => this.build(list, maps))
      .catch(() => { list.textContent = 'Map list unavailable'; });
  }

  private build(list: HTMLElement, maps: MapDef[]): void {
    list.textContent = '';
    const groups = new Map<string, MapDef[]>();
    for (const m of maps) {
      const sector = /^(\d+)-/.exec(m.name)?.[1] ?? 'Other';
      if (!groups.has(sector)) groups.set(sector, []);
      groups.get(sector)!.push(m);
    }
    const order = [...groups.keys()].sort((a, b) => (Number(a) || 99) - (Number(b) || 99));
    for (const sector of order) {
      const row = el('div', 'warp-row', `<span class="warp-sector">${esc(sector === 'Other' ? sector : `${sector}-x`)}</span>`, list);
      const cells = el('div', 'warp-cells', undefined, row);
      const ms = groups.get(sector)!.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      for (const m of ms) {
        const b = button(m.name, cells, 'blue', () => {
          if (!this.ready) return;
          this.actions.warp(m.id);
          this.win.close();
        });
        b.classList.add('warp-btn', FACTION_CLS[m.faction ?? ''] ?? 'neutral');
        b.title = `Warp to ${m.name}`;
        this.btns.set(m.id, b);
      }
    }
    this.shownMap = null;
  }

  /** Highlight the current map; call every frame (cheap: only touches the DOM on change). */
  update(s: GameState): void {
    // season: only maps reached this round, with a cooldown
    const sea = s.you?.season;
    if (sea && this.btns.size) {
      const cd = sea.warpCd ?? 0;
      const sig = JSON.stringify([sea.visited, cd]);
      if (sig !== this.seasonSig) {
        this.seasonSig = sig;
        const seen = new Set(sea.visited ?? []);
        for (const [id, b] of this.btns) {
          b.disabled = !seen.has(id);
          b.title = seen.has(id) ? `Warp to ${b.textContent}` : 'Not reached yet this round - fly there through the portals first';
        }
        this.ready = cd <= 0;
        this.status.textContent = cd > 0 ? `Recharging: ${cd} s` : 'Ready';
        this.status.classList.toggle('cd', cd > 0);
      }
    }
    const cur = s.map?.id ?? null;
    if (cur === this.shownMap || this.btns.size === 0) return;
    if (this.shownMap !== null) this.btns.get(this.shownMap)?.classList.remove('current');
    if (cur !== null) this.btns.get(cur)?.classList.add('current');
    this.shownMap = cur;
  }

  toggle(): void { this.win.toggle(); }
}
