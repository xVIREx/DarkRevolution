import type { Faction } from '../types';
import { FACTION_COLORS } from '../types';
import { el } from './dom';

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

  constructor(onLogin: (name: string, faction: Faction) => void) {
    let saved: { name?: string; faction?: Faction } = {};
    try { saved = JSON.parse(localStorage.getItem('do.login') || '{}'); } catch { /* ignore */ }
    this.faction = saved.faction && FACTIONS.some((f) => f.id === saved.faction) ? saved.faction : 'mmo';

    this.root = el('div', 'overlay', undefined, document.body);
    this.root.id = 'login';
    const d = el('div', 'panel dialog', undefined, this.root);
    el('div', 'panel-title', 'Pilot login', d);
    const body = el('div', 'body', undefined, d);
    el('h1', undefined, 'DARK<span>ORBIT</span>', body);
    el('div', 'sub', 'classic space combat · local server', body);
    const name = el('input', undefined, undefined, body);
    name.type = 'text';
    name.placeholder = 'Pilot name';
    name.maxLength = 20;
    name.value = saved.name ?? `Pilot${Math.floor(Math.random() * 9000 + 1000)}`;
    const fr = el('div', 'factions', undefined, body);
    const cards: HTMLDivElement[] = [];
    for (const f of FACTIONS) {
      const c = el('div', 'faction', `<b>${f.name}</b><small>${f.full}</small>`, fr);
      c.style.color = FACTION_COLORS[f.id];
      c.classList.toggle('sel', f.id === this.faction);
      c.addEventListener('click', () => {
        this.faction = f.id;
        cards.forEach((x) => x.classList.remove('sel'));
        c.classList.add('sel');
      });
      cards.push(c);
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
