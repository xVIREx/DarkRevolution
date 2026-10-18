// Phone/tablet support: device detection and the on-screen action buttons that stand in
// for the keyboard shortcuts (CTRL attack, SPACE rocket, J jump).
import type { Actions } from './actions';
import { el } from './hud/dom';

/** Primary input is a finger (phones, tablets). */
export const IS_TOUCH = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
if (IS_TOUCH) document.documentElement.classList.add('touch');

/** Windows that start minimized on touch devices (they cover most of a phone screen). */
export const TOUCH_CLOSED_WINDOWS = new Set(['win-user', 'win-ship', 'win-log', 'win-chat']);

export class TouchControls {
  private readonly atk: HTMLButtonElement;

  constructor(private readonly actions: Actions) {
    const root = el('div', 'touch-btns', undefined, document.getElementById('hud') ?? document.body);
    const btn = (label: string, cls: string, fn: () => void): HTMLButtonElement => {
      const b = el('button', `touch-btn ${cls}`, label, root);
      // pointerdown, not click: no 300ms delay, and it never steals focus from the canvas
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
      return b;
    };
    btn('JUMP', 'jump', () => actions.jump());
    btn('ROCKET', 'rocket', () => actions.fireRocket());
    this.atk = btn('ATTACK', 'attack', () => actions.toggleAttack());
  }

  /** Call every frame: lights the attack button while lasers are firing. */
  update(): void {
    this.atk.classList.toggle('on', this.actions.isAttacking());
  }
}
