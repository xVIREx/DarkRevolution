import type { Actions, EquipYou, GameState } from '../actions';
import { el, esc, fmt } from './dom';
import { DOWindow, MenuBar, ui } from './ui';
import { loadItems } from './items';

/**
 * Modern DarkOrbit HUD shell: top-left / top-right feature menus, the User window
 * (UIUser prefab), the Ship window (UIShip prefab) and the target window.
 * `menu` is the top-right MenuBar root (other panels may append buttons to it).
 */
export class Hud {
  readonly root: HTMLDivElement;
  readonly menu: HTMLDivElement;
  readonly leftMenu: MenuBar;
  readonly rightMenu: MenuBar;
  private user: DOWindow;
  private ship: DOWindow;
  private tgtWin: DOWindow;
  private u: Record<string, HTMLElement> = {};
  private s: Record<string, { row: HTMLElement; fill: HTMLElement; txt: HTMLElement }> = {};
  private sInfo: Record<string, HTMLElement> = {};
  private tgt: { name: HTMLElement; hp: { fill: HTMLElement; txt: HTMLElement }; sh: { fill: HTMLElement; txt: HTMLElement }; info: HTMLElement; atk: HTMLElement };
  private cfgBtn: HTMLDivElement;
  private shipNames = new Map<string, string>();
  private barMode = true;

  constructor(actions: Actions) {
    this.root = el('div', undefined, undefined, document.body);
    this.root.id = 'hud';
    void loadItems();

    this.leftMenu = new MenuBar(this.root, 'menu-left', [
      { icon: 'user', title: 'User', win: 'win-user' },
      { icon: 'ship', title: 'Ship', win: 'win-ship' },
      { icon: 'log', title: 'Log', win: 'win-log' },
      { icon: 'chat', title: 'Chat', win: 'win-chat' },
      { icon: 'group', title: 'Target', win: 'win-target' },
    ]);
    this.rightMenu = new MenuBar(this.root, 'menu-right', [
      { icon: 'minimap', title: 'Mini map', win: 'win-minimap' },
      { icon: 'hangar', title: 'Hangar [H]', onClick: () => actions.toggleHangar(), isOpen: () => !!document.getElementById('hangar')?.classList.contains('show') },
      { icon: 'ship_warp', title: 'Jump [J]', onClick: () => actions.jump(), isOpen: () => false },
      { icon: 'fullscreen', title: 'Fullscreen', onClick: () => toggleFullscreen(), isOpen: () => !!document.fullscreenElement },
    ]);
    this.menu = this.rightMenu.root;

    // ---- User window (UIUser): id, exp, credits, level, uridium, honor
    this.user = new DOWindow({ id: 'win-user', title: 'User', icon: 'user', w: 290, x: 8, y: 50, cls: 'win-user' });
    const ub = el('div', 'kvgrid', undefined, this.user.body);
    for (const [k, icon] of [['name', 'id'], ['premium', ''], ['exp', 'shipInfoIcon_experience'], ['credits', 'shipInfoIcon_credits'],
      ['level', 'shipInfoIcon_level'], ['uridium', 'shipInfoIcon_uridium'], ['honor', 'shipInfoIcon_honor'], ['map', 'shipInfoIcon_jumpvoucher']] as const) {
      if (k === 'premium') { this.u[k] = el('div', 'kvi premium', 'PREMIUM', ub); continue; }
      const row = el('div', 'kvi', `<img src="${ui(`win/${icon}`)}" draggable="false"><span></span>`, ub);
      this.u[k] = row.querySelector('span')!;
    }

    // ---- Ship window (UIShip): hp, cargo, shield, speed, nanohull, config
    this.ship = new DOWindow({ id: 'win-ship', title: 'Ship', icon: 'ship', w: 256, x: 306, y: 50, cls: 'win-ship' });
    const sb = el('div', 'kvgrid', undefined, this.ship.body);
    const bar = (k: string, icon: string, color: string) => {
      const row = el('div', 'kvi barrow', `<img src="${ui(`win/${icon}`)}" draggable="false"><div class="dobar"><i style="background-image:url(${ui(`win/bar_${color}`)})"></i><span></span></div>`, sb);
      row.title = 'Click to toggle bar / number view';
      row.addEventListener('click', () => { this.barMode = !this.barMode; this.root.classList.toggle('nobars', !this.barMode); });
      this.s[k] = { row, fill: row.querySelector('i')!, txt: row.querySelector('span')! };
    };
    bar('hp', 'shipInfoIcon_hitpoints', 'green');
    bar('cargo', 'shipInfoIcon_cargo', 'yellow');
    bar('sh', 'shild_small', 'blue');
    const sp = el('div', 'kvi', `<img src="${ui('win/shipInfoIcon_speed')}" draggable="false"><span></span>`, sb);
    this.sInfo.speed = sp.querySelector('span')!;
    bar('nano', 'shipInfoIcon_nanohull', 'red');
    const cf = el('div', 'kvi cfgrow', `<img src="${ui('win/shipInfoIcon_configuration')}" draggable="false"><span></span>`, sb);
    this.sInfo.cfg = cf.querySelector('span')!;
    this.cfgBtn = cf;
    cf.title = 'Switch configuration [C]';
    cf.addEventListener('click', () => actions.switchConfig());
    this.sInfo.shipName = el('div', 'shipname', '', this.ship.body);

    // ---- Target window
    this.tgtWin = new DOWindow({ id: 'win-target', title: 'Target', icon: 'group', w: 230, anchor: 'tc', x: 0, y: 50, cls: 'win-target' });
    const tb = this.tgtWin.body;
    const tname = el('div', 'tname', '', tb);
    const mk = (icon: string, color: string) => {
      const r = el('div', 'kvi barrow', `<img src="${ui(`win/${icon}`)}" draggable="false"><div class="dobar"><i style="background-image:url(${ui(`win/bar_${color}`)})"></i><span></span></div>`, tb);
      return { fill: r.querySelector('i')! as HTMLElement, txt: r.querySelector('span')! as HTMLElement };
    };
    const thp = mk('shipInfoIcon_hitpoints', 'green');
    const tsh = mk('shild_small', 'blue');
    const info = el('div', 'tinfo', '', tb);
    const atk = el('div', 'tatk', '', tb);
    this.tgt = { name: tname, hp: thp, sh: tsh, info, atk };
    tb.addEventListener('dblclick', () => actions.startAttack());
  }

