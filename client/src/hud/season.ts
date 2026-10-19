// Daily season (server/src/season.rs): browser token, shop catalogue (/data/shop.json),
// the reset countdown bar and the Rankings window (today / companies / my stats / champions).
import type { FactionRow, SeasonYou, TopMsg, TopRow, YouMsg } from '../types';
import { FACTION_COLORS } from '../types';
import { el, esc, fmt } from './dom';
import { DOWindow, ui } from './ui';

export interface Price { c?: number; u?: number; pack?: number; name?: string; desc?: string }
export interface ShopData {
  enabled: boolean;
  tiers?: { name: string; ships: string[] }[];
  start: { ship: string };
  ships: Record<string, Price>;
  items: Record<string, Price>;
  designs: Record<string, Price>;
  ammo: Record<string, Price>;
  rockets: Record<string, Price>;
  formations: Record<string, Price>;
  boosters: Record<string, Price>;
  tech: Record<string, Price>;
  upgrade: { perLevel: number; uriValue: number };
  underdogBonus?: number;
}

export let SHOP: ShopData | null = null;
let shopLoad: Promise<ShopData | null> | null = null;

export function loadShop(): Promise<ShopData | null> {
  shopLoad ??= fetch('/data/shop.json', { cache: 'no-cache' })
    .then((r) => (r.ok ? (r.json() as Promise<ShopData>) : null))
    .then((d) => (SHOP = d && d.enabled ? d : null))
    .catch(() => null);
  return shopLoad;
}

/** Random pilot identity kept in this browser: today's progress belongs to it. */
export function seasonToken(): string {
  let t = '';
  try { t = localStorage.getItem('do.token') ?? ''; } catch { /* ignore */ }
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(t)) {
    const a = new Uint8Array(18);
    crypto.getRandomValues(a);
    t = Array.from(a, (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[b % 62]).join('');
    try { localStorage.setItem('do.token', t); } catch { /* ignore */ }
  }
  return t;
}

export interface SeasonInfo {
  enabled: boolean;
  now?: number;
  resetAt?: number;
  factions?: Record<string, FactionRow>;
  locked?: string | null;
  name?: string | null;
  level?: number | null;
  champions?: TopRow[];
  top?: TopRow[];
  pilots?: number;
  bonus?: number;
}

export function fetchSeasonInfo(): Promise<SeasonInfo> {
  return fetch(`/api/season?token=${encodeURIComponent(seasonToken())}`, { cache: 'no-store' })
    .then((r) => (r.ok ? (r.json() as Promise<SeasonInfo>) : { enabled: false }))
    .catch(() => ({ enabled: false }));
}

export const seasonOf = (y: YouMsg | null | undefined): SeasonYou | null => y?.season ?? null;

export function priceHtml(p: Price | undefined, n = 1): string {
  if (!p) return '<span class="hint">not sold</span>';
  const parts: string[] = [];
  if (p.c) parts.push(`<span class="pc">${fmtBig(p.c * n)} C</span>`);
  if (p.u) parts.push(`<span class="pu">${fmtBig(p.u * n)} U</span>`);
  return parts.join(' + ') || '<span class="pc">free</span>';
}

export function canAfford(y: YouMsg | null, p: Price | undefined, n = 1): boolean {
  if (!y || !p) return false;
  return (p.c ?? 0) * n <= y.credits + 1e-6 && (p.u ?? 0) * n <= y.uridium + 1e-6;
}

/** Credits to raise an item type from `lvl` to `lvl + 1` (mirrors Shop::upgrade_cost). */
export function upgradeCost(id: string, lvl: number): number | null {
  const p = SHOP?.items[id];
  if (!p || !SHOP) return null;
  const value = (p.c ?? 0) + (p.u ?? 0) * (SHOP.upgrade?.uriValue ?? 400);
  return Math.max(100, Math.round(value * (SHOP.upgrade?.perLevel ?? 0.02) * (lvl + 1)));
}

