import type { Actions } from './actions';
import { EntityManager } from './entities';
import { World } from './world';
import { isTyping } from './hud/dom';
import { activateSlot } from './hud/ammo';
import { IS_TOUCH } from './touch';

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
/** Extra pick tolerance (screen px) for fingers vs. the mouse. */
const PICK_SLACK_TOUCH = 34;

/** DarkOrbit-style mouse and keyboard controls, plus touch: hold to steer, pinch to zoom,
 *  tap a ship to select it and tap it again to attack. */
export class Input {
  private holding = false;
  private mouseX = 0;
  private mouseY = 0;
  private lastMoveSent = 0;
  private lastClickId: string | null = null;
  private lastClickAt = 0;
  /** Active touch points (for pinch) and the one steering the ship. */
  private touches = new Map<number, { x: number; y: number }>();
  private steerId: number | null = null;
  private pinchDist = 0;

  constructor(private readonly world: World, private readonly ents: EntityManager, private readonly host: InputHost) {
    const cv = world.renderer.domElement;
    cv.style.touchAction = 'none'; // no browser scroll/zoom gestures on the game view
    cv.addEventListener('pointerdown', (e) => this.onDown(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    window.addEventListener('pointercancel', (e) => this.onUp(e));
    window.addEventListener('pointermove', (e) => this.onMove(e));
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const d = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
      world.zoomBy(Math.exp(-d * 0.0012));
    }, { passive: false });
    window.addEventListener('keydown', (e) => this.onKey(e), true);
    window.addEventListener('blur', () => { this.holding = false; });
  }

  private onDown(e: PointerEvent): void {
    if (e.button !== 0 || this.host.modalOpen()) return;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const touch = e.pointerType !== 'mouse';
    if (touch) {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touches.size === 2) {
        // second finger: switch from steering to pinch-zoom
        this.holding = false;
        this.steerId = null;
        const [a, b] = [...this.touches.values()];
        this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      }
      if (this.touches.size > 1) return;
    }
    const p = this.world.screenToWorld(e.clientX, e.clientY);
    const hit = this.ents.pick(p.x, p.y, this.world.zoom, touch || IS_TOUCH ? PICK_SLACK_TOUCH : undefined);
    const a = this.host.actions;
    const now = performance.now();
    if (hit) {
      const id = String(hit.snap.id);
      // touch: tapping the already-selected ship attacks it (double-taps are unreliable)
      const dbl = (this.lastClickId === id && now - this.lastClickAt < DOUBLE_CLICK_MS) || (touch && this.ents.selectedId === id);
      if (this.ents.selectedId !== id) a.select(hit.snap.id);
      if (dbl) a.startAttack(); // DO: double-click = select + attack
      else if (e.ctrlKey) a.toggleAttack();
      this.lastClickId = dbl ? null : id;
      this.lastClickAt = now;
      return;
    }
    this.lastClickId = null;
    this.holding = true;
    if (touch) this.steerId = e.pointerId;
    this.mouseX = e.clientX;
    this.mouseY = e.clientY;
    this.sendMove(now, true);
  }

  private onMove(e: PointerEvent): void {
    if (e.pointerType === 'mouse') {
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
      return;
    }
    if (!this.touches.has(e.pointerId)) return;
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.touches.size === 2) {
      const [a, b] = [...this.touches.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinchDist > 0 && d > 0) this.world.zoomBy(d / this.pinchDist);
      this.pinchDist = d;
    } else if (e.pointerId === this.steerId) {
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
    }
  }

  private onUp(e: PointerEvent): void {
    if (e.pointerType === 'mouse') {
      if (e.button === 0) this.holding = false;
      return;
    }
    this.touches.delete(e.pointerId);
    if (e.pointerId === this.steerId) {
      this.holding = false;
      this.steerId = null;
    }
    if (this.touches.size < 2) this.pinchDist = 0;
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
