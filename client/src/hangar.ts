import type { Actions } from './actions';
import { Assets, drawSheetFrame } from './assets';
import type { ShipDef, YouMsg } from './types';
import { el, esc, fmt } from './hud/dom';
import { syncMenus, ui } from './hud/ui';
import { EquipmentPanel } from './hud/equipment';

type SortKey = 'name' | 'hp' | 'speed' | 'lasers' | 'generators' | 'extras' | 'cargo' | 'designs';
const STATS: { k: keyof ShipDef; label: string }[] = [
  { k: 'hp', label: 'HP' },
  { k: 'speed', label: 'Speed' },
  { k: 'lasers', label: 'Lasers' },
  { k: 'generators', label: 'Generators' },
  { k: 'extras', label: 'Extras' },
  { k: 'cargo', label: 'Cargo' },
];
const THUMB_ANGLE = -Math.PI / 4;
const MAX_COMPARE = 4;

/**
 * Hangar: browse and switch to every ship/design for free, compare stats,
 * equip lasers/generators/extras/drones (Equipment tab) and toggle test cheats.
 */
export class Hangar {
  private root: HTMLDivElement;
  private grid: HTMLDivElement;
  private search: HTMLInputElement;
  private sort: HTMLSelectElement;
  private onlyDesigns: HTMLInputElement;
  private countEl: HTMLElement;
  private openShip: string | null = null;
  private designsEl: HTMLDivElement | null = null;
  private compare: string[] = [];
  private cmpEl: HTMLDivElement;
  private curEl: HTMLDivElement;
  private curCanvas: HTMLCanvasElement;
  private equipment: EquipmentPanel;
  private godBox: HTMLInputElement;
  private multSlider: HTMLInputElement;
  private multLabel: HTMLElement;
  private observer: IntersectionObserver;
  private cards = new Map<string, HTMLDivElement>();
  private you: YouMsg | null = null;
  private byId = new Map<string, ShipDef>();
  private cheatTimer = 0;
  private userTouchedCheat = 0;
  private spin = 0;