export function unlocked(s: SeasonYou | null, kind: string, id: string): boolean {
  return !!s?.unlocks.includes(`${kind}:${id}`);
}

export function fmtBig(n: number): string {
  if (n >= 1e9) return `${+(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${+(n / 1e6).toFixed(2)}M`;
  return Math.round(n).toLocaleString('en-US');
}

export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

const FACTION_NAME: Record<string, string> = { mmo: 'MMO', eic: 'EIC', vru: 'VRU' };
export const fname = (f: string): string => FACTION_NAME[f] ?? f.toUpperCase();
/** company colour; neutral grey for none */
export const fcol = (f: string | null | undefined): string => (f ? FACTION_COLORS[f] ?? '#ccc' : '#9aa7b4');

/** Countdown + rank strip at the top of the screen; click opens the Rankings window. */
export class SeasonBar {
  private root: HTMLDivElement;
  private clock: HTMLElement;
  private rank: HTMLElement;
  private bonus: HTMLElement;
  private safe: HTMLElement;
  private prot: HTMLElement;
  private resetAt = 0;
  private skew = 0;

  constructor(parent: HTMLElement, onClick: () => void) {
    this.root = el('div', 'season-bar', undefined, parent);
    this.root.title = 'Rounds: everyone starts from zero and the universe resets when the round ends. Click for rankings.';
    el('b', undefined, 'ROUND', this.root);
    this.clock = el('span', 'sb-clock', '--:--:--', this.root);
    this.rank = el('span', 'sb-rank', '', this.root);
    this.bonus = el('span', 'sb-bonus', '', this.root);
    this.safe = el('span', 'sb-safe', 'PvP-free zone', this.root);
    this.prot = el('span', 'sb-prot', 'Protected: aliens can\'t attack you here', this.root);
    this.root.addEventListener('click', onClick);
    window.setInterval(() => this.tick(), 500);
  }

  update(s: SeasonYou, pilots: number, protectedHere = false): void {
    this.prot.style.display = protectedHere ? '' : 'none';
    this.resetAt = s.resetAt;
    setText(this.rank, s.rank ? `Rank #${s.rank}${pilots ? ` / ${pilots}` : ''}` : '');
    setText(this.bonus, s.bonus > 0 ? `+${Math.round(s.bonus * 100)}% company bonus` : '');
    this.bonus.style.display = s.bonus > 0 ? '' : 'none';
    this.safe.style.display = s.safe ? '' : 'none';
    this.tick();
  }

  /** server clock minus local clock (ms), from /api/season */
  setSkew(ms: number): void {
    this.skew = ms;
  }

  private tick(): void {
    if (!this.resetAt) return;
    const left = this.resetAt - (Date.now() + this.skew);
    setText(this.clock, `ends in ${fmtClock(left)}`);
    this.root.classList.toggle('soon', left < 300_000);
  }
}

/** Rankings window: today's top 10, company standings, own stats, yesterday's champions. */
export class RankWindow {
  readonly win: DOWindow;
  private tabs: HTMLDivElement[] = [];
  private page: HTMLDivElement;
  private tab = 0;
  private top: TopMsg | null = null;
  private you: YouMsg | null = null;
  private sig = '';

  constructor(private readonly myName: () => string) {
    this.win = new DOWindow({ id: 'win-rank', title: 'Round ranking', icon: 'rankings', w: 330, anchor: 'tr', x: 8, y: 236, open: false, cls: 'win-rank' });
    const head = el('div', 'rk-tabs', undefined, this.win.body);
    ['This round', 'Companies', 'My stats', 'Last round'].forEach((t, i) => {
      const b = el('div', `rk-tab${i === 0 ? ' on' : ''}`, t, head);
      b.addEventListener('click', () => { this.tab = i; this.tabs.forEach((x, j) => x.classList.toggle('on', j === i)); this.render(true); });
      this.tabs.push(b);
    });
    this.page = el('div', 'rk-page', '', this.win.body);
    this.render(true);
  }