  setShipNames(m: Map<string, string>): void {
    this.shipNames = m;
  }

  update(s: GameState): void {
    const y = s.you as (GameState['you'] & EquipYou) | null;
    txt(this.u.name, s.me?.n ?? s.name);
    txt(this.u.exp, y ? fmt(y.exp) : '0');
    txt(this.u.credits, y ? fmt(y.credits) : '∞');
    txt(this.u.level, y ? String(y.level ?? 1) : '1');
    txt(this.u.uridium, y ? fmt(y.uridium) : '∞');
    txt(this.u.honor, y ? fmt(y.honor) : '0');
    txt(this.u.map, s.map ? `${s.map.name}  ${s.faction.toUpperCase()}` : '-');
    const tags = `${y?.god ? 'GOD ' : ''}${y && y.dmgMult !== 1 ? `DMG x${+y.dmgMult.toFixed(2)}` : ''}`;
    txt(this.u.premium, tags || 'PREMIUM');

    if (s.me) {
      setBar(this.s.hp, s.me.hp, s.me.mhp);
      setBar(this.s.sh, s.me.sh, s.me.msh);
    }
    setBar(this.s.cargo, 0, 0, '∞');
    setBar(this.s.nano, 0, 0, '0');
    txt(this.sInfo.speed, y ? String(Math.round(y.stats?.speed ?? y.speed)) : '-');
    const cd = Math.max(0, y?.cfgCd ?? 0);
    txt(this.sInfo.cfg, `Config ${y?.cfg ?? 1}${cd > 0.05 ? `  (${cd.toFixed(1)}s)` : ''}`);
    this.cfgBtn.classList.toggle('cooldown', cd > 0.05);
    const shipLabel = y ? this.shipNames.get(y.design || '') ?? this.shipNames.get(y.ship) ?? y.ship : '-';
    txt(this.sInfo.shipName, shipLabel);
    this.ship.setTitle(shipLabel && shipLabel !== '-' ? shipLabel : 'Ship');

    const t = s.target;
    this.tgtWin.root.classList.toggle('empty', !t);
    if (t) {
      txt(this.tgt.name, t.n);
      this.tgt.name.className = `tname ${t.k === 'n' ? 'npc' : t.f && t.f !== s.faction ? 'enemy' : 'ally'}`;
      setFill(this.tgt.hp, t.hp, t.mhp);
      setFill(this.tgt.sh, t.sh, t.msh);
      if (s.me) {
        const d = Math.hypot(t.x - s.me.x, t.y - s.me.y);
        txt(this.tgt.info, `Distance ${Math.round(d)}${d > 700 ? ' · out of range' : ''}`);
        this.tgt.info.classList.toggle('far', d > 700);
      }
      txt(this.tgt.atk, s.attacking ? 'ATTACKING' : 'CTRL / double-click to attack');
      this.tgt.atk.classList.toggle('on', s.attacking);
    } else {
      txt(this.tgt.name, 'No target');
      this.tgt.name.className = 'tname';
      setFill(this.tgt.hp, 0, 0);
      setFill(this.tgt.sh, 0, 0);
      txt(this.tgt.info, 'Click a ship to select it');
      txt(this.tgt.atk, '');
    }
  }
}

function toggleFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen().catch(() => undefined);
}

function txt(e: HTMLElement, v: string): void {
  if (e.textContent !== v) e.textContent = v;
}

function setFill(b: { fill: HTMLElement; txt: HTMLElement }, v: number, max: number, label?: string): void {
  const k = max > 0 ? Math.max(0, Math.min(1, v / max)) : 0;
  const w = `${(k * 100).toFixed(1)}%`;
  if (b.fill.style.width !== w) b.fill.style.width = w;
  txt(b.txt, label ?? (max > 0 ? `${fmt(v)}` : '0'));
}

function setBar(b: { fill: HTMLElement; txt: HTMLElement }, v: number, max: number, label?: string): void {
  setFill(b, v, max, label ?? (max > 0 ? fmt(v) : '0'));
  b.txt.title = max > 0 ? `${fmt(v)} / ${fmt(max)}` : '';
}

export { esc };