  constructor(private readonly assets: Assets, private readonly actions: Actions) {
    for (const s of assets.ships) this.byId.set(s.id, s);

    this.root = el('div', 'dowin hangar-win', undefined, document.body);
    this.root.id = 'hangar';
    const head = el('div', 'dowin-head', undefined, this.root);
    const hic = el('img', 'dowin-icon', undefined, head);
    hic.src = ui('menu/hangar_normal');
    hic.draggable = false;
    el('span', 'dowin-title', 'Hangar', head);
    const nDesigns = assets.ships.reduce((n, s) => n + s.designs.length, 0);
    const tabs = el('div', 'hangar-tabs', undefined, head);
    const close = el('div', 'dowin-min', undefined, head);
    close.title = 'Close [H]';
    close.addEventListener('click', () => this.hide());
    const body = el('div', 'dowin-body', undefined, this.root);
    el('div', 'dowin-bg', undefined, body);
    const pageShips = el('div', 'hangar-page ships', undefined, body);
    const pageEquip = el('div', 'hangar-page equip', undefined, body);
    this.equipment = new EquipmentPanel(pageEquip, actions, () => this.currentShip());
    const pages: [string, HTMLElement][] = [['Equipment', pageEquip], [`Ships (${assets.ships.length} · ${nDesigns} designs)`, pageShips]];
    const tabEls: HTMLElement[] = [];
    pages.forEach(([label], i) => {
      const t = el('div', 'htab', esc(label), tabs);
      tabEls.push(t);
      t.addEventListener('click', () => {
        pages.forEach(([, p2], j) => { p2.classList.toggle('show', i === j); tabEls[j].classList.toggle('on', i === j); });
        try { localStorage.setItem('do.hangar.tab', String(i)); } catch { /* ignore */ }
      });
    });
    let tab = 0;
    try { tab = Number(localStorage.getItem('do.hangar.tab') ?? '0') || 0; } catch { /* ignore */ }
    pages.forEach(([, p2], j) => { p2.classList.toggle('show', j === tab); tabEls[j].classList.toggle('on', j === tab); });

    const tb = el('div', 'toolbar', undefined, pageShips);
    this.search = el('input', undefined, undefined, tb);
    this.search.type = 'search';
    this.search.placeholder = 'Search ships or designs...';
    this.search.addEventListener('input', () => this.renderGrid());
    this.search.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        if (this.search.value) { this.search.value = ''; this.renderGrid(); } else this.hide();
      }
    });
    el('span', 'hint', 'Sort', tb);
    this.sort = el('select', undefined, undefined, tb);
    for (const [v, l] of [['name', 'Name'], ['hp', 'HP'], ['speed', 'Speed'], ['lasers', 'Lasers'], ['generators', 'Generators'], ['extras', 'Extras'], ['cargo', 'Cargo'], ['designs', 'Designs']]) {
      const o = el('option', undefined, l, this.sort);
      o.value = v;
    }
    this.sort.addEventListener('change', () => this.renderGrid());
    const lab = el('label', 'switch', undefined, tb);
    this.onlyDesigns = el('input', undefined, undefined, lab);
    this.onlyDesigns.type = 'checkbox';
    el('span', undefined, 'With designs only', lab);
    this.onlyDesigns.addEventListener('change', () => this.renderGrid());
    this.countEl = el('span', 'hint', '', tb);
    el('span', 'hint', '· click a ship for designs · double-click to equip · ☐ to compare', tb);

    const main = el('div', 'main', undefined, pageShips);
    this.grid = el('div', 'grid', undefined, main);
    const side = el('div', 'side', undefined, main);

    // current ship
    const s1 = el('section', undefined, undefined, side);
    el('div', 'panel-title', 'Current ship', s1);
    this.curCanvas = el('canvas', undefined, undefined, s1);
    this.curCanvas.width = 660;
    this.curCanvas.height = 300;
    this.curCanvas.style.cssText = 'width:100%;height:150px;display:block;background:radial-gradient(ellipse at center,#16304e 0%,#070d16 70%)';
    this.curEl = el('div', 'content', '', s1);

    // cheats
    const s3 = el('section', undefined, undefined, side);
    el('div', 'panel-title', 'Cheats (testing)', s3);
    const c3 = el('div', 'content', undefined, s3);
    const gl = el('label', 'switch', undefined, c3);
    this.godBox = el('input', undefined, undefined, gl);
    this.godBox.type = 'checkbox';
    el('span', undefined, 'God mode (no damage taken)', gl);
    const ml = el('div', 'kv', '<span>Damage multiplier</span>', c3);
    this.multLabel = el('b', undefined, 'x1', ml);
    this.multSlider = el('input', undefined, undefined, c3);
    this.multSlider.type = 'range';
    this.multSlider.min = '-1';
    this.multSlider.max = '3';
    this.multSlider.step = '0.01';
    this.multSlider.value = '0';
    const presets = el('div', 'row', undefined, c3);
    for (const v of [0.1, 1, 10, 100, 1000]) {
      const b = el('button', 'btn', `x${v}`, presets);
      b.style.padding = '2px 6px';
      b.addEventListener('click', () => {
        this.multSlider.value = String(Math.log10(v));
        this.onCheat();
      });
    }
    this.godBox.addEventListener('change', () => this.onCheat());
    this.multSlider.addEventListener('input', () => this.onCheat());

    // compare
    const s4 = el('section', undefined, undefined, side);
    const ct = el('div', 'panel-title', 'Compare', s4);
    const clr = el('button', 'btn', 'Clear', ct);
    clr.style.padding = '1px 6px';
    clr.addEventListener('click', () => {
      this.compare = [];
      this.renderCompare();
      this.refreshCards();
    });
    this.cmpEl = el('div', 'content', '', s4);

    this.observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const c = e.target as HTMLCanvasElement;
        this.observer.unobserve(c);
        const sheet = c.dataset.sheet;
        if (sheet) this.drawThumb(c, sheet, THUMB_ANGLE);
      }
    }, { root: this.grid, rootMargin: '200px' });

    this.renderGrid();
    this.renderCompare();
    window.setInterval(() => this.animateCurrent(), 80);
  }

  get visible(): boolean {
    return this.root.classList.contains('show');
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  show(): void {
    this.root.classList.add('show');
    this.renderCurrent();
    this.equipment.render();
    syncMenus();
  }

  hide(): void {
    this.root.classList.remove('show');
    syncMenus();
    if (document.activeElement instanceof HTMLElement && this.root.contains(document.activeElement)) document.activeElement.blur();
  }

  setYou(y: YouMsg): void {
    const prev = this.you;
    this.you = y;
    const now = performance.now();
    if (now - this.userTouchedCheat > 1500) {
      this.godBox.checked = !!y.god;
      if (typeof y.dmgMult === 'number' && y.dmgMult > 0) this.multSlider.value = String(Math.log10(y.dmgMult));
      this.multLabel.textContent = `x${fmtMult(Number(this.multSlider.value))}`;
    }
    if (!prev || prev.ship !== y.ship || prev.design !== y.design) {
      this.refreshCards();
      this.renderCurrent();
      if (this.designsEl && this.openShip) this.renderDesigns(this.openShip);
    }
    this.equipment.setYou(y);
  }

  shipNameMap(): Map<string, string> {
    const m = new Map<string, string>();
    for (const s of this.assets.ships) {
      m.set(s.id, s.name);
      for (const d of s.designs) m.set(d.id, d.name);
    }
    return m;
  }

  // ---------------- internals ----------------
  private onCheat(): void {
    this.userTouchedCheat = performance.now();
    const mult = Number(fmtMult(Number(this.multSlider.value)));
    this.multLabel.textContent = `x${mult}`;
    clearTimeout(this.cheatTimer);
    this.cheatTimer = window.setTimeout(() => this.actions.setCheat(this.godBox.checked, mult), 100);
  }

  private currentShip(): ShipDef | undefined {
    return this.you ? this.byId.get(this.you.ship) : undefined;
  }

  private currentSheet(): string | null {
    const s = this.currentShip();
    if (!s) return null;
    const d = this.you?.design ? s.designs.find((x) => x.id === this.you!.design) : undefined;
    return d?.sheet ?? s.sheet;
  }

  private filtered(): ShipDef[] {
    const q = this.search.value.trim().toLowerCase();
    let list = this.assets.ships.filter((s) => {
      if (this.onlyDesigns.checked && s.designs.length === 0) return false;
      if (!q) return true;
      if (s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)) return true;
      return s.designs.some((d) => d.name.toLowerCase().includes(q) || d.id.toLowerCase().includes(q));
    });
    const key = this.sort.value as SortKey;
    list = [...list].sort((a, b) => {
      if (key === 'name') return a.name.localeCompare(b.name);
      if (key === 'designs') return b.designs.length - a.designs.length || a.name.localeCompare(b.name);
      return (Number(b[key]) || 0) - (Number(a[key]) || 0) || a.name.localeCompare(b.name);
    });
    return list;
  }

  private renderGrid(): void {
    this.grid.innerHTML = '';
    this.cards.clear();
    this.designsEl = null;
    const list = this.filtered();
    this.countEl.textContent = `${list.length} shown`;
    if (!list.length) {
      el('div', 'empty', this.assets.ships.length ? 'No ships match your search.' : 'No ship data yet (waiting for /data/ships.json or manifest sheets).', this.grid);
      return;
    }
    const q = this.search.value.trim().toLowerCase();
    for (const s of list) {
      const c = el('div', 'card', undefined, this.grid);
      const cv = el('canvas', undefined, undefined, c);
      cv.width = 340;
      cv.height = 220;
      cv.dataset.sheet = s.sheet;
      this.observer.observe(cv);
      el('div', 'nm', `<span>${esc(s.name)}</span>${s.designs.length ? `<span class="ds">${s.designs.length} design${s.designs.length > 1 ? 's' : ''}</span>` : ''}`, c);
      el('div', 'st',
        `<span>HP <b>${fmt(s.hp)}</b></span><span>Speed <b>${s.speed}</b></span>` +
        `<span>Lasers <b>${s.lasers}</b></span><span>Gens <b>${s.generators}</b></span>` +
        `<span>Extras <b>${s.extras}</b></span><span>Cargo <b>${fmt(s.cargo)}</b></span>`, c);
      const cmp = el('span', 'cmp', '☐ cmp', c);
      cmp.title = 'Add to compare';
      cmp.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleCompare(s.id);
      });
      if (s.guess) {
        const g = el('span', 'guess', 'est. stats', c);
        g.title = 'Stats are estimated (not found in the game data)';
      }
      c.addEventListener('click', () => this.toggleDesigns(s.id));
      c.addEventListener('dblclick', () => this.actions.setShip(s.id));
      let spin = 0;
      let timer = 0;
      c.addEventListener('mouseenter', () => {
        timer = window.setInterval(() => {
          spin += 0.25;
          this.drawThumb(cv, s.sheet, THUMB_ANGLE + spin);
        }, 60);
      });
      c.addEventListener('mouseleave', () => {
        clearInterval(timer);
        spin = 0;
        this.drawThumb(cv, s.sheet, THUMB_ANGLE);
      });
      this.cards.set(s.id, c);
    }
    this.refreshCards();
    // auto-open designs when the search only matches designs of a single ship
    if (q && list.length === 1) this.toggleDesigns(list[0].id, true);
    else if (this.openShip && this.cards.has(this.openShip)) this.toggleDesigns(this.openShip, true);
  }

  private refreshCards(): void {
    const cur = this.you?.ship;
    for (const [id, c] of this.cards) {
      c.classList.toggle('current', id === cur);
      c.classList.toggle('open', id === this.openShip && !!this.designsEl);
      let tag = c.querySelector('.cur');
      if (id === cur && !tag) {
        tag = el('span', 'cur', 'EQUIPPED', c);
      } else if (id !== cur && tag) tag.remove();
      const cmp = c.querySelector('.cmp')!;
      const on = this.compare.includes(id);
      cmp.classList.toggle('on', on);
      cmp.textContent = on ? '☑ cmp' : '☐ cmp';
    }
  }

  private toggleDesigns(id: string, forceOpen = false): void {
    if (this.designsEl) {
      this.designsEl.remove();
      this.designsEl = null;
      if (this.openShip === id && !forceOpen) {
        this.openShip = null;
        this.refreshCards();
        return;
      }
    }
    this.openShip = id;
    this.renderDesigns(id);
    this.refreshCards();
  }

  private renderDesigns(id: string): void {
    const s = this.byId.get(id);
    const card = this.cards.get(id);
    if (!s || !card) return;
    const box = this.designsEl ?? el('div', 'designs');
    box.innerHTML = '';
    if (!this.designsEl) {
      // insert after the last card on the same grid row
      let after: Element = card;
      let n = card.nextElementSibling;
      while (n && (n as HTMLElement).offsetTop === card.offsetTop) {
        after = n;
        n = n.nextElementSibling;
      }
      after.after(box);
      this.designsEl = box;
    }
    const title = el('div', 'dtitle', `<span>${esc(s.name)} <span class="hint">${s.designs.length} design(s) · HP ${fmt(s.hp)} · speed ${s.speed} · ${s.lasers} lasers · ${s.generators} gens</span></span>`, box);
    const eq = el('button', 'btn primary', 'Equip base', title);
    eq.addEventListener('click', () => this.actions.setShip(s.id));
    const q = this.search.value.trim().toLowerCase();
    const all = [{ id: '', name: `${s.name} (base)`, sheet: s.sheet }, ...s.designs];
    for (const d of all) {
      const isCur = this.you?.ship === s.id && ((this.you.design || '') === d.id || (!this.you.design && d.id === '') || (this.you.design === s.id && d.id === ''));
      const dc = el('div', `dcard${isCur ? ' current' : ''}`, undefined, box);
      if (q && d.id && !d.name.toLowerCase().includes(q) && !s.name.toLowerCase().includes(q)) dc.style.opacity = '0.45';
      const cv = el('canvas', undefined, undefined, dc);
      cv.width = 260;
      cv.height = 168;
      this.drawThumb(cv, d.sheet, THUMB_ANGLE);
      el('div', undefined, esc(d.name), dc);
      dc.title = d.id ? `Equip ${d.name}` : `Equip ${s.name}`;
      dc.addEventListener('click', () => this.actions.setShip(s.id, d.id || undefined));
      let spin = 0;
      let timer = 0;
      dc.addEventListener('mouseenter', () => {
        timer = window.setInterval(() => { spin += 0.25; this.drawThumb(cv, d.sheet, THUMB_ANGLE + spin); }, 60);
      });
      dc.addEventListener('mouseleave', () => { clearInterval(timer); spin = 0; this.drawThumb(cv, d.sheet, THUMB_ANGLE); });
    }
  }

  private toggleCompare(id: string): void {
    const i = this.compare.indexOf(id);
    if (i >= 0) this.compare.splice(i, 1);
    else {
      this.compare.push(id);
      if (this.compare.length > MAX_COMPARE) this.compare.shift();
    }
    this.renderCompare();
    this.refreshCards();
  }

  private renderCompare(): void {
    let ids = [...this.compare];
    const cur = this.you?.ship;
    if (cur && !ids.includes(cur) && this.byId.has(cur)) ids = [cur, ...ids].slice(0, MAX_COMPARE + 1);
    const ships = ids.map((i) => this.byId.get(i)).filter((x): x is ShipDef => !!x);
    if (ships.length < 1) {
      this.cmpEl.innerHTML = '<div class="hint">Tick "cmp" on up to 4 ships to compare them side by side (your current ship is included).</div>';
      return;
    }
    let h = '<table class="cmp-table"><tr><th></th>';
    for (const s of ships) h += `<th>${esc(s.name)}${s.id === cur ? ' ★' : ''}</th>`;
    h += '</tr>';
    for (const st of STATS) {
      const vals = ships.map((s) => Number(s[st.k]) || 0);
      const max = Math.max(...vals, 1);
      h += `<tr><th>${st.label}</th>`;
      vals.forEach((v) => {
        h += `<td class="${v === max && ships.length > 1 ? 'best' : ''}">${fmt(v)}<div class="cmp-bar" style="width:${(v / max) * 100}%"></div></td>`;
      });
      h += '</tr>';
    }
    const dmg = ships.map((s) => s.lasers * this.assets.lasers.laserDamage);
    const dmax = Math.max(...dmg, 1);
    h += '<tr><th>Dmg/s x1</th>';
    dmg.forEach((v) => { h += `<td class="${v === dmax && ships.length > 1 ? 'best' : ''}">${fmt(v)}<div class="cmp-bar" style="width:${(v / dmax) * 100}%"></div></td>`; });
    h += '</tr><tr><th>Max shield</th>';
    const shd = ships.map((s) => s.generators * 10000);
    const smax = Math.max(...shd, 1);
    shd.forEach((v) => { h += `<td class="${v === smax && ships.length > 1 ? 'best' : ''}">${fmt(v)}<div class="cmp-bar" style="width:${(v / smax) * 100}%"></div></td>`; });
    h += '</tr><tr><th></th>';
    for (const s of ships) h += `<td><button class="btn" data-eq="${esc(s.id)}" style="padding:1px 5px">Equip</button></td>`;
    h += '</tr></table>';
    this.cmpEl.innerHTML = h;
    this.cmpEl.querySelectorAll<HTMLButtonElement>('button[data-eq]').forEach((b) => {
      b.addEventListener('click', () => this.actions.setShip(b.dataset.eq!));
    });
  }

  private renderCurrent(): void {
    this.renderCompare();
    const s = this.currentShip();
    if (!s) {
      this.curEl.innerHTML = `<div class="hint">${this.you ? esc(this.you.ship) : 'Not connected'}</div>`;
      return;
    }
    const d = this.you?.design ? s.designs.find((x) => x.id === this.you!.design) : undefined;
    this.curEl.innerHTML =
      `<div class="kv"><b>${esc(d?.name ?? s.name)}</b><span class="hint">${esc(d?.id ?? s.id)}</span></div>` +
      STATS.map((st) => `<div class="kv"><span>${st.label}</span><b>${fmt(Number(s[st.k]))}</b></div>`).join('');
  }

  private animateCurrent(): void {
    if (!this.visible) return;
    const sheet = this.currentSheet();
    if (!sheet) return;
    this.spin += 0.06;
    this.drawThumb(this.curCanvas, sheet, this.spin);
  }

  private drawThumb(cv: HTMLCanvasElement, sheetKey: string, angle: number): void {
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const sheet = this.assets.sheet(sheetKey);
    const draw = (img: HTMLImageElement | null) => {
      ctx.clearRect(0, 0, cv.width, cv.height);
      if (img && sheet) {
        ctx.save();
        ctx.translate(cv.width * 0.04, cv.height * 0.04);
        drawSheetFrame(ctx, img, sheet, this.assets.frameFor(angle, sheet.frames), cv.width * 0.92, cv.height * 0.92);
        ctx.restore();
        return;
      }
      // placeholder triangle
      ctx.save();
      ctx.translate(cv.width / 2, cv.height / 2);
      ctx.rotate(angle);
      ctx.fillStyle = '#4a6c96';
      ctx.beginPath();
      const r = Math.min(cv.width, cv.height) * 0.3;
      ctx.moveTo(r, 0);
      ctx.lineTo(-r * 0.8, r * 0.65);
      ctx.lineTo(-r * 0.45, 0);
      ctx.lineTo(-r * 0.8, -r * 0.65);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    };
    if (!sheet) {
      draw(null);
      return;
    }
    void this.assets.loadImage(sheet.url).then(draw);
  }
}

function fmtMult(log: number): string {
  const v = Math.pow(10, log);
  if (v >= 10) return String(Math.round(v));
  if (v >= 1) return String(Math.round(v * 10) / 10);
  return String(Math.round(v * 100) / 100);
}