  get pilots(): number {
    return this.top?.pilots ?? 0;
  }

  setTop(t: TopMsg): void {
    this.top = t;
    this.render();
  }

  setYou(y: YouMsg): void {
    this.you = y;
    if (this.tab === 2) this.render();
  }

  private render(force = false): void {
    if (!this.win.visible && !force) return;
    const sig = JSON.stringify([this.tab, this.top, this.tab === 2 ? [this.you?.exp, this.you?.honor, this.you?.credits, this.you?.uridium, this.you?.season?.pilot, this.you?.level] : 0]);
    if (sig === this.sig && !force) return;
    this.sig = sig;
    const t = this.top;
    let h = '';
    if (this.tab === 0) {
      if (!t?.rows.length) h = '<div class="hint">No pilots yet this round. Be the first!</div>';
      else {
        h = '<table class="rk-table"><tr><th>#</th><th>Pilot</th><th>Lvl</th><th>EP</th><th>Kills</th><th>PvP</th></tr>';
        t.rows.forEach((r, i) => { h += this.row(i + 1, r); });
        h += '</table>';
        if (t.rank > t.rows.length) h += `<div class="rk-me">You are #${t.rank} of ${t.pilots}</div>`;
      }
    } else if (this.tab === 1) {
      const fs = Object.entries(t?.factions ?? {}).sort((a, b) => b[1].ep - a[1].ep);
      h = '<div class="hint">Total EP of every pilot this round. The company with the fewest pilots earns bonus rewards.</div>';
      for (const [f, r] of fs) {
        h += `<div class="rk-fac" style="--fc:${fcol(f)}"><img src="${ui(`win/faction_logo_small_${f}`)}" draggable="false"><b>${fname(f)}</b>` +
          `<span>${r.pilots} pilot${r.pilots === 1 ? '' : 's'} · ${r.online} online</span><span class="rk-ep">${fmtBig(r.ep)} EP</span>` +
          `${r.bonus > 0 ? `<i>+${Math.round(r.bonus * 100)}% bonus</i>` : ''}</div>`;
      }
    } else if (this.tab === 2) {
      const y = this.you;
      const p = y?.season?.pilot;
      if (!y || !p) h = '<div class="hint">No data yet</div>';
      else {
        const kd = p.deaths ? (p.pvpKills / p.deaths).toFixed(2) : String(p.pvpKills);
        const kv = (k: string, v: string) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`;
        h = kv('Rank today', y.season!.rank ? `#${y.season!.rank} of ${t?.pilots ?? '?'}` : '-') + kv('Level', String(y.level)) +
          kv('Experience', fmt(y.exp)) + kv('Honor', fmt(y.honor)) + kv('Credits', fmtBig(y.credits)) + kv('Uridium', fmtBig(y.uridium)) +
          kv('Aliens destroyed', fmt(p.npcKills)) + kv('Pilots destroyed', fmt(p.pvpKills)) + kv('Deaths', fmt(p.deaths)) + kv('PvP K/D', kd) +
          kv('Credits earned', fmtBig(p.earnedC)) + kv('Uridium earned', fmtBig(p.earnedU)) +
          kv('Biggest kill', p.bestKill ? esc(p.bestKill) : '-') + kv('Time online', fmtClock(p.online * 1000).slice(0, 5));
      }
    } else {
      const c = t?.champions ?? [];
      h = c.length
        ? `<table class="rk-table"><tr><th>#</th><th>Pilot</th><th>Lvl</th><th>EP</th><th>Kills</th><th>PvP</th></tr>${c.map((r, i) => this.row(i + 1, r)).join('')}</table>`
        : '<div class="hint">No winners recorded yet. Next round it could be you.</div>';
    }
    this.page.innerHTML = h;
  }

