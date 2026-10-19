import type { Actions, EquipMsg, EquipYou, GameState } from './actions';
import { Assets } from './assets';
import { EntityManager } from './entities';
import { Effects } from './effects';
import { Hangar } from './hangar';
import { Input } from './input';
import { Net } from './net';
import { World } from './world';
import { Hud } from './hud/hud';
import { AmmoBar } from './hud/ammo';
import { Minimap } from './hud/minimap';
import { LogWindow } from './hud/log';
import { ChatBox } from './hud/chat';
import { Dialog } from './hud/dialogs';
import { esc } from './hud/dom';
import { VolumePanel } from './hud/volume';
import { WarpWindow } from './hud/warp';
import { RankWindow, SeasonBar } from './hud/season';
import { AudioSystem } from './audio';
import type { EntId, EntSnap, Faction, MapDef, ServerMsg, YouMsg } from './types';
import { IS_TOUCH, TouchControls } from './touch';

const OPTIMISTIC_MS = 600;

export class Game implements Actions {
  readonly world: World;
  readonly ents: EntityManager;
  readonly effects: Effects;
  private hud: Hud;
  private ammoBar: AmmoBar;
  private minimap: Minimap;
  private log: LogWindow;
  private chatBox: ChatBox;
  private hangar: Hangar;
  private warpWin: WarpWindow | null = null;
  private seasonBar: SeasonBar | null = null;
  private rankWin: RankWindow | null = null;
  private input: Input;
  private touch: TouchControls | null = null;
  private respawn: Dialog;
  private lost: Dialog;

  private you: YouMsg | null = null;
  private map: MapDef | null = null;
  private ammo = 'x1';
  private ammoSetAt = 0;
  private rocket = 'r310';
  private rocketReadyAt = 0;
  private attackLocal: { on: boolean; at: number } | null = null;
  private lastServerTg: string | null | undefined = undefined;
  private snapCamera = true;
  private lastFrame = performance.now();
  private dead = false;
  private hadMap = false;
  private lastWarn = 0;
  private lastLevel: number | null = null;

  constructor(assets: Assets, private readonly audio: AudioSystem, private readonly net: Net, private readonly name: string, private faction: Faction,
    private readonly season: { token: string; skew: number } | null = null) {
    const container = document.getElementById('app') ?? document.body;
    this.world = new World(assets, container);
    this.ents = new EntityManager(assets, this.world.entityLayer);
    this.ents.myFaction = faction;
    this.world.attachEntities(this.ents);
    this.effects = new Effects(assets, this.world, this.ents);
    this.rocket = assets.lasers.rockets[0]?.id ?? 'r310';
    this.ammo = assets.lasers.ammo[0]?.id ?? 'x1';

    this.hud = new Hud(this);
    new VolumePanel(this.hud.menu, audio);
    this.ammoBar = new AmmoBar(this.hud.root, assets.lasers.ammo, assets.lasers.rockets, this);
    this.minimap = new Minimap(this.hud.root, assets, this);
    this.chatBox = new ChatBox(this.hud.root, (t) => this.chat(t));
    this.log = new LogWindow(this.hud.root);
    this.hangar = new Hangar(assets, this, !!season);
    if (season) {
      this.rankWin = new RankWindow(() => this.ents.me()?.snap.n ?? this.name);
      this.seasonBar = new SeasonBar(this.hud.root, () => { this.rankWin!.win.open(); this.rankWin!.win.front(); });
      this.seasonBar.setSkew(season.skew);
      this.hud.rightMenu.add({ icon: 'rankings', title: 'Daily ranking', win: 'win-rank' });
      this.hud.rightMenu.add({ icon: 'shop', title: 'Shop [H]', onClick: () => this.hangar.show('Shop'), isOpen: () => false });
    } else {
      this.warpWin = new WarpWindow(this);
      this.hud.rightMenu.add({ icon: 'spacemap', title: 'Jump CPU [G]', win: 'win-warp' });
    }
    this.hud.setShipNames(this.hangar.shipNameMap());
    this.respawn = new Dialog('Ship destroyed', 'Repair & respawn', () => this.revive());
    this.lost = new Dialog('Connection lost', 'Reconnect', () => this.reconnect());

    this.input = new Input(this.world, this.ents, {
      actions: this,
      ammoIds: assets.lasers.ammo.map((a) => a.id),
      hangarOpen: () => this.hangar.visible,
      closeHangar: () => this.hangar.hide(),
      focusChat: () => this.chatBox.focus(),
      toggleMute: () => audio.toggleMute(),
      modalOpen: () => this.hangar.visible || this.respawn.visible || this.lost.visible,
    });

    net.on((m) => this.onMsg(m));
    net.onClose = () => this.lost.show('The connection to the server was closed.');
    if (!assets.manifestOk) this.log.add('assets/manifest.json not found - using placeholders', true);
    if (!assets.shipsOk) this.log.add('data/ships.json not found - hangar uses manifest sheets', true);
    this.log.add(IS_TOUCH
      ? 'Welcome, pilot! Hold to fly, pinch to zoom, tap a ship to select it, tap again to attack.'
      : 'Welcome, pilot! Click to fly, double-click/CTRL to attack, H for hangar & shop, J to jump through portals.', true);
    if (IS_TOUCH) this.touch = new TouchControls(this);

    requestAnimationFrame((t) => this.frame(t));
  }

