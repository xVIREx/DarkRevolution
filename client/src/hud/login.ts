import type { Faction } from '../types';
import { FACTION_COLORS } from '../types';
import { el, esc } from './dom';
import { fmtBig, fmtClock, type SeasonInfo } from './season';

const FACTIONS: { id: Faction; name: string; full: string }[] = [
  { id: 'mmo', name: 'MMO', full: 'Mars Mining Operations' },
  { id: 'eic', name: 'EIC', full: 'Earth Industries Corp.' },
  { id: 'vru', name: 'VRU', full: 'Venus Resources Unlimited' },
];

export class LoginScreen {
  private root: HTMLDivElement;
  private status: HTMLDivElement;
  private btn: HTMLButtonElement;
  private faction: Faction;
  private cards = new Map<Faction, HTMLDivElement>();
  private seasonEl: HTMLDivElement;
  private locked: Faction | null = null;
  private nameInput: HTMLInputElement;

  constructor(onLogin: (name: string, faction: Faction) => void) {
    let saved: { name?: string; faction?: Faction } = {};
    try { saved = JSON.parse(localStorage.getItem('do.login') || '{}'); } catch { /* ignore */ }
    this.faction = saved.faction && FACTIONS.some((f) => f.id === saved.faction) ? saved.faction : 'mmo';

    this.root = el('div', 'overlay', undefined, document.body);
    this.root.id = 'login';
    const d = el('div', 'panel dialog', undefined, this.root);
    el('div', 'panel-title', 'Pilot login', d);
    const body = el('div', 'body', undefined, d);
    el('h1', undefined, 'DARK<span>REVOLUTION</span>', body);
    el('div', 'sub', 'fan-made space combat · unofficial', body);
    const name = el('input', undefined, undefined, body);
    name.type = 'text';
    name.placeholder = 'Pilot name';
    name.maxLength = 20;
    name.value = saved.name ?? `Pilot${Math.floor(Math.random() * 9000 + 1000)}`;
    this.nameInput = name;
    this.seasonEl = el('div', 'season-info', '', body);
    const fr = el('div', 'factions', undefined, body);
    for (const f of FACTIONS) {
      const c = el('div', 'faction', `<b>${f.name}</b><small>${f.full}</small><em></em>`, fr);
      c.style.color = FACTION_COLORS[f.id];
      c.classList.toggle('sel', f.id === this.faction);
      c.addEventListener('click', () => {
        if (this.locked && this.locked !== f.id) return;
        this.faction = f.id;
        this.cards.forEach((x) => x.classList.remove('sel'));
        c.classList.add('sel');
      });
      this.cards.set(f.id, c);
    }
    this.btn = el('button', 'btn primary', 'Launch', body);
    this.btn.style.width = '100%';
    this.btn.style.padding = '9px';
    this.status = el('div', 'status', '', body);
    const go = () => {
      const n = name.value.trim().slice(0, 20) || 'Pilot';
      try { localStorage.setItem('do.login', JSON.stringify({ name: n, faction: this.faction })); } catch { /* ignore */ }
      onLogin(n, this.faction);
    };
    this.btn.addEventListener('click', go);
    name.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') go();
    });
    setTimeout(() => name.focus(), 0);
  }

  /** Daily season summary from /api/season: countdown, company sizes, your locked company. */
  setSeason(info: SeasonInfo): void {
    if (!info.enabled) return;
    const left = (info.resetAt ?? 0) - (info.now ?? Date.now());
    const champs = (info.champions ?? []).map((c, i) => `${['🥇', '🥈', '🥉'][i] ?? ''} ${esc(c.n)} <small>${fmtBig(c.ep)} EP</small>`).join(' &nbsp; ');
    const top = (info.top ?? []).slice(0, 3).map((c, i) => `${i + 1}. ${esc(c.n)} <small>lvl ${c.lvl}</small>`).join(' &nbsp; ');
    this.seasonEl.innerHTML =
      `<div class="si-title">DAILY SEASON <span>resets in <b class="si-clock">${fmtClock(left)}</b></span></div>` +
      '<div class="si-text">Everyone starts in a Phoenix. Hunt aliens, buy ships &amp; gear, climb the ranking. At 00:00 UTC the universe resets.</div>' +
      (top ? `<div class="si-row">Today: ${top}</div>` : '') +
      (champs ? `<div class="si-row">Yesterday: ${champs}</div>` : '');
    const clock = this.seasonEl.querySelector<HTMLElement>('.si-clock');
    const end = Date.now() + left;
    window.setInterval(() => { if (clock) clock.textContent = fmtClock(end - Date.now()); }, 1000);
    for (const [f, c] of this.cards) {
      const r = info.factions?.[f];
      const tag = c.querySelector('em')!;
      tag.innerHTML = r ? `${r.pilots} pilot${r.pilots === 1 ? '' : 's'} today${r.bonus > 0 ? ` · <i>+${Math.round(r.bonus * 100)}% rewards</i>` : ''}` : '';
    }
    const lock = info.locked as Faction | null | undefined;
    if (lock && this.cards.has(lock)) {
      this.locked = lock;
      this.faction = lock;
      for (const [f, c] of this.cards) {
        c.classList.toggle('sel', f === lock);
        c.classList.toggle('disabled', f !== lock);
      }
      el('div', 'si-lock', `You fly for <b>${lock.toUpperCase()}</b> until the reset${info.level ? ` (level ${info.level})` : ''} - your progress is waiting.`, this.seasonEl);
      if (info.name) this.nameInput.value = info.name;
    }
  }

  setStatus(text: string, err = false): void {
    this.status.textContent = text;
    this.status.classList.toggle('err', err);
  }

  setBusy(b: boolean): void {
    this.btn.disabled = b;
  }

  show(): void {
    this.root.style.display = 'flex';
  }

  hide(): void {
    this.root.style.display = 'none';
  }
}