  private row(i: number, r: TopRow): string {
    const me = r.n === this.myName();
    const medal = i <= 3 ? ['🥇', '🥈', '🥉'][i - 1] : String(i);
    return `<tr class="${me ? 'me' : ''}"><td>${medal}</td><td><i class="dot${r.on ? ' on' : ''}"></i><span style="color:${fcol(r.f)}">${esc(r.n)}</span>${r.m ? `<small class="tb-map">${esc(r.m)}</small>` : ''}</td>` +
      `<td>${r.lvl}</td><td>${fmtBig(r.ep)}</td><td>${fmt(r.k)}</td><td>${fmt(r.pk)}</td></tr>`;
  }
}

function setText(e: HTMLElement, v: string): void {
  if (e.textContent !== v) e.textContent = v;
}

/** Starblast-style always-visible top 5 (+ your own line). */
export class MiniBoard {
  private root: HTMLDivElement;
  private sig = '';

  constructor(parent: HTMLElement, onClick: () => void, private readonly myName: () => string) {
    this.root = el('div', 'mini-board', '', parent);
    this.root.title = 'Round ranking - click for details';
    this.root.addEventListener('click', onClick);
  }

  update(t: TopMsg): void {
    const me = this.myName();
    const sig = JSON.stringify([t.rows.slice(0, 5), t.rank, me]);
    if (sig === this.sig) return;
    this.sig = sig;
    let h = '';
    t.rows.slice(0, 5).forEach((r, i) => {
      h += `<div class="${r.n === me ? 'me' : ''}"><span>${i + 1}.</span><b style="color:${fcol(r.f)}">${esc(r.n)}</b>${r.m ? `<small class="tb-map">${esc(r.m)}</small>` : ''}<em>${fmtBig(r.ep)}</em></div>`;
    });
    if (t.rank > 5) h += `<div class="me"><span>${t.rank}.</span><b>${esc(me)}</b><em>${fmtBig(t.rows.find((r) => r.n === me)?.ep ?? 0)}</em></div>`;
    this.root.innerHTML = h || '<div class="hint">No pilots yet</div>';
  }
}

/** Big centred announcement (level up, round over...). */
export function toast(text: string, sub = ''): void {
  const host = document.getElementById('hud') ?? document.body;
  const t = el('div', 'big-toast', `<b>${esc(text)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}`, host);
  window.setTimeout(() => t.classList.add('out'), 1800);
  window.setTimeout(() => t.remove(), 2500);
}

/** Final standings when a round ends. */
export function roundEndHtml(m: { rows: TopRow[]; rank: number; pilots: number; ep: number; company?: string | null; scores?: Record<string, number> }, me: string, myFaction: string): string {
  const place = m.rank ? `You finished <b>#${m.rank}</b> of ${m.pilots} with <b>${fmtBig(m.ep)} EP</b>.` : 'You did not score this round.';
  const sc = Object.entries(m.scores ?? {}).sort((a, b) => b[1] - a[1]).map(([f, v]) => `<b style="color:${fcol(f)}">${fname(f)}</b> ${Math.floor(v)}`).join(' · ');
  const comp = m.company
    ? `<div class="re-company" style="color:${fcol(m.company)}">${fname(m.company)} WINS THE ROUND${m.company === myFaction ? ' - your company!' : ''}</div><div class="hint">Beacon points: ${sc}. The winners get bonus rewards next round.</div>`
    : '<div class="hint">No company held enough beacons to win this round.</div>';
  let h = `${comp}<div class="re-place">${place}</div><table class="rk-table">`;
  m.rows.forEach((r, i) => {
    h += `<tr class="${r.n === me ? 'me' : ''}"><td>${i < 3 ? ['🥇', '🥈', '🥉'][i] : i + 1}</td><td style="color:${fcol(r.f)}">${esc(r.n)}</td><td>lvl ${r.lvl}</td><td>${fmtBig(r.ep)} EP</td></tr>`;
  });
  return `${h}</table><div class="hint">A new round starts now - everyone is back in a Phoenix.</div>`;
}