  // ---------------- network ----------------
  private onMsg(m: ServerMsg): void {
    const now = performance.now();
    switch (m.t) {
      case 'welcome':
        this.ents.myId = String(m.id);
        break;
      case 'map':
        this.setMap(m.map);
        break;
      case 'state':
        this.ents.applyState(m.tick, Array.isArray(m.ents) ? m.ents : [], now);
        this.reconcile();
        break;
      case 'you': {
        const { t: _t, ...y } = m;
        void _t;
        this.you = y;
        if (this.lastLevel !== null && y.level > this.lastLevel) {
          this.audio.play('levelup');
          this.log.add(`Level up! You are now level ${y.level}`, true);
        }
        this.lastLevel = y.level;
        if (y.id !== undefined && y.id !== null) this.ents.myId = String(y.id);
        if (y.ammo && now - this.ammoSetAt > OPTIMISTIC_MS) this.ammo = y.ammo;
        if (y.rocket) this.rocket = y.rocket;
        if (y.dead === false && this.dead) this.hideDead();
        if (y.faction && y.faction !== this.faction && (y.faction === 'mmo' || y.faction === 'eic' || y.faction === 'vru')) {
          this.faction = y.faction;
          this.ents.myFaction = y.faction;
        }
        if (y.season) {
          this.seasonBar?.update(y.season, this.rankWin?.pilots ?? 0);
          this.rankWin?.setYou(y);
        }
        this.hangar.setYou(y);
        break;
      }
      case 'shot':
        this.onShot(m, now);
        break;
      case 'boom': {
        const k = String(m.id);
        const bv = this.ents.get(k);
        const big = !bv || bv.snap.k === 'p' || bv.radius > 70;
        this.effects.explosion(m.x, m.y, now, big);
        this.audio.play(big ? 'explosion_big' : 'explosion_small', m.x, m.y);
        if (k !== this.ents.myId) this.ents.remove(k);
        if (this.ents.selectedId === k) this.ents.selectedId = null;
        break;
      }
      case 'dead':
        this.dead = true;
        this.respawn.show(`You were destroyed by <b>${esc(m.by || 'unknown')}</b>.<br><span class="hint">${this.season
          ? 'Repairs are free - you keep your ship, gear and credits.'
          : 'You lose nothing - resources are infinite.'}</span>`);
        break;
      case 'log':
        this.log.add(m.text);
        break;
      case 'chat':
        this.chatBox.add(m.from, m.text);
        if (m.from === 'SEASON') this.log.add(m.text, true);
        break;
      case 'top': {
        const { t: _t, ...top } = m;
        void _t;
        this.rankWin?.setTop(top);
        if (this.you?.season) this.seasonBar?.update(this.you.season, top.pilots);
        break;
      }
    }
  }

  private setMap(map: MapDef): void {
    const changed = this.map?.id !== map.id;
    this.map = map;
    this.world.setMap(map);
    this.ents.clear();
    this.effects.clear();
    this.snapCamera = true;
    this.lastServerTg = undefined;
    if (changed) this.log.add(`Entered map ${map.name}`, true);
    if (changed && this.hadMap) this.audio.play('jump_done');
    this.hadMap = true;
    this.audio.playMapMusic(map.id);
  }

