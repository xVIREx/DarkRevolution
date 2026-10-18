import { AudioSystem, type AudioSettings } from '../audio';
import { el } from './dom';
import { button, DOWindow, resetWindows, ui } from './ui';

export interface SettingToggle { label: string; get(): boolean; set(v: boolean): void }
const extraToggles: SettingToggle[] = [];
let addToggleImpl: ((t: SettingToggle) => void) | null = null;

/**
 * Hook for other modules (e.g. the 3D renderer's "3D / 2D" switch): adds a checkbox to the
 * Settings window. Safe to call before or after the HUD exists.
 */
export function addSettingsToggle(t: SettingToggle): void {
  if (addToggleImpl) addToggleImpl(t);
  else extraToggles.push(t);
}

/** DO "Settings" window: sound sliders, mute (M), extra toggles, reset window layout. */
export class VolumePanel {
  private sliders: Partial<Record<'master' | 'sfx' | 'music', HTMLInputElement>> = {};
  private mute: HTMLInputElement;
  private win: DOWindow;

  constructor(menu: HTMLElement, audio: AudioSystem) {
    this.win = new DOWindow({ id: 'win-settings', title: 'Settings', icon: 'settings', w: 260, anchor: 'tr', x: 8, y: 50, open: false, cls: 'win-settings' });
    const body = el('div', 'settings', undefined, this.win.body);
    el('div', 'sect', 'Sound', body);
    for (const [k, label] of [['master', 'Master'], ['sfx', 'Effects'], ['music', 'Music']] as const) {
      const row = el('label', 'kv', `<span>${label}</span>`, body);
      const s = el('input', 'doslider', undefined, row);
      s.type = 'range';
      s.min = '0';
      s.max = '100';
      s.tabIndex = -1;
      s.addEventListener('input', () => audio.set({ [k]: Number(s.value) / 100 } as Partial<AudioSettings>));
      s.addEventListener('change', () => s.blur());
      this.sliders[k] = s;
    }
    const ml = el('label', 'docheck', undefined, body);
    this.mute = el('input', undefined, undefined, ml);
    this.mute.type = 'checkbox';
    this.mute.tabIndex = -1;
    el('span', undefined, 'Mute all [M]', ml);
    this.mute.addEventListener('change', () => audio.set({ muted: this.mute.checked }));
    const extra = el('div', undefined, undefined, body);
    addToggleImpl = (t) => {
      if (!extra.childElementCount) el('div', 'sect', 'Graphics', extra);
      const l = el('label', 'docheck', undefined, extra);
      const c = el('input', undefined, undefined, l);
      c.type = 'checkbox';
      c.tabIndex = -1;
      c.checked = t.get();
      el('span', undefined, t.label, l);
      c.addEventListener('change', () => t.set(c.checked));
    };
    for (const t of extraToggles.splice(0)) addToggleImpl(t);
    el('div', 'sect', 'Interface', body);
    button('Reset window layout', body, 'blue', () => resetWindows());
    el('div', 'hint', 'Keys: 1-0 action bar · CTRL attack · SPACE rocket · J jump · C config · H hangar · ENTER chat', body);
    audio.onChange = (s) => this.sync(s);
    this.sync(audio.settings);
    // settings button in the top-right menu
    const b = el('div', 'domenu-btn', `<img draggable="false">`, menu);
    b.title = 'Settings';
    const img = b.querySelector('img')!;
    const paint = (hover = false) => { img.src = ui(`menu/settings_${this.win.visible ? 'select' : hover ? 'hover' : 'normal'}`); };
    b.addEventListener('mouseenter', () => paint(true));
    b.addEventListener('mouseleave', () => paint());
    b.addEventListener('click', () => { this.win.toggle(); paint(true); });
    this.win.onToggle = () => paint();
    paint();
  }

  private sync(s: AudioSettings): void {
    for (const k of ['master', 'sfx', 'music'] as const) {
      const sl = this.sliders[k];
      if (sl) sl.value = String(Math.round(s[k] * 100));
    }
    this.mute.checked = s.muted;
  }
}
