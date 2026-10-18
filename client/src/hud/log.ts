import { el, esc } from './dom';
import { DOWindow } from './ui';

/** DO "Log" window (UILog prefab): system and reward messages, resizable. */
export class LogWindow {
  private lines: HTMLDivElement;
  readonly win: DOWindow;
  constructor(_parent: HTMLElement) {
    this.win = new DOWindow({ id: 'win-log', title: 'Log', icon: 'log', w: 300, h: 150, anchor: 'tl', x: 8, y: 196, resizable: true, cls: 'win-log' });
    this.lines = el('div', 'lines', undefined, this.win.body);
  }

  add(text: string, sys = false): void {
    const t = new Date();
    const ts = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    el('div', sys ? 'sys' : undefined, `<i>${ts}</i> ${esc(text)}`, this.lines);
    while (this.lines.childElementCount > 150) this.lines.firstElementChild?.remove();
    this.lines.scrollTop = this.lines.scrollHeight;
  }
}
