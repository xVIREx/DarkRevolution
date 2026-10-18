import type { Actions } from './actions';
import { EntityManager } from './entities';
import { World } from './world';
import { isTyping } from './hud/dom';
import { activateSlot } from './hud/ammo';

export interface InputHost {
  actions: Actions;
  ammoIds: string[];
  hangarOpen(): boolean;
  closeHangar(): void;
  focusChat(): void;
  modalOpen(): boolean;
  toggleMute(): void;
}

const DOUBLE_CLICK_MS = 350;
const MOVE_REPEAT_MS = 110;

/** DarkOrbit-style mouse and keyboard controls. */
export class Input {
  private holding = false;
  private mouseX = 0;
  private mouseY = 0;
  private lastMoveSent = 0;
  private lastClickId: string | null = null;
  private lastClickAt = 0;

  constructor(private readonly world: World, private readonly ents: EntityManager, private readonly host: InputHost) {
    const cv = world.renderer.domElement;
    cv.addEventListener('mousedown', (e) => this.onDown(e));
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.holding = false;
    });
    window.addEventListener('mousemove', (e) => {
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
    });
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const d = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
      world.zoomBy(Math.exp(-d * 0.0012));
    }, { passive: false });
    window.addEventListener('keydown', (e) => this.onKey(e), true);
    window.addEventListener('blur', () => { this.holding = false; });
  }

  private onDown(e: MouseEvent): void {
    if (e.button !== 0 || this.host.modalOpen()) return;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const p = this.world.screenToWorld(e.clientX, e.clientY);
    const hit = this.ents.pick(p.x, p.y, this.world.zoom);
    const a = this.host.actions;
    const now = performance.now();
    if (hit) {
      const id = String(hit.snap.id);
      const dbl = this.lastClickId === id && now - this.lastClickAt < DOUBLE_CLICK_MS;
      if (this.ents.selectedId !== id) a.select(hit.snap.id);
      if (dbl) a.startAttack(); // DO: double-click = select + attack
      else if (e.ctrlKey) a.toggleAttack();
      this.lastClickId = dbl ? null : id;
      this.lastClickAt = now;
      return;
    }
    this.lastClickId = null;
    this.holding = true;
    this.mouseX = e.clientX;
    this.mouseY = e.clientY;
    this.sendMove(now, true);
  }

  private sendMove(now: number, force = false): void {
    if (!force && now - this.lastMoveSent < MOVE_REPEAT_MS) return;
    this.lastMoveSent = now;
    const p = this.world.screenToWorld(this.mouseX, this.mouseY);
    const m = this.world.map;
    const x = m ? Math.max(0, Math.min(m.w, p.x)) : p.x;
    const y = m ? Math.max(0, Math.min(m.h, p.y)) : p.y;
    this.host.actions.moveTo(x, y);
  }

  /** Call every frame: keeps steering while the left button is held. */
  update(now: number): void {
    if (this.holding) this.sendMove(now);
  }

  private onKey(e: KeyboardEvent): void {
    const a = this.host.actions;
    if (isTyping()) return; // chat / search inputs handle their own keys
    // never let a focused HUD button/checkbox/slider eat game keys (SPACE would "click" it)
    const ae = document.activeElement as HTMLElement | null;
    if (ae && ae !== document.body && /^(BUTTON|A)$/.test(ae.tagName)) ae.blur();
    if (e.key === 'Escape') {
      if (this.host.hangarOpen()) this.host.closeHangar();
      else a.select(null);
      return;
    }
    if (e.key === 'Control') {
      if (!e.repeat) a.toggleAttack();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const code = e.code;
    const dm = /^(?:Digit|Numpad)(\d)$/.exec(code);
    if (dm) {
      e.preventDefault();
      if (!e.repeat) activateSlot((Number(dm[1]) + 9) % 10); // 1..9 -> 0..8, 0 -> 9
      return;
    }
    switch (code) {
      case 'Space':
        e.preventDefault();
        if (!e.repeat) a.fireRocket();
        break;
      case 'KeyH':
        e.preventDefault();
        if (!e.repeat) a.toggleHangar();
        break;
      case 'KeyM':
        if (!e.repeat) this.host.toggleMute();
        break;
      case 'KeyJ':
        if (!e.repeat) a.jump();
        break;
      case 'KeyG':
        if (!e.repeat) a.toggleWarp();
        break;
      case 'KeyC':
        if (!e.repeat) a.switchConfig();
        break;
      case 'Enter':
        e.preventDefault();
        this.host.focusChat();
        break;
    }
  }
}