  private reconcile(): void {
    const me = this.ents.me();
    if (!me) return;
    const tg = me.snap.tg === null || me.snap.tg === undefined ? null : String(me.snap.tg);
    if (tg !== this.lastServerTg) {
      // server changed our target (e.g. target died or select acknowledged)
      if (this.lastServerTg !== undefined || tg !== null) this.ents.selectedId = tg;
      this.lastServerTg = tg;
    }
    if (this.ents.selectedId && !this.ents.views.has(this.ents.selectedId)) this.ents.selectedId = null;
    if (this.dead && me.snap.hp > 0 && this.you?.dead !== true) {
      // respawned
    }
  }

  private onShot(m: Extract<ServerMsg, { t: 'shot' }>, now: number): void {
    const hit = () => {
      const tv = this.ents.get(m.to);
      if (!tv) return;
      const t = performance.now();
      if (m.miss) {
        this.effects.damage(tv.x, tv.y - tv.halfH * 0.3, 'MISS', 'miss', t);
        return;
      }
      const shd = Math.max(0, Math.round(m.shd || 0));
      const hp = Math.max(0, Math.round((m.dmg || 0) - shd));
      if (m.ammo === 'sab') {
        if (shd > 0 || m.dmg > 0) this.effects.damage(tv.x, tv.y - tv.halfH * 0.3, String(shd || Math.round(m.dmg)), 'sh', t);
        return;
      }
      if (hp > 0) this.effects.damage(tv.x, tv.y - tv.halfH * 0.3, String(hp), 'hp', t, shd > 0 ? -22 : 0);
      if (shd > 0) this.effects.damage(tv.x, tv.y - tv.halfH * 0.3, String(shd), 'sh', t, hp > 0 ? 22 : 0);
      if (hp === 0 && shd === 0) this.effects.damage(tv.x, tv.y - tv.halfH * 0.3, '0', 'miss', t);
    };
    const fv = this.ents.get(m.from);
    if (fv) this.audio.play(m.kind === 'rocket' ? 'rocket' : `laser_${m.ammo}`, fv.x, fv.y);
    const hitWithSound = () => {
      hit();
      const tv = this.ents.get(m.to);
      if (tv && !m.miss) this.audio.play(m.kind === 'rocket' ? 'rocket_hit' : 'hit', tv.x, tv.y, m.kind === 'rocket' ? 1 : 0.7);
    };
    const shieldHit = (m.shd || 0) > 0;
    if (m.kind === 'rocket') this.effects.rocket(m.from, m.to, m.ammo, hitWithSound, now, shieldHit);
    else this.effects.laser(m.from, m.to, m.ammo, hitWithSound, now, shieldHit);
  }

  reconnect(): void {
    this.lost.hide();
    this.net.onOpen = () => this.net.send({ t: 'login', name: this.name, faction: this.faction, token: this.season?.token });
    this.net.connect();
  }

  // ---------------- actions ----------------
  moveTo(x: number, y: number): void {
    this.net.send({ t: 'move', x: Math.round(x), y: Math.round(y) });
  }

  select(id: EntId | null): void {
    const k = EntityManager.key(id);
    if (k === null && this.attacking()) this.setAttack(false);
    if (k !== null && k !== this.ents.selectedId) this.audio.play('select');
    this.ents.selectedId = k;
    this.net.send({ t: 'select', id });
  }

  private attacking(): boolean {
    const me = this.ents.me();
    if (this.attackLocal && performance.now() - this.attackLocal.at < OPTIMISTIC_MS) return this.attackLocal.on;
    return !!me?.snap.atk;
  }

  private setAttack(on: boolean): void {
    this.attackLocal = { on, at: performance.now() };
    this.net.send({ t: 'attack', on });
  }

  toggleAttack(): void {
    if (!this.ents.selectedId) {
      this.log.add('No target selected', true);
      return;
    }
    this.setAttack(!this.attacking());
  }

  // --- UI agent: DO action bar / equipment hooks (see actions.ts) ---
  startAttack(): void {
    if (!this.ents.selectedId) {
      this.log.add('No target selected', true);
      return;
    }
    if (!this.attacking()) this.setAttack(true);
  }

  isAttacking(): boolean {
    return this.attacking();
  }

  equip(m: EquipMsg): void {
    this.net.send({ t: 'equip', ...m } as unknown as Parameters<Net['send']>[0]);
  }

  sendRaw(msg: { t: string; [k: string]: unknown }): void {
    this.net.send(msg as unknown as Parameters<Net['send']>[0]);
  }

  switchConfig(n?: 1 | 2): void {
    const cur = (this.you as (YouMsg & EquipYou) | null)?.cfg ?? 1;
    this.net.send({ t: 'cfg', n: n ?? (cur === 1 ? 2 : 1) } as unknown as Parameters<Net['send']>[0]);
  }

