// Group window (DO "Gruppe"): invite by name or the selected pilot, accept/decline invitations,
// members with HP/shield/map, leader kick / hand over lead, leave. Server: world/group.rs.
import type { Actions, GameState } from '../actions';
import type { GroupMsg } from '../types';
import { FACTION_COLORS } from '../types';
import { el, esc, fmt } from './dom';
import { button, DOWindow } from './ui';

export class GroupWindow {
  readonly win: DOWindow;
  private inviteBar: HTMLDivElement;
  private list: HTMLDivElement;
  private nameIn: HTMLInputElement;
  private targetBtn: HTMLButtonElement;
  private leaveBtn: HTMLButtonElement;
  private group: GroupMsg | null = null;
  private invite: { from: string; id: number; until: number } | null = null;
  private myId: string | null = null;
  private mapNames = new Map<number, string>();
  private sig = '';

  constructor(private readonly actions: Actions, private readonly state: () => GameState) {
    this.win = new DOWindow({ id: 'win-group', title: 'Group', icon: 'contacts', w: 250, anchor: 'tl', x: 8, y: 360, open: false, cls: 'win-group' });
    const b = this.win.body;
    this.inviteBar = el('div', 'gr-invite', '', b);
    this.list = el('div', 'gr-list', '', b);
    const row = el('div', 'gr-row', undefined, b);
    this.nameIn = el('input', undefined, undefined, row);
    this.nameIn.placeholder = 'Pilot name';
    this.nameIn.maxLength = 20;
    this.nameIn.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') this.inviteName();
    });
    button('Invite', row, 'blue', () => this.inviteName());
    const row2 = el('div', 'gr-row', undefined, b);
    this.targetBtn = button('Invite target', row2, 'blue', () => {
      const s = this.state();
      if (s.target?.k === 'p') this.actions.sendRaw({ t: 'group', action: 'invite', id: Number(s.target.id) });
    });
    this.leaveBtn = button('Leave group', row2, 'red', () => this.actions.sendRaw({ t: 'group', action: 'leave' }));
    el('div', 'hint', 'Up to 8 pilots. Members can\'t shoot each other and share alien rewards (members on the same map who fought in the last 20 s).', b);
    void fetch('/data/maps.json').then((r) => r.json()).then((ms: { id: number; name: string }[]) => {
      for (const m of ms) this.mapNames.set(m.id, m.name);
    }).catch(() => undefined);
    this.render();
  }

  get current(): GroupMsg | null {
    return this.group?.members.length ? this.group : null;
  }

  setGroup(g: GroupMsg): void {
    this.group = g;
    this.render();
  }

  onInvite(from: string, id: number): void {
    this.invite = { from, id, until: performance.now() + 60_000 };
    this.win.open();
    this.win.front();
    this.render();
  }

  update(s: GameState): void {
    this.myId = s.myId;
    const can = s.target?.k === 'p' && String(s.target.id) !== s.myId;
    if (this.targetBtn.disabled === can) this.targetBtn.disabled = !can;
    if (this.invite && performance.now() > this.invite.until) {
      this.invite = null;
      this.render();
    }
  }

  private inviteName(): void {
    const n = this.nameIn.value.trim();
    if (!n) return;
    this.actions.sendRaw({ t: 'group', action: 'invite', name: n });
    this.nameIn.value = '';
  }

  private answer(accept: boolean): void {
    this.actions.sendRaw({ t: 'group', action: accept ? 'accept' : 'decline' });
    this.invite = null;
    this.render();
  }

  private render(): void {
    const g = this.current;
    const sig = JSON.stringify([g, this.invite?.id, this.myId]);
    if (sig === this.sig) return;
    this.sig = sig;
    this.inviteBar.innerHTML = '';
    if (this.invite) {
      el('span', undefined, `<b>${esc(this.invite.from)}</b> invites you to a group`, this.inviteBar);
      button('Accept', this.inviteBar, 'green', () => this.answer(true));
      button('Decline', this.inviteBar, 'red', () => this.answer(false));
    }
    this.inviteBar.style.display = this.invite ? '' : 'none';
    this.leaveBtn.style.display = g ? '' : 'none';
    this.win.setTitle(g ? `Group (${g.members.length}/8)` : 'Group');
    this.list.innerHTML = '';
    if (!g) {
      el('div', 'hint', 'You are not in a group.', this.list);
      return;
    }
    const iLead = String(g.leader) === this.myId;
    for (const m of g.members) {
      const me = String(m.id) === this.myId;
      const r = el('div', `gr-m${me ? ' me' : ''}${m.dead ? ' dead' : ''}`, undefined, this.list);
      const map = this.mapNames.get(m.map) ?? String(m.map);
      el('div', 'gr-head',
        `${m.id === g.leader ? '<i title="Leader">★</i>' : ''}<b style="color:${FACTION_COLORS[m.f] ?? '#ccc'}">${esc(m.n)}</b>` +
        `<span>lvl ${m.lvl} · ${esc(map)}${m.active ? '' : ' · <em title="No share of group kills until they hit an alien">idle</em>'}</span>`, r);
      const bar = (v: number, max: number, cls: string) =>
        `<div class="gr-bar ${cls}"><i style="width:${max > 0 ? Math.max(0, Math.min(100, (v / max) * 100)).toFixed(0) : 0}%"></i><span>${fmt(v)}</span></div>`;
      el('div', 'gr-bars', bar(m.hp, m.mhp, 'hp') + bar(m.sh, m.msh, 'sh'), r);
      if (iLead && !me) {
        const ctl = el('div', 'gr-ctl', undefined, r);
        button('Lead', ctl, 'blue', () => this.actions.sendRaw({ t: 'group', action: 'lead', id: m.id }));
        button('Kick', ctl, 'red', () => this.actions.sendRaw({ t: 'group', action: 'kick', id: m.id }));
      }
    }
  }
}