  setAmmo(id: string): void {
    this.ammo = id;
    this.ammoSetAt = performance.now();
    this.net.send({ t: 'ammo', id });
  }

  setRocket(id: string): void {
    this.rocket = id;
  }

  fireRocket(): void {
    const now = performance.now();
    if (!this.ents.selectedId) {
      this.log.add('No target selected', true);
      return;
    }
    if (now < this.rocketReadyAt) {
      this.audio.play('cooldown');
      return;
    }
    this.rocketReadyAt = now + 1000;
    this.net.send({ t: 'rocket', id: this.rocket });
  }

  jump(): void {
    const me = this.ents.me();
    if (me) {
      const p = this.world.nearestPortal(me.x, me.y);
      if (!p || p.d > 500) {
        this.log.add('No portal in range (fly within 500 units of a portal)', true);
        this.audio.play('out_of_range');
      } else this.audio.play('jump');
    }
    this.net.send({ t: 'jump' });
  }

  warp(mapId: number): void {
    if (this.map?.id === mapId) return;
    this.audio.play('jump');
    this.net.send({ t: 'warp', map: mapId });
  }

  toggleWarp(): void {
    if (this.warpWin) this.warpWin.toggle();
    else this.log.add('The Jump CPU is disabled in the daily season - fly through the portals [J]', true);
  }

  revive(): void {
    this.hideDead();
    this.net.send({ t: 'revive' });
  }

  private hideDead(): void {
    this.dead = false;
    this.respawn.hide();
  }

  chat(text: string): void {
    this.net.send({ t: 'chat', text });
  }

  toggleHangar(): void {
    this.hangar.toggle();
  }

  setShip(ship: string, design?: string): void {
    this.audio.play('click');
    this.net.send(design ? { t: 'ship', ship, design } : { t: 'ship', ship });
  }

  setConfig(speedGens: number): void {
    this.net.send({ t: 'config', speedGens });
  }

  setCheat(god: boolean, dmgMult: number): void {
    this.net.send({ t: 'cheat', god, dmgMult });
  }

  // ---------------- frame ----------------
  private state(): GameState {
    const me = this.ents.me();
    const tv = this.ents.selectedId ? this.ents.views.get(this.ents.selectedId) : undefined;
    const ents = this.ents.views;
    return {
      name: this.name,
      faction: this.faction,
      you: this.you,
      map: this.map,
      me: me ? { ...me.snap, x: me.x, y: me.y } : null,
      target: tv ? { ...tv.snap, x: tv.x, y: tv.y } as EntSnap : null,
      attacking: this.attacking(),
      ammo: this.ammo,
      rocket: this.rocket,
      rocketReadyAt: this.rocketReadyAt,
      ents: (function* () { for (const v of ents.values()) yield { snap: v.snap, x: v.x, y: v.y }; })(),
      myId: this.ents.myId,
      selectedId: this.ents.selectedId,
    };
  }

  private frame(t: number): void {
    requestAnimationFrame((tt) => this.frame(tt));
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    void t;
    try {
      this.input.update(now);
      this.touch?.update();
      this.ents.attacking = this.attacking();
      this.ents.update(now, this.world.zoom);
      const me = this.ents.me();
      if (me) {
        this.world.follow(me.x, me.y, dt, this.snapCamera);
        this.audio.listenerX = me.x;
        this.audio.listenerY = me.y;
        let underFire = this.ents.attacking;
        if (!underFire) for (const v of this.ents.views.values()) if (v.snap.atk && String(v.snap.tg) === this.ents.myId) { underFire = true; break; }
        this.audio.setCombat(underFire);
        if (me.snap.mhp > 0 && me.snap.hp > 0 && me.snap.hp / me.snap.mhp < 0.25 && now - this.lastWarn > 6000) {
          this.lastWarn = now;
          this.audio.play('warning');
        }
        this.snapCamera = false;
      } else if (this.map && this.snapCamera) {
        this.world.follow(this.map.w / 2, this.map.h / 2, dt, true);
      }
      this.world.update(dt, now);
      this.effects.update(now);
      this.world.render();
      const s = this.state();
      this.hud.update(s);
      this.ammoBar.update(s, now);
      this.minimap.update(s, now);
      this.warpWin?.update(s);
    } catch (e) {
      console.error('frame error', e);
    }
  }
}
